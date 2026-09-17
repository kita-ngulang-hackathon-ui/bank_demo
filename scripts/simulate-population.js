/** Drive a whole simulated customer population through the live bank_demo.
 *
 *   node scripts/simulate-population.js --users 120 --days 90
 *   node scripts/simulate-population.js --dry-run
 *
 * Unlike `simulate-network.js`, which fabricates event objects and posts them
 * straight to ADA, this script uses no shortcut: it signs each customer in over
 * HTTP and moves their money through the same endpoints the browser calls, so
 * every event is produced by the bank's own domain logic. Desktop customers go
 * through the two-step e-Secure confirmation; mobile customers use the direct
 * endpoints and the SDK transport. The server writes each resulting ADA event to
 * its capture file (ADA_TRANSPORT_MODE=capture), and this script turns that file
 * into the JSON array `python -m worker.main --events` reads.
 *
 * Why it backdates: ninety days of history driven live would otherwise carry
 * ninety days of identical timestamps, and every window ADA measures - recency,
 * 30/60/90-day trends, neighbour activity now versus thirty days ago - would
 * collapse to nothing. Each request carries `X-Demo-Occurred-At`, which the
 * server honours only when DEMO_ALLOW_BACKDATE is on.
 *
 * Deterministic: the same --seed produces the same population, the same
 * behaviour and the same planted patterns.
 */
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../server/src/config.js";
import { makeRandom, helpers } from "../server/src/lib/random.js";

// --------------------------------------------------------------------- flags

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const int = (name, fallback) => Number.parseInt(flag(name, String(fallback)), 10);

const OPTIONS = {
  users: int("users", 120),
  days: int("days", 90),
  seed: flag("seed", "bank_demo_population_v1"),
  baseUrl: (flag("base-url", "http://localhost:4000")).replace(/\/$/, ""),
  concurrency: int("concurrency", 8),
  pin: flag("pin", "123456"),
  out: flag("out", "out"),
  dryRun: args.includes("--dry-run"),
  keepCapture: args.includes("--keep-capture"),
};

const DAY_MS = 86_400_000;

/** The last 34 days are the observation window the planted dips live in.
 *  It has to exceed ADA's PIPELINE_ACTIVITY_WINDOW_DAYS (30): a user who went
 *  quiet 21 days ago still counts as active in the 30-day window, so the dip
 *  would not register. */
const QUIET_DAYS = 34;

// ---------------------------------------------------------------- http client

class Surface {
  constructor(baseUrl, surface) {
    this.base = `${baseUrl}/api/${surface}`;
    this.surface = surface;
    this.cookie = null;
  }

  async call(method, path, { body, occurredAt } = {}) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    if (occurredAt) headers["x-demo-occurred-at"] = occurredAt;

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const [pair] = raw.split(";");
      if (pair.includes("=") && !pair.endsWith("=")) this.cookie = pair;
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      const err = new Error(payload?.message ?? `${response.status} ${path}`);
      err.status = response.status;
      err.code = payload?.error ?? "HTTP_ERROR";
      throw err;
    }
    return payload;
  }
}

// --------------------------------------------------------------- the schedule

/** One customer's fixed disposition for the whole run. */
function profileFor(user, random) {
  const { between } = helpers(random);
  // Wealth decides how much they move; balance is the only honest proxy we have.
  const spendScale = Math.min(2.2, Math.max(0.4, user.balance / 9_000_000));
  return {
    // Desktop is the majority surface, as it is for retail internet banking.
    surface: random() < 0.6 ? "desktop" : "mobile",
    spendScale,
    activity: 0.55 + random() * 0.45,
    billDay: between(1, 5),
    billerIndex: Math.floor(random() * 4),
    pattern: "stable",
  };
}

