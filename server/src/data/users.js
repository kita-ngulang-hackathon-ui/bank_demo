/** Demo population.
 *
 * `ref` is what bank_demo sends to ADA as `user_ref`. ADA hashes it into a
 * pseudonym on its side; nothing here is a real customer.
 *
 * The `circle` field is what makes the transaction-circle feature light up:
 * transfers and split bills only fire between members of the same circle, so
 * ADA's graph stage sees repeated counterparty edges instead of noise.
 */

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
    attributes: { region: "JAKARTA", cohort: "C3", segment: "YOUNG_PROFESSIONAL", tenure_months: "34" },
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
    attributes: { region: "JAKARTA", cohort: "C3", segment: "YOUNG_PROFESSIONAL", tenure_months: "18" },
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
    attributes: { region: "BANDUNG", cohort: "C5", segment: "STUDENT", tenure_months: "9" },
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
    attributes: { region: "SURABAYA", cohort: "C1", segment: "AFFLUENT", tenure_months: "61" },
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
    attributes: { region: "JAKARTA", cohort: "C2", segment: "MASS_AFFLUENT", tenure_months: "42" },
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
    attributes: { region: "MEDAN", cohort: "C6", segment: "MASS", tenure_months: "6" },
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
    attributes: { region: "BANDUNG", cohort: "C5", segment: "MASS_AFFLUENT", tenure_months: "27" },
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
    attributes: { region: "BANDUNG", cohort: "C5", segment: "MASS", tenure_months: "15" },
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

const byRef = new Map(USERS.map((u) => [u.ref, u]));
const byUsername = new Map(USERS.map((u) => [u.username, u]));

export const getUser = (ref) => byRef.get(ref) ?? null;
export const getUserByUsername = (username) => byUsername.get(String(username ?? "").toLowerCase()) ?? null;
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
