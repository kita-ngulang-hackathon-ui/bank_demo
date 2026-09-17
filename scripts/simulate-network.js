/** Backfill realistic history for the demo population.
 *
 *   npm run simulate -- --days 60
 *   npm run simulate -- --days 60 --dry-run
 *
 * ADA's graph stage needs REPEATED counterparty edges before a transaction
 * circle exists at all (PIPELINE_MIN_EDGE_INTERACTIONS, default 3). Clicking
 * through the UI on stage produces one or two edges, which is not enough. This
 * script lays down weeks of P2P transfers and split bills inside each circle
 * so the live clicks land on top of a real graph.
 *
 * Deterministic: same seed, same history, so a re-run is idempotent at the
 * ADA end (client_event_id is derived, not random).
 */
import { createHash } from "node:crypto";
import { config } from "../server/src/config.js";
import { postEventBatch } from "../server/src/ada/http.js";
import { USERS, BILLERS, MERCHANTS } from "../server/src/data/users.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const DAYS = Number.parseInt(flag("days", "45"), 10);
const SEED = flag("seed", "bank_demo_v1");
const DRY_RUN = args.includes("--dry-run");

/** Small deterministic PRNG - mulberry32 seeded from the run seed. */
function makeRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(SEED);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => Math.round(min + random() * (max - min));
const roundTo = (value, step) => Math.round(value / step) * step;

/** Derived, not random: re-running the script re-sends the same ids, which
 *  ADA dedupes instead of double-counting. */
const eventId = (parts) => `bdsim_${createHash("sha1").update(`${SEED}:${parts.join(":")}`).digest("hex").slice(0, 24)}`;

const circles = new Map();
for (const user of USERS) {
  if (!circles.has(user.circle)) circles.set(user.circle, []);
  circles.get(user.circle).push(user);
}

const events = [];
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

for (let dayOffset = DAYS; dayOffset >= 1; dayOffset -= 1) {
  const dayStart = now - dayOffset * DAY;
  const date = new Date(dayStart);
  const weekday = date.getUTCDay();

  for (const user of USERS) {
    const attrs = user.attributes;
    const peers = circles.get(user.circle).filter((u) => u.ref !== user.ref);

    // Sessions: everyone opens the app most days.
    if (random() < 0.82) {
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "open"]),
        event_type: "wallet.app.opened",
        occurred_at: new Date(dayStart + between(7, 22) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { surface: random() < 0.75 ? "mobile" : "desktop" },
      });
    }

    // P2P inside the circle - the edge that builds the transaction graph.
    if (peers.length && random() < 0.45) {
      const peer = pick(peers);
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "p2p"]),
        event_type: "wallet.transfer.sent",
        occurred_at: new Date(dayStart + between(8, 21) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { amount: roundTo(between(25_000, 750_000), 5_000), recipient_ref: peer.ref },
      });
    }

    // Split bills cluster on Friday and Saturday.
    if (peers.length >= 2 && (weekday === 5 || weekday === 6) && random() < 0.5) {
      const withPeer = pick(peers);
      const total = roundTo(between(120_000, 900_000), 10_000);
      const share = Math.round(total / (peers.length + 1));
      const at = new Date(dayStart + between(18, 22) * 3600000).toISOString();

      events.push({
        client_event_id: eventId([user.ref, dayOffset, "splitc", withPeer.ref]),
        event_type: "wallet.split.created",
        occurred_at: at,
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { total, share, split_with_ref: withPeer.ref },
      });

      // Most shares get settled within a day or two.
      if (random() < 0.78) {
        events.push({
          client_event_id: eventId([withPeer.ref, dayOffset, "splits", user.ref]),
          event_type: "wallet.split.settled",
          occurred_at: new Date(dayStart + between(24, 44) * 3600000).toISOString(),
          user_ref: withPeer.ref,
          user_attributes: withPeer.attributes,
          payload: { share, total, split_with_ref: user.ref },
        });
      }
    }

    // Merchant payments: the everyday background noise.
    const merchantCount = between(0, 3);
    for (let i = 0; i < merchantCount; i += 1) {
      const merchant = pick(MERCHANTS);
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "merchant", i]),
        event_type: "wallet.payment.merchant",
        occurred_at: new Date(dayStart + between(7, 22) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { amount: roundTo(between(12_000, 320_000), 500), merchant_ref: merchant.ref },
      });
    }

    // Top-ups every week or so.
    if (random() < 0.16) {
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "topup"]),
        event_type: "wallet.topup.completed",
        occurred_at: new Date(dayStart + between(8, 20) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { amount: roundTo(between(200_000, 2_000_000), 50_000) },
      });
    }

    // Withdrawals, rarer.
    if (random() < 0.07) {
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "withdraw"]),
        event_type: "wallet.withdraw.completed",
        occurred_at: new Date(dayStart + between(9, 20) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { amount: roundTo(between(100_000, 1_500_000), 50_000) },
      });
    }

    // Recurring bills land early in the month.
    if (date.getUTCDate() <= 5 && random() < 0.5) {
      const biller = pick(BILLERS);
      events.push({
        client_event_id: eventId([user.ref, dayOffset, "bill", biller.ref]),
        event_type: "wallet.bill.autopay",
        occurred_at: new Date(dayStart + between(6, 10) * 3600000).toISOString(),
        user_ref: user.ref,
        user_attributes: attrs,
        payload: { amount: biller.defaultAmount, payee_ref: biller.ref },
      });
    }
  }
}

events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

const byType = events.reduce((acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] ?? 0) + 1 }), {});
console.log(`\nGenerated ${events.length} events over ${DAYS} days for ${USERS.length} users (seed ${SEED})`);
for (const [type, count] of Object.entries(byType).sort()) console.log(`  ${String(count).padStart(5)}  ${type}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nothing sent.\n");
  console.log(JSON.stringify(events.slice(0, 3), null, 2));
  process.exit(0);
}

console.log(`\nSending to ${config.ada.baseUrl} in batches of ${config.ada.maxBatchSize}...`);

let accepted = 0;
let duplicates = 0;
let rejected = 0;

for (let i = 0; i < events.length; i += config.ada.maxBatchSize) {
  const chunk = events.slice(i, i + config.ada.maxBatchSize);
  try {
    const result = await postEventBatch(chunk);
    accepted += result.accepted_count ?? 0;
    duplicates += result.duplicate_count ?? 0;
    rejected += result.rejected?.length ?? 0;
    for (const bad of result.rejected ?? []) console.warn(`  rejected ${bad.client_event_id}: ${bad.message}`);
    process.stdout.write(`  batch ${Math.floor(i / config.ada.maxBatchSize) + 1}: +${result.accepted_count} accepted\n`);
  } catch (err) {
    console.error(`  batch starting at ${i} failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

console.log(`\nDone. accepted=${accepted} duplicate=${duplicates} rejected=${rejected}`);
console.log("The ADA worker picks these up within WORKER_POLL_INTERVAL_SECONDS.\n");