/**
 * Plant the two dips ADA's graph stage is built to tell apart.
 *
 * MARKET_DRIVEN needs three things at once (graph_signal/pattern.py): the
 * user's own delta below -PATTERN_DIP_THRESHOLD, their cohort's MEDIAN delta
 * below -PATTERN_COHORT_DIP_THRESHOLD, and a negative external signal. Only
 * cohort-3 carries a negative COHORT signal in the canned feed (-0.62), so the
 * market dip has to be cohort-3, and it has to be cohort-wide for the median to
 * move.
 *
 * CIRCLE_SPECIFIC is the same local dip WITHOUT the cohort-wide collapse, so it
 * goes to part of a circle outside cohort-3: the quiet half drags their
 * neighbours' activity ratio down while the rest of the cohort carries on.
 */
function plantPatterns(users, profiles, random) {
  const marketCohort = "cohort-3";
  const byCircle = new Map();
  for (const user of users) {
    if (!byCircle.has(user.circle)) byCircle.set(user.circle, []);
    byCircle.get(user.circle).push(user);
  }

  // P2: everyone in the signalled cohort goes quiet together.
  for (const user of users) {
    if (user.attributes.cohort_key === marketCohort) {
      profiles.get(user.ref).pattern = "market_dip";
    }
  }

  // P1: half of two circles that are NOT in the signalled cohort.
  const candidates = [...byCircle.entries()]
    .filter(([, members]) => members.length >= 4
      && members.every((m) => m.attributes.cohort_key !== marketCohort))
    .map(([circle]) => circle)
    .sort();

  for (const circle of candidates.slice(0, 2)) {
    const members = byCircle.get(circle);
    for (const member of members.slice(0, Math.floor(members.length / 2))) {
      profiles.get(member.ref).pattern = "circle_dip";
    }
  }
  return { marketCohort, circleDipCircles: candidates.slice(0, 2) };
}

/** Is this customer transacting on this simulated day? */
function isQuiet(profile, daysAgo) {
  return profile.pattern !== "stable" && daysAgo < QUIET_DAYS;
}

// ------------------------------------------------------------------ behaviour

