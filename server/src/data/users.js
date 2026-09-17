/** Demo population.
 *
 * `ref` is what bank_demo sends to ADA as `user_ref`. ADA hashes it into a
 * pseudonym on its side; nothing here is a real customer.
 *
 * The `circle` field is what makes the transaction-circle feature light up:
 * transfers and split bills only fire between members of the same circle, so
 * ADA's graph stage sees repeated counterparty edges instead of noise.
 *
 * `attributes` keys are NOT free-form. ADA's canonical event model whitelists
 * exactly {channel, region_code, cohort_key} (core_contracts/events.py:
 * ALLOWED_ATTRIBUTE_KEYS) and normalize() silently drops everything else, so
 * anything spelled differently never reaches the pipeline at all. The
 * region_code values are keys of `region_by_code` in
 * ADA_project/fixtures/churn_scorer_mapping.json - an unknown code falls back
 * to the scorer's default region instead of carrying signal.
 */
import { config } from "../config.js";
import { makeRandom, helpers } from "../lib/random.js";

export const USERS = [
  {
    ref: "bd-user-001",
    name: "Andi Pratama",
    username: "andipratama",
    pin: "123456",
    accountNumber: "0881234501",
    cardLast4: "4417",
    balance: 18_450_000,
    savingsBalance: 62_300_000,
    profile: { region: "JAKARTA", segment: "YOUNG_PROFESSIONAL", tenureMonths: "34" },
    attributes: { region_code: "ID-JK", cohort_key: "cohort-3" },
    circle: "kost-sudirman",
    avatarColor: "#F26F21",
  },
  {
    ref: "bd-user-002",
    name: "Bella Anindya",
    username: "bellaanindya",
    pin: "123456",
    accountNumber: "0881234502",
    cardLast4: "9032",
    balance: 7_120_000,
    savingsBalance: 15_900_000,
    profile: { region: "JAKARTA", segment: "YOUNG_PROFESSIONAL", tenureMonths: "18" },
    attributes: { region_code: "ID-JK", cohort_key: "cohort-3" },
    circle: "kost-sudirman",
    avatarColor: "#00857D",
  },
  {
    ref: "bd-user-003",
    name: "Citra Larasati",
    username: "citralarasati",
    pin: "123456",
    accountNumber: "0881234503",
    cardLast4: "2288",
    balance: 3_480_000,
    savingsBalance: 4_100_000,
    profile: { region: "BANDUNG", segment: "STUDENT", tenureMonths: "9" },
    attributes: { region_code: "ID-JB", cohort_key: "cohort-5" },
    circle: "kost-sudirman",
    avatarColor: "#7A3FF2",
  },
  {
    ref: "bd-user-004",
    name: "Dimas Nugroho",
    username: "dimasnugroho",
    pin: "123456",
    accountNumber: "0881234504",
    cardLast4: "5510",
    balance: 26_900_000,
    savingsBalance: 88_000_000,
    profile: { region: "SURABAYA", segment: "AFFLUENT", tenureMonths: "61" },
    attributes: { region_code: "ID-JI", cohort_key: "cohort-1" },
    circle: "kantor-thamrin",
    avatarColor: "#1F6FEB",
  },
  {
    ref: "bd-user-005",
    name: "Eka Wulandari",
    username: "ekawulandari",
    pin: "123456",
    accountNumber: "0881234505",
    cardLast4: "7741",
    balance: 11_050_000,
    savingsBalance: 23_400_000,
    profile: { region: "JAKARTA", segment: "MASS_AFFLUENT", tenureMonths: "42" },
    attributes: { region_code: "ID-JK", cohort_key: "cohort-2" },
    circle: "kantor-thamrin",
    avatarColor: "#E0245E",
  },
  {
    ref: "bd-user-006",
    name: "Fajar Ramadhan",
    username: "fajarramadhan",
    pin: "123456",
    accountNumber: "0881234506",
    cardLast4: "6603",
    balance: 2_310_000,
    savingsBalance: 1_250_000,
    profile: { region: "MEDAN", segment: "MASS", tenureMonths: "6" },
    attributes: { region_code: "ID-SU", cohort_key: "cohort-6" },
    circle: "kantor-thamrin",
    avatarColor: "#0F9D58",
  },
  {
    ref: "bd-user-007",
    name: "Gita Maharani",
    username: "gitamaharani",
    pin: "123456",
    accountNumber: "0881234507",
    cardLast4: "3390",
    balance: 9_770_000,
    savingsBalance: 12_050_000,
    profile: { region: "BANDUNG", segment: "MASS_AFFLUENT", tenureMonths: "27" },
    attributes: { region_code: "ID-JB", cohort_key: "cohort-5" },
    circle: "arisan-bandung",
    avatarColor: "#B8860B",
  },
  {
    ref: "bd-user-008",
    name: "Hendra Saputra",
    username: "hendrasaputra",
    pin: "123456",
    accountNumber: "0881234508",
    cardLast4: "1174",
    balance: 5_640_000,
    savingsBalance: 7_800_000,
    profile: { region: "BANDUNG", segment: "MASS", tenureMonths: "15" },
    attributes: { region_code: "ID-JB", cohort_key: "cohort-5" },
    circle: "arisan-bandung",
    avatarColor: "#3D5AFE",
  },
];

