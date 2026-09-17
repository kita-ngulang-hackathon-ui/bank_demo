/** Write the prior-cycle labeled examples ADA's pipeline needs to produce
 *  recommendations at all.
 *
 *   node scripts/make-labeled-examples.js
 *   node scripts/make-labeled-examples.js --treated 240 --control 240
 *
 * Why this file has to exist
 * --------------------------
 * A labeled example is what ADA learns from: a past user, the features they had
 * when a decision was made, whether they were incentivised, and whether they
 * stayed. The IMPACT stage fits one model over the treated rows and one over the
 * control rows and takes the difference, so it refuses to run until BOTH arms
 * hold at least IMPACT_MIN_TRAIN_ROWS rows (200 by default). Below that it
 * raises ContextTooSmall, the pipeline records `available: false`, POLICY builds
 * candidates only for users that have an impact score - which is nobody - and
 * PERSIST writes zero recommendations. A run over pure event history would show
 * churn risk and a transaction graph and then stop.
 *
 * Those rows normally come from the previous cycle's measured outcomes. There is
 * no previous cycle yet, so this generates the first one. It is SYNTHETIC
 * history, disjoint from the live population by construction: the pseudonyms are
 * `hist<n>`, never a bank_demo customer.
 *
 * Why it reads the captured events
 * --------------------------------
 * Both models are fitted on these rows and then asked to predict for the live
 * population. If the two feature distributions disagree the models are
 * extrapolating, and the segment split comes out meaningless - a first version
 * of this script invented plausible-looking numbers and put 61 of 120 customers
 * in SLEEPING_DOG, because its rows carried a tenth of the transaction volume
 * the real ones do. So the ranges are measured from `out/ada-events.json`
 * instead of guessed: this is meant to be the same population one cycle ago.
 *
 * The signal planted in it, matching services/worker/tests/worker_world.py:
 * incentivised users mostly stay; un-incentivised quiet users mostly leave;
 * busy users stay either way. That makes quiet users PERSUADABLE (the incentive
 * moves them) and busy users SURE_THINGs (it does not), which is exactly the
 * distinction the Intervention Impact Engine exists to draw.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { makeRandom, helpers } from "../server/src/lib/random.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const int = (name, fallback) => Number.parseInt(flag(name, String(fallback)), 10);

const OPTIONS = {
  treated: int("treated", 240),
  control: int("control", 240),
  seed: flag("seed", "bank_demo_labeled_v1"),
  out: flag("out", "out"),
  events: flag("events", "out/ada-events.json"),
  // main.py rewrites this to the tenant it seeds, so the value here is only a
  // readable placeholder.
  tenantId: flag("tenant-id", "demo-wallet"),
};

/** churn_risk.FEATURE_COLUMNS, in order. A labeled example's features have to
 *  use these exact keys: the ranker and the impact engine line every row up by
 *  column name, and an unknown key is silently read as 0.0. */
const FEATURE_COLUMNS = [
  "recency_days",
  "frequency_30d",
  "monetary_30d_idr",
  "tenure_days",
  "session_gap_days",
  "delta_stability",
  "circle_size",
  "pattern_circle_specific",
  "pattern_market_driven",
  "pattern_stable",
  "external_signal_value",
];

/** Individual incentives from fixtures/incentives.json that apply to WALLET. */
const INCENTIVES = [
  { code: "CASHBACK_10K", costIdr: 10_000 },
  { code: "TRANSFER_FEE_WAIVER_30D", costIdr: 7_500 },
];

const ACTIVITY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Which mapped field carries the amount, per fixtures/mappings/wallet.json.
 *  wallet.app.opened maps to SESSION_OPEN and carries none. */
const AMOUNT_FIELD = {
  "wallet.transfer.sent": "amount",
  "wallet.split.created": "total",
  "wallet.split.settled": "share",
  "wallet.bill.autopay": "amount",
  "wallet.topup.completed": "amount",
  "wallet.payment.merchant": "amount",
  "wallet.withdraw.completed": "amount",
};

/** Recompute, per user, the same five behavioural features ADA derives in
 *  churn_risk.build_features, so the generated history matches the live one. */
function measurePopulation(eventsFile) {
  if (!existsSync(eventsFile)) return null;
  const events = JSON.parse(readFileSync(eventsFile, "utf8"));
  if (!Array.isArray(events) || events.length === 0) return null;

  const now = Math.max(...events.map((e) => Date.parse(e.occurred_at)));
  const byUser = new Map();
  for (const event of events) {
    if (!byUser.has(event.user_ref)) byUser.set(event.user_ref, []);
    byUser.get(event.user_ref).push(event);
  }

  const rows = [];
  for (const list of byUser.values()) {
    list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const times = list.map((e) => Date.parse(e.occurred_at));
    const windowStart = now - ACTIVITY_WINDOW_DAYS * DAY_MS;
    const recent = list.filter((_, i) => times[i] >= windowStart);
    const recentTimes = times.filter((t) => t >= windowStart);

    const monetary = recent.reduce((sum, e) => {
      const field = AMOUNT_FIELD[e.event_type];
      return sum + (field ? Number(e.payload?.[field] ?? 0) : 0);
    }, 0);

    rows.push({
      recency_days: (now - times[times.length - 1]) / DAY_MS,
      frequency_30d: recent.length,
      monetary_30d_idr: monetary,
      tenure_days: (now - times[0]) / DAY_MS,
      session_gap_days:
        recentTimes.length >= 2
          ? (recentTimes[recentTimes.length - 1] - recentTimes[0]) / DAY_MS / (recentTimes.length - 1)
          : ACTIVITY_WINDOW_DAYS,
    });
  }
  return rows;
}