/** Every action a customer takes on one simulated day, in order. */
function planDay({ user, profile, peers, day, random }) {
  const { pick, between, roundTo } = helpers(random);
  const scale = profile.spendScale;
  const date = new Date(day.at);
  const weekday = date.getUTCDay();
  const dayOfMonth = date.getUTCDate();
  const actions = [];

  const at = (hour) => new Date(day.at + between(hour * 3600_000, (hour + 1) * 3600_000)).toISOString();

  // Payday. Funds the month ahead: the ledger rejects an overdraft, so without
  // income every customer would stop transacting halfway through the history.
  if (day.index === 0 || dayOfMonth === 25) {
    actions.push({
      kind: "topup",
      at: at(9),
      request: { amount: roundTo(12_000_000 * scale, 100_000), source: "payroll" },
    });
  }

  if (random() > profile.activity) return actions;

  // P2P inside the circle: the repeated counterparty edge the graph is built on.
  if (peers.length && random() < 0.5) {
    actions.push({
      kind: "transfer",
      at: at(between(8, 20)),
      request: {
        recipientRef: pick(peers).ref,
        amount: roundTo(between(25_000, 400_000) * scale, 5_000),
        note: "Transfer",
      },
    });
  }

  // Split bills cluster on Friday and Saturday nights.
  if (peers.length >= 2 && (weekday === 5 || weekday === 6) && random() < 0.35) {
    const participants = [pick(peers).ref, pick(peers).ref].filter((v, i, a) => a.indexOf(v) === i);
    actions.push({
      kind: "split",
      at: at(19),
      request: {
        title: pick(["Makan malam", "Patungan bensin", "Nonton", "Kopi", "Listrik kos"]),
        total: roundTo(between(120_000, 700_000) * scale, 10_000),
        participantRefs: participants,
      },
    });
  }

  // Everyday merchant spend.
  for (let i = 0; i < between(0, 2); i += 1) {
    actions.push({
      kind: "qr",
      at: at(between(7, 21)),
      request: {
        merchantRef: pick(["merchant-kopi", "merchant-indomaret", "merchant-tokopedia", "merchant-grab"]),
        amount: roundTo(between(12_000, 250_000) * scale, 500),
      },
    });
  }

  // Recurring bills, early in the month, rotating across the household's
  // utilities.
  //
  // The rotation is not decoration. A biller is a counterparty like any other
  // to ADA, so a (user, biller) pair that repeats three times becomes a graph
  // edge (PIPELINE_MIN_EDGE_INTERACTIONS). With four billers and a hundred-odd
  // customers, a fixed biller per household wires every circle to every other
  // through PLN and find_circles - which is plain connected components -
  // collapses the whole population into one circle. Rotating keeps each pair
  // below the threshold, so the only edges left are the person-to-person ones
  // the transaction-circle feature is actually about.
  if (dayOfMonth === profile.billDay) {
    const billers = ["biller-pln", "biller-telkom", "biller-bpjs", "biller-pdam"];
    const month = date.getUTCFullYear() * 12 + date.getUTCMonth();
    actions.push({
      kind: "bill",
      at: at(7),
      request: { payeeRef: billers[(profile.billerIndex + month) % billers.length] },
    });
  }

  // An occasional transfer out to another bank. The beneficiary gets a stable
  // `ext-<bank>-<account>` counterparty ref, so ADA's graph sees a weak edge
  // leaving the circle to contrast against the strong ones inside it.
  if (random() < 0.05) {
    actions.push({
      kind: "transferInterbank",
      at: at(between(9, 18)),
      request: {
        bankCode: pick(["014", "008", "002", "022"]),
        accountNumber: `1${String(between(100_000_000, 999_999_999))}`,
        beneficiaryName: "Penerima Luar",
        networkCode: "ONLINE",
        amount: roundTo(between(200_000, 1_500_000) * scale, 10_000),
      },
    });
  }

  if (random() < 0.06) {
    actions.push({
      kind: "withdraw",
      at: at(between(9, 19)),
      request: { amount: roundTo(between(100_000, 1_000_000) * scale, 50_000) },
    });
  }

  // Airtime, electricity token and e-wallet top-ups all map onto the same
  // wallet vocabulary, and give the amount features something to chew on.
  if (random() < 0.08) {
    actions.push({
      kind: "pulsa",
      at: at(between(8, 20)),
      request: {
        productRef: pick([
          "merchant-pulsa-telkomsel", "merchant-pulsa-indosat",
          "merchant-pulsa-xl", "merchant-pulsa-tri",
        ]),
        msisdn: "081200000000",
        amount: pick([25_000, 50_000, 100_000]),
      },
    });
  }
  if (random() < 0.05) {
    actions.push({
      kind: "ewallet",
      at: at(between(8, 20)),
      request: {
        walletRef: pick(["wallet-gopay", "wallet-ovo", "wallet-dana", "wallet-shopeepay"]),
        phone: "081200000000",
        amount: roundTo(between(50_000, 400_000), 10_000),
      },
    });
  }

  return actions;
}

// ------------------------------------------------------------------ execution

/** MOVEMENTS kind -> the mobile surface's direct endpoint. Every kind the day
 *  planner can produce needs an entry here, or a mobile customer posts to
 *  `/undefined` and the action is silently lost. */
const DIRECT_PATH = {
  transfer: "/transfer",
  transferInterbank: "/transfer/interbank",
  split: "/split",
  bill: "/bill",
  topup: "/topup",
  ewallet: "/topup/ewallet",
  qr: "/qr",
  withdraw: "/withdraw",
  pulsa: "/purchase/pulsa",
  token: "/purchase/token",
};

const stats = {
  logins: 0,
  actions: 0,
  settlements: 0,
  insufficientFunds: 0,
  failures: 0,
  failureSamples: [],
};

function noteFailure(context, err) {
  if (err?.code === "INSUFFICIENT_FUNDS") {
    stats.insufficientFunds += 1;
    return;
  }
  stats.failures += 1;
  if (stats.failureSamples.length < 10) {
    stats.failureSamples.push(`${context}: ${err?.code ?? "?"} ${err?.message ?? err}`);
  }
}

/** Desktop moves money the way the portal does: describe it, answer the token
 *  challenge, then confirm. Mobile posts straight to the action endpoint. */