/** Non-customer payees. These still carry a counterparty ref so recurring
 *  bills have a stable edge, but they are never a transfer destination. */
export const BILLERS = [
  { ref: "biller-pln", name: "PLN Pascabayar", category: "Electricity", defaultAmount: 425_000 },
  { ref: "biller-telkom", name: "IndiHome", category: "Internet", defaultAmount: 385_000 },
  { ref: "biller-bpjs", name: "BPJS Kesehatan", category: "Insurance", defaultAmount: 150_000 },
  { ref: "biller-pdam", name: "PDAM Jaya", category: "Water", defaultAmount: 120_000 },
];

export const MERCHANTS = [
  { ref: "merchant-kopi", name: "Kopi Kenangan Sudirman", category: "F&B", typicalAmount: 28_000 },
  { ref: "merchant-indomaret", name: "Indomaret Thamrin", category: "Retail", typicalAmount: 62_500 },
  { ref: "merchant-tokopedia", name: "Tokopedia", category: "E-commerce", typicalAmount: 215_000 },
  { ref: "merchant-grab", name: "Grab", category: "Transport", typicalAmount: 34_000 },
];

// -- generated population ------------------------------------------------

/** Region codes ADA's churn scorer understands, with the cohort that goes
 *  with each. Cohort is what external signals resolve against at COHORT
 *  scope, so it has to vary alongside region rather than track it exactly. */
const REGIONS = ["ID-JK", "ID-JB", "ID-JI", "ID-SU", "ID-SN"];
const COHORTS = ["cohort-1", "cohort-2", "cohort-3", "cohort-4", "cohort-5", "cohort-6"];

/** Display-only labels for the region codes above. `profile` is what the two
 *  front ends render; `attributes` is what goes on the wire to ADA. Keeping
 *  them apart is what stops a UI tweak from silently changing pipeline input. */
const REGION_LABELS = {
  "ID-JK": "JAKARTA", "ID-JB": "BANDUNG", "ID-JI": "SURABAYA",
  "ID-SU": "MEDAN", "ID-SN": "MAKASSAR",
};
const SEGMENTS = ["STUDENT", "MASS", "YOUNG_PROFESSIONAL", "MASS_AFFLUENT", "AFFLUENT"];

const FIRST_NAMES = [
  "Adi", "Ayu", "Bagus", "Bunga", "Cahya", "Dewi", "Eko", "Fitri", "Galih", "Hana",
  "Indra", "Intan", "Joko", "Kartika", "Lukman", "Maya", "Nanda", "Nur", "Oka", "Putri",
  "Rizky", "Rina", "Satrio", "Sari", "Teguh", "Tiara", "Umar", "Vina", "Wahyu", "Yuni",
  "Zahra", "Arif", "Bayu", "Citra", "Dian", "Elang", "Farah", "Gilang", "Hesti", "Ilham",
];
const LAST_NAMES = [
  "Wijaya", "Santoso", "Halim", "Kusuma", "Permata", "Siregar", "Hutapea", "Nasution",
  "Putra", "Utami", "Hakim", "Lestari", "Firmansyah", "Rahayu", "Simanjuntak", "Gunawan",
  "Prasetyo", "Anggraini", "Setiawan", "Handayani",
];

/** Circle names for the generated cohort. Kept separate from the three
 *  handwritten ones so the stage demo's circles stay exactly as rehearsed. */
const CIRCLE_NAMES = [
  "kos-depok", "kantor-sudirman", "arisan-bekasi", "warung-tebet", "gym-kemang",
  "kampus-salemba", "kantor-scbd", "kos-margonda", "arisan-cibubur", "komunitas-bintaro",
  "kantor-gatsu", "kos-jatinangor", "arisan-surabaya", "kantor-medan", "komunitas-makassar",
];

const CIRCLE_SIZE = 8;

const AVATAR_PALETTE = ["#F26F21", "#00857D", "#7A3FF2", "#1F6FEB", "#E0245E", "#0F9D58", "#B8860B", "#3D5AFE"];

/** Deterministic filler customers, appended to the handwritten eight.
 *
 * Circle membership is the point: ADA only sees a transaction circle after
 * PIPELINE_MIN_EDGE_INTERACTIONS repeated edges between the same pair, and
 * only counts one at PIPELINE_CIRCLE_MIN_SIZE members or more. Circles of
 * eight give the simulation room to build those edges.
 */
