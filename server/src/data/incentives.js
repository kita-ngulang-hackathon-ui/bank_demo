/** Presentation copy for ADA incentive codes.
 *
 * ADA returns a code plus a cost and a reason; how an offer LOOKS is the
 * bank's decision, not the engine's. Codes here mirror
 * ADA_project/fixtures/incentives.json (a provisional catalog - REQUIREMENTS
 * section 6 is still open, so unknown codes must degrade gracefully).
 */

export const INCENTIVE_COPY = {
  CASHBACK_10K: {
    title: "Cashback Rp 10.000",
    body: "Dapatkan cashback Rp 10.000 untuk pembayaran berikutnya.",
    bodyEn: "Rp 10,000 cashback on your next payment.",
    cta: "Aktifkan",
    accent: "#F26F21",
    icon: "cashback",
  },
  TRANSFER_FEE_WAIVER_30D: {
    title: "Gratis biaya transfer 30 hari",
    body: "Transfer ke bank lain tanpa biaya selama 30 hari.",
    bodyEn: "No interbank transfer fees for 30 days.",
    cta: "Klaim sekarang",
    accent: "#00857D",
    icon: "transfer",
  },
  SPLIT_BILL_GROUP_REWARD: {
    title: "Reward split bill",
    body: "Ajak circle kamu split bill dan dapatkan reward bersama.",
    bodyEn: "Reward unlocked when your circle splits a bill.",
    cta: "Ajak circle",
    accent: "#7A3FF2",
    icon: "group",
  },
  INSTALLMENT_DISCOUNT_NEXT_PURCHASE: {
    title: "Diskon cicilan",
    body: "Diskon untuk pembelian paylater berikutnya.",
    bodyEn: "Discount on your next paylater purchase.",
    cta: "Lihat detail",
    accent: "#1F6FEB",
    icon: "discount",
  },
  ONTIME_REPAYMENT_BADGE_POINTS: {
    title: "Poin bayar tepat waktu",
    body: "Poin loyalitas untuk pembayaran tepat waktu.",
    bodyEn: "Loyalty points for paying on time.",
    cta: "Lihat poin",
    accent: "#0F9D58",
    icon: "points",
  },
};

const FALLBACK = {
  cta: "Lihat penawaran",
  accent: "#F26F21",
  icon: "gift",
};

export function copyForIncentive(code) {
  const known = INCENTIVE_COPY[code];
  if (known) return known;
  return {
    ...FALLBACK,
    title: humanise(code),
    body: "Penawaran khusus untuk kamu.",
    bodyEn: "A personalised offer for you.",
  };
}

function humanise(code) {
  return String(code ?? "OFFER")
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