async function performAction(session, action) {
  if (session.surface === "mobile") {
    const endpoint = DIRECT_PATH[action.kind];
    if (!endpoint) {
      throw Object.assign(new Error(`no mobile endpoint for "${action.kind}"`), { code: "NO_ENDPOINT" });
    }
    return session.call("POST", endpoint, {
      body: action.request,
      occurredAt: action.at,
    });
  }

  const prepared = await session.call("POST", "/tx/prepare", {
    body: { kind: action.kind, request: action.request },
    occurredAt: action.at,
  });
  if (!prepared?.token) {
    throw Object.assign(new Error("no token in prepare response; set DEMO_SHOW_TOKEN=true"), {
      code: "NO_TOKEN",
    });
  }
  return session.call("POST", "/tx/confirm", {
    body: { challengeId: prepared.challengeId, token: prepared.token },
    occurredAt: action.at,
  });
}

/** One customer's whole day: sign in, act, settle anything owed. */
async function runUserDay({ user, profile, peers, day, random, pendingSplits }) {
  const actions = planDay({ user, profile, peers, day, random });
  const owed = pendingSplits.get(user.ref) ?? [];
  if (actions.length === 0 && owed.length === 0) return;

  const session = new Surface(OPTIONS.baseUrl, profile.surface);
  const loginAt = new Date(day.at + 7 * 3600_000).toISOString();

  try {
    await session.call("POST", "/session", {
      body: { username: user.username, pin: OPTIONS.pin },
      occurredAt: loginAt,
    });
    stats.logins += 1;
  } catch (err) {
    noteFailure(`login ${user.ref}`, err);
    return;
  }

  for (const action of actions) {
    try {
      const result = await performAction(session, action);
      stats.actions += 1;
      // A split is only half an event stream until somebody pays their share.
      if (action.kind === "split" && result?.receipt?.id) {
        for (const ref of action.request.participantRefs) {
          if (!pendingSplits.has(ref)) pendingSplits.set(ref, []);
          pendingSplits.get(ref).push(result.receipt.id);
        }
      }
    } catch (err) {
      noteFailure(`${action.kind} ${user.ref}`, err);
    }
  }

  // Most people settle what they owe within a day or two of being asked.
  for (const splitId of owed.splice(0, owed.length)) {
    if (random() < 0.22) {
      owed.push(splitId); // still procrastinating; try again tomorrow
      continue;
    }
    try {
      await session.call("POST", `/split/${splitId}/settle`, {
        occurredAt: new Date(day.at + 20 * 3600_000).toISOString(),
      });
      stats.settlements += 1;
    } catch (err) {
      noteFailure(`settle ${user.ref}`, err);
    }
  }
}