export function generateUsers(count, seedText) {
  if (count <= 0) return [];
  const { random, pick, between, roundTo } = helpers(makeRandom(seedText));
  const generated = [];
  const taken = new Set(USERS.map((u) => u.username));

  for (let i = 0; i < count; i += 1) {
    const seq = USERS.length + generated.length + 1;
    const circleIndex = Math.floor(i / CIRCLE_SIZE) % CIRCLE_NAMES.length;

    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    let username = name.toLowerCase().replace(/[^a-z]/g, "");
    if (taken.has(username)) username = `${username}${seq}`;
    taken.add(username);

    // A circle shares a region and mostly a cohort: neighbours in a real
    // transaction circle live and earn alike, which is what makes a
    // circle-wide dip distinguishable from a market-wide one.
    const regionCode = REGIONS[circleIndex % REGIONS.length];
    const cohortKey = random() < 0.8
      ? COHORTS[circleIndex % COHORTS.length]
      : pick(COHORTS);

    const balance = roundTo(between(1_500_000, 30_000_000), 10_000);

    generated.push({
      ref: `bd-user-${String(seq).padStart(3, "0")}`,
      name,
      username,
      pin: "123456",
      accountNumber: `088${String(1_000_000 + seq).slice(1)}`,
      cardLast4: String(between(1000, 9999)),
      balance,
      savingsBalance: roundTo(balance * (1 + random() * 3), 10_000),
      profile: {
        region: REGION_LABELS[regionCode],
        // Wealth band follows the balance, so the label matches what the
        // account actually holds.
        segment: SEGMENTS[Math.min(SEGMENTS.length - 1, Math.floor(balance / 6_000_000))],
        tenureMonths: String(between(2, 72)),
      },
      attributes: { region_code: regionCode, cohort_key: cohortKey },
      circle: CIRCLE_NAMES[circleIndex],
      avatarColor: AVATAR_PALETTE[seq % AVATAR_PALETTE.length],
    });
  }
  return generated;
}

// Top the roster up to DEMO_POPULATION_SIZE. Default 8 keeps the stage demo
// exactly as it was; the simulation sets it to 120.
USERS.push(...generateUsers(config.population.size - USERS.length, config.population.seed));

const byRef = new Map(USERS.map((u) => [u.ref, u]));
const byUsername = new Map(USERS.map((u) => [u.username, u]));

export const getUser = (ref) => byRef.get(ref) ?? null;
export const getUserByUsername = (username) => byUsername.get(String(username ?? "").toLowerCase()) ?? null;

// -- registration -------------------------------------------------------

/** Circles a newly registered user can join, round-robin, so they land in a
 *  graph with real counterparties from their first login instead of alone. */
const CIRCLES = [...new Set(USERS.map((u) => u.circle))];
let registeredCount = 0;

const USERNAME_RULE = /^[a-z][a-z0-9_]{2,19}$/;
const PIN_RULE = /^\d{6}$/;

/** Creates a new demo customer. Throws with a `.code` on any validation
 *  failure, same convention as banking.js, so the route layer can turn it
 *  into a clean 4xx without a second switch statement. */
export function registerUser({ name, username, pin }) {
  const cleanName = String(name ?? "").trim();
  const cleanUsername = String(username ?? "").trim().toLowerCase();

  if (cleanName.length < 3) {
    const err = new Error("Nama minimal 3 karakter.");
    err.code = "VALIDATION";
    throw err;
  }
  if (!USERNAME_RULE.test(cleanUsername)) {
    const err = new Error("User ID 3-20 karakter, huruf kecil/angka, diawali huruf.");
    err.code = "VALIDATION";
    throw err;
  }
  if (!PIN_RULE.test(String(pin ?? ""))) {
    const err = new Error("PIN harus 6 digit angka.");
    err.code = "VALIDATION";
    throw err;
  }
  if (byUsername.has(cleanUsername)) {
    const err = new Error("User ID sudah digunakan.");
    err.code = "USERNAME_TAKEN";
    throw err;
  }

  registeredCount += 1;
  const seq = USERS.length + 1;
  const ref = `bd-user-${String(seq).padStart(3, "0")}`;
  const circle = CIRCLES[registeredCount % CIRCLES.length];

  const user = {
    ref,
    name: cleanName,
    username: cleanUsername,
    pin: String(pin),
    accountNumber: `088${String(1_000_000 + seq).slice(1)}`,
    cardLast4: String(1000 + Math.floor(Math.random() * 9000)),
    balance: 500_000,
    savingsBalance: 0,
    profile: { region: "JAKARTA", segment: "NEW_CUSTOMER", tenureMonths: "0" },
    attributes: { region_code: "ID-JK", cohort_key: "cohort-4" },
    circle,
    avatarColor: AVATAR_PALETTE[seq % AVATAR_PALETTE.length],
  };

  USERS.push(user);
  byRef.set(user.ref, user);
  byUsername.set(user.username, user);
  return user;
}
export const getBiller = (ref) => BILLERS.find((b) => b.ref === ref) ?? null;
export const getMerchant = (ref) => MERCHANTS.find((m) => m.ref === ref) ?? null;

/** Everyone in the same circle, plus one out-of-circle contact so the graph
 *  has a weak edge to contrast against the strong ones. */
export function contactsFor(ref) {
  const me = getUser(ref);
  if (!me) return [];
  const inCircle = USERS.filter((u) => u.ref !== ref && u.circle === me.circle);
  const outside = USERS.find((u) => u.circle !== me.circle);
  return [...inCircle, ...(outside ? [outside] : [])].map(publicUser);
}

/** What the browser is allowed to see about a person. No PIN, ever. */
export function publicUser(user) {
  if (!user) return null;
  const { pin, ...safe } = user;
  return safe;
}
