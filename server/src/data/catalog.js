/** Catalogues the desktop portal needs: other banks, prepaid products and
 *  e-wallets. All fictional-but-plausible; nothing here is a real product
 *  listing.
 *
 * Counterparty refs are stable strings so a repeated payment to the same
 * destination is the same edge to ADA, exactly like a transfer between two
 * demo users.
 */

/** Interbank networks, with the fee model Indonesian retail portals use. */
export const TRANSFER_NETWORKS = [
  {
    code: "ONLINE",
    name: "Transfer Online (BI-FAST)",
    fee: 2_500,
    limit: 250_000_000,
    sla: "Real time",
  },
  {
    code: "SKN",
    name: "Kliring (SKNBI)",
    fee: 2_900,
    limit: 1_000_000_000,
    sla: "1 hari kerja",
  },
  {
    code: "RTGS",
    name: "RTGS",
    fee: 30_000,
    limit: 10_000_000_000,
    sla: "Same day, min. Rp 100 juta",
    minAmount: 100_000_000,
  },
];

export const BANKS = [
  { code: "014", name: "Bank Central Asia" },
  { code: "008", name: "Bank Mandiri" },
  { code: "002", name: "Bank Rakyat Indonesia" },
  { code: "013", name: "Bank Permata" },
  { code: "022", name: "Bank CIMB Niaga" },
  { code: "451", name: "Bank Syariah Indonesia" },
  { code: "213", name: "Bank BTPN Jenius" },
  { code: "501", name: "Bank Digital BCA" },
];

/** Prepaid airtime and data. Sold as a merchant payment. */
export const PULSA_PRODUCTS = [
  { ref: "merchant-pulsa-telkomsel", provider: "Telkomsel", denominations: [25_000, 50_000, 100_000, 200_000] },
  { ref: "merchant-pulsa-indosat", provider: "Indosat Ooredoo", denominations: [25_000, 50_000, 100_000] },
  { ref: "merchant-pulsa-xl", provider: "XL Axiata", denominations: [25_000, 50_000, 100_000] },
  { ref: "merchant-pulsa-tri", provider: "Tri", denominations: [20_000, 50_000, 100_000] },
];

/** Prepaid electricity tokens. */
export const TOKEN_DENOMS = [20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
export const TOKEN_MERCHANT_REF = "merchant-pln-token";

/** e-Wallet destinations for a top-up from the bank account. */
export const EWALLETS = [
  { ref: "wallet-gopay", name: "GoPay", min: 10_000, max: 20_000_000 },
  { ref: "wallet-ovo", name: "OVO", min: 10_000, max: 20_000_000 },
  { ref: "wallet-dana", name: "DANA", min: 10_000, max: 20_000_000 },
  { ref: "wallet-shopeepay", name: "ShopeePay", min: 10_000, max: 20_000_000 },
];

/** Schedule frequencies for standing transfers. */
export const SCHEDULE_FREQUENCIES = [
  { code: "ONCE", name: "Sekali", days: 0 },
  { code: "WEEKLY", name: "Mingguan", days: 7 },
  { code: "MONTHLY", name: "Bulanan", days: 30 },
];

export const getNetwork = (code) => TRANSFER_NETWORKS.find((n) => n.code === code) ?? null;
export const getBank = (code) => BANKS.find((b) => b.code === code) ?? null;
export const getPulsaProduct = (ref) => PULSA_PRODUCTS.find((p) => p.ref === ref) ?? null;
export const getEwallet = (ref) => EWALLETS.find((w) => w.ref === ref) ?? null;
export const getFrequency = (code) => SCHEDULE_FREQUENCIES.find((f) => f.code === code) ?? null;