/** Run `task` over `items` with a bounded number in flight. */
async function pool(items, limit, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

// ----------------------------------------------------------------------- main

function summariseCapture(lines) {
  const byType = {};
  const users = new Set();
  const days = new Set();
  for (const event of lines) {
    byType[event.event_type] = (byType[event.event_type] ?? 0) + 1;
    users.add(event.user_ref);
    days.add(event.occurred_at.slice(0, 10));
  }
  return { byType, users: users.size, days: days.size };
}

async function main() {
  if (config.capture.mode === "send") {
    console.error(
      "\nADA_TRANSPORT_MODE is 'send'. This script needs the server capturing to a file.\n" +
        "Set ADA_TRANSPORT_MODE=capture (or both) in .env and restart the server.\n"
    );
    process.exit(1);
  }

  const capturePath = path.resolve(config.capture.file);
  if (!OPTIONS.dryRun && !OPTIONS.keepCapture && existsSync(capturePath)) {
    rmSync(capturePath);
  }

  const { items: population } = await fetch(`${OPTIONS.baseUrl}/api/demo/users`)
    .then((r) => r.json())
    .catch((err) => {
      console.error(`\nCannot reach bank_demo at ${OPTIONS.baseUrl}: ${err.message}`);
      console.error("Start it first:  npm run dev\n");
      process.exit(1);
    });

  const users = population.slice(0, OPTIONS.users);
  if (users.length < OPTIONS.users) {
    console.warn(
      `\nServer has ${population.length} users but --users is ${OPTIONS.users}.\n` +
        `Set DEMO_POPULATION_SIZE=${OPTIONS.users} in .env and restart it.\n`
    );
  }

  const random = makeRandom(OPTIONS.seed);
  const profiles = new Map(users.map((u) => [u.ref, profileFor(u, random)]));
  const planted = plantPatterns(users, profiles, random);

  const peersOf = new Map(
    users.map((u) => [u.ref, users.filter((o) => o.ref !== u.ref && o.circle === u.circle)])
  );

  const patternCounts = {};
  for (const p of profiles.values()) patternCounts[p.pattern] = (patternCounts[p.pattern] ?? 0) + 1;
  const surfaceCounts = {};
  for (const p of profiles.values()) surfaceCounts[p.surface] = (surfaceCounts[p.surface] ?? 0) + 1;

  console.log(`\n  Population      ${users.length} users in ${new Set(users.map((u) => u.circle)).size} circles`);
  console.log(`  History         ${OPTIONS.days} days ending today (seed ${OPTIONS.seed})`);
  console.log(`  Surfaces        ${JSON.stringify(surfaceCounts)}`);
  console.log(`  Planted         ${JSON.stringify(patternCounts)}`);
  console.log(`                  market dip = ${planted.marketCohort}, circle dip = ${planted.circleDipCircles.join(", ")}`);
  console.log(`  Quiet window    last ${QUIET_DAYS} days`);

  if (OPTIONS.dryRun) {
    console.log("\n  --dry-run: no requests sent.\n");
    return;
  }

  const now = Date.now();
  const pendingSplits = new Map();
  const started = now;

  for (let index = 0; index < OPTIONS.days; index += 1) {
    const daysAgo = OPTIONS.days - index;
    const day = { index, daysAgo, at: now - daysAgo * DAY_MS };
    const active = users.filter((u) => !isQuiet(profiles.get(u.ref), daysAgo));

    await pool(active, OPTIONS.concurrency, (user) =>
      runUserDay({
        user,
        profile: profiles.get(user.ref),
        peers: peersOf.get(user.ref),
        day,
        random,
        pendingSplits,
      })
    );

    if ((index + 1) % 10 === 0 || index + 1 === OPTIONS.days) {
      process.stdout.write(
        `  day ${String(index + 1).padStart(3)}/${OPTIONS.days}  ` +
          `logins=${stats.logins} actions=${stats.actions}\n`
      );
    }
  }

  // Mobile events sit in the SDK queue in send/both mode; capture mode writes
  // straight through, but flushing costs nothing and keeps the two modes alike.
  await fetch(`${OPTIONS.baseUrl}/api/demo/flush`, { method: "POST" }).catch(() => {});

  if (!existsSync(capturePath)) {
    console.error(`\nNo capture file at ${capturePath}. Is ADA_TRANSPORT_MODE=capture set?\n`);
    process.exit(1);
  }

  const events = readFileSync(capturePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.client_event_id.localeCompare(b.client_event_id));

  mkdirSync(path.resolve(OPTIONS.out), { recursive: true });
  const outFile = path.join(path.resolve(OPTIONS.out), "ada-events.json");
  writeFileSync(outFile, `${JSON.stringify(events, null, 2)}\n`, "utf8");

  const summary = summariseCapture(events);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  logins=${stats.logins} actions=${stats.actions} settlements=${stats.settlements}`);
  console.log(`  insufficient-funds=${stats.insufficientFunds} other-failures=${stats.failures}`);
  for (const sample of stats.failureSamples) console.log(`    ! ${sample}`);
  console.log(`\n  ${events.length} events, ${summary.users} users, ${summary.days} distinct days`);
  for (const [type, count] of Object.entries(summary.byType).sort()) {
    console.log(`    ${String(count).padStart(6)}  ${type}`);
  }
  console.log(`\n  Wrote ${outFile}`);
  console.log("  Next:  node scripts/make-labeled-examples.js");
  console.log("         cd ../ADA_project && uv run python -m worker.main \\");
  console.log("           --tenant-slug demo-wallet \\");
  console.log("           --events  ../bank_demo/out/ada-events.json \\");
  console.log("           --labeled ../bank_demo/out/ada-labeled-examples.json\n");
}

await main();