/** Stand-in ranges for when no capture exists yet. Deliberately coarse: run the
 *  simulation first and these are never used. */
const FALLBACK = [
  { recency_days: 0, frequency_30d: 70, monetary_30d_idr: 28_000_000, tenure_days: 90, session_gap_days: 0.4 },
  { recency_days: 34, frequency_30d: 0, monetary_30d_idr: 0, tenure_days: 90, session_gap_days: 30 },
];

const measured = measurePopulation(path.resolve(OPTIONS.events));
const population = measured ?? FALLBACK;
const medianFrequency = population
  .map((r) => r.frequency_30d)
  .sort((a, b) => a - b)[Math.floor(population.length / 2)];

const random = makeRandom(OPTIONS.seed);
const { pick, between, roundTo } = helpers(random);

/** Draw a real customer's behaviour and nudge it, so a generated row sits
 *  inside the live distribution rather than beside it. */
function drawBehaviour() {
  const base = pick(population);
  const jitter = (value, spread = 0.2) =>
    Math.max(0, value * (1 - spread + random() * spread * 2));
  return {
    recency_days: Math.round(jitter(base.recency_days) + (base.recency_days === 0 ? random() * 2 : 0)),
    frequency_30d: Math.round(jitter(base.frequency_30d)),
    monetary_30d_idr: roundTo(jitter(base.monetary_30d_idr), 10_000),
    tenure_days: Math.round(jitter(base.tenure_days, 0.35)),
    session_gap_days: Math.round(jitter(base.session_gap_days) * 100) / 100,
  };
}

function makeRow(index, treated) {
  const behaviour = drawBehaviour();
  // "Busy" is relative to this population, not an absolute transaction count.
  const busy = behaviour.frequency_30d >= medianFrequency;

  // The planted relationship: the incentive is what rescues a quiet customer,
  // and makes little difference to one who was never going anywhere.
  const retained = busy
    ? random() < 0.94
    : treated
      ? random() < 0.78
      : random() < 0.14;

  const dip = busy ? 0 : -Math.round(random() * 45) / 100;
  const circleSize = random() < 0.7 ? between(3, 8) : 0;
  const circleSpecific = circleSize > 0 && dip <= -0.1 && random() < 0.65;
  const marketDriven = circleSize > 0 && dip <= -0.1 && !circleSpecific;

  const incentive = pick(INCENTIVES);
  const spend = treated ? incentive.costIdr : 0;
  // Business value of keeping them: monthly volume x PIPELINE_BUSINESS_VALUE_MONTHS.
  const businessValue = Math.round(behaviour.monetary_30d_idr * 3);

  const values = {
    ...behaviour,
    delta_stability: dip,
    circle_size: circleSize,
    pattern_circle_specific: circleSpecific ? 1 : 0,
    pattern_market_driven: marketDriven ? 1 : 0,
    pattern_stable: !circleSpecific && !marketDriven ? 1 : 0,
    external_signal_value: Math.round((random() * 0.6 - 0.3) * 100) / 100,
  };

  return {
    tenant_id: OPTIONS.tenantId,
    source_outcome_id: `hist-outcome-${String(index).padStart(4, "0")}`,
    user_pseudonym: `hist${index}`,
    // Emitted in FEATURE_COLUMNS order so the file reads the way the model sees it.
    features: Object.fromEntries(FEATURE_COLUMNS.map((column) => [column, values[column]])),
    arm: treated ? "ENGINE" : "CONTROL",
    treated,
    retained,
    churn_risk:
      Math.round(Math.min(0.97, Math.max(0.03, behaviour.recency_days / 40 + (busy ? -0.1 : 0.25))) * 1000) / 1000,
    impact_score: Math.round((busy ? random() * 0.05 : 0.08 + random() * 0.3) * 1000) / 1000,
    pattern_type: circleSpecific ? "CIRCLE_SPECIFIC" : marketDriven ? "MARKET_DRIVEN" : "STABLE",
    incentive_code: treated ? incentive.code : null,
    cost_idr: spend,
    business_value_idr: businessValue,
    // Ranker's proxy target: value kept, minus what keeping it cost.
    realized_value_idr: (retained ? businessValue : 0) - spend,
  };
}

const rows = [];
for (let i = 0; i < OPTIONS.treated; i += 1) rows.push(makeRow(rows.length, true));
for (let i = 0; i < OPTIONS.control; i += 1) rows.push(makeRow(rows.length, false));

mkdirSync(path.resolve(OPTIONS.out), { recursive: true });
const outFile = path.join(path.resolve(OPTIONS.out), "ada-labeled-examples.json");
writeFileSync(outFile, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

const rate = (subset) =>
  subset.length === 0 ? "-" : `${Math.round((subset.filter((r) => r.retained).length / subset.length) * 100)}%`;
const treatedRows = rows.filter((r) => r.treated);
const controlRows = rows.filter((r) => !r.treated);

console.log(
  measured
    ? `\n  Calibrated against ${measured.length} customers in ${OPTIONS.events}`
    : `\n  ${OPTIONS.events} not found - using fallback ranges. Run the simulation first.`
);
console.log(`  ${rows.length} labeled examples`);
console.log(`    treated  ${treatedRows.length}  retained ${rate(treatedRows)}`);
console.log(`    control  ${controlRows.length}  retained ${rate(controlRows)}`);
console.log(`  Wrote ${outFile}\n`);
