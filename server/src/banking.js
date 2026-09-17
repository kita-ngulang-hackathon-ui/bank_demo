/** The bank's own domain logic.
 *
 * Each function moves money in the local ledger and returns BOTH a receipt for
 * the UI and the ADA event that describes what happened. The route decides how
 * that event travels (desktop: direct API call; mobile: SDK queue), so the two
 * surfaces share one definition of "what a transfer is".
 *
 * Money never depends on the analytics call: every function here completes
 * before any ADA code runs.
 */
import { EVENT_TYPES } from "@bank-demo/ada-sdk";
import {
  adjustBalance,
  recordTransaction,
  createSplit,
  settleSplit,
  getSplit,
} from "./store.js";
import { getUser, getBiller, getMerchant } from "./data/users.js";
import {
  getNetwork,
  getBank,
  getPulsaProduct,
  getEwallet,
  TOKEN_MERCHANT_REF,
} from "./data/catalog.js";

const IDR = (n) => Math.round(Number(n));

function requireAmount(amount, { min = 1000, max = 100_000_000 } = {}) {
  const value = IDR(amount);
  if (!Number.isFinite(value) || value < min) {
    const err = new Error(`Minimum amount is Rp ${min.toLocaleString("id-ID")}`);
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  if (value > max) {
    const err = new Error(`Maximum amount is Rp ${max.toLocaleString("id-ID")}`);
    err.code = "LIMIT_EXCEEDED";
    throw err;
  }
  return value;
}

/** P2P transfer. Both sides move, because the counterparty is also a demo
 *  user - that symmetry is what gives ADA's graph a real edge. */
export function transfer({ userRef, recipientRef, amount, note }) {
  const sender = getUser(userRef);
  const recipient = getUser(recipientRef);
  if (!sender) throw new Error("unknown sender");
  if (!recipient) {
    const err = new Error("Rekening tujuan tidak ditemukan / recipient not found");
    err.code = "UNKNOWN_RECIPIENT";
    throw err;
  }
  if (recipientRef === userRef) {
    const err = new Error("Cannot transfer to yourself");
    err.code = "INVALID_RECIPIENT";
    throw err;
  }

  const value = requireAmount(amount);
  const balances = adjustBalance(userRef, "checking", -value);
  adjustBalance(recipientRef, "checking", value);

  const tx = recordTransaction(userRef, {
    kind: "TRANSFER_OUT",
    direction: "debit",
    amount: value,
    counterpartyRef: recipientRef,
    counterpartyName: recipient.name,
    note: note ?? "Transfer",
  });
  recordTransaction(recipientRef, {
    kind: "TRANSFER_IN",
    direction: "credit",
    amount: value,
    counterpartyRef: userRef,
    counterpartyName: sender.name,
    note: note ?? "Transfer",
  });

  return {
    receipt: { ...tx, balances, recipient: { ref: recipient.ref, name: recipient.name, accountNumber: recipient.accountNumber } },
    event: {
      eventType: EVENT_TYPES.TRANSFER_SENT,
      userRef,
      payload: { amount: value, recipient_ref: recipientRef, note: note ?? null },
      userAttributes: sender.attributes,
    },
  };
}

/** Split bill creation. The owner fronts the whole amount; participants owe a
 *  share until they settle. One event per participant, so every edge in the
 *  circle is visible to ADA rather than one event with a list. */
export function splitBill({ userRef, title, total, participantRefs }) {
  const owner = getUser(userRef);
  if (!owner) throw new Error("unknown user");
  const participants = (participantRefs ?? []).filter((ref) => ref !== userRef && getUser(ref));
  if (participants.length === 0) {
    const err = new Error("Pick at least one person to split with");
    err.code = "NO_PARTICIPANTS";
    throw err;
  }
  const value = requireAmount(total);

  const split = createSplit({ ownerRef: userRef, title: title || "Split bill", total: value, participantRefs: participants });

  recordTransaction(userRef, {
    kind: "SPLIT_CREATED",
    direction: "info",
    amount: value,
    counterpartyName: `${participants.length} orang`,
    note: split.title,
    splitId: split.id,
  });

  return {
    receipt: split,
    events: participants.map((ref) => ({
      eventType: EVENT_TYPES.SPLIT_CREATED,
      userRef,
      payload: { total: value, share: split.share, split_with_ref: ref, split_id: split.id, title: split.title },
      userAttributes: owner.attributes,
    })),
  };
}

/** A participant pays their share back to the owner. */
export function settleShare({ userRef, splitId }) {
  const payer = getUser(userRef);
  if (!payer) throw new Error("unknown user");
  const existing = getSplit(splitId);
  if (!existing) {
    const err = new Error("Split not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const { split, participant } = settleSplit(splitId, userRef);
  adjustBalance(userRef, "checking", -participant.share);
  const balances = adjustBalance(split.ownerRef, "checking", participant.share);

  const owner = getUser(split.ownerRef);
  const tx = recordTransaction(userRef, {
    kind: "SPLIT_SETTLED",
    direction: "debit",
    amount: participant.share,
    counterpartyRef: split.ownerRef,
    counterpartyName: owner?.name ?? split.ownerRef,
    note: split.title,
    splitId: split.id,
  });
  recordTransaction(split.ownerRef, {
    kind: "SPLIT_RECEIVED",
    direction: "credit",
    amount: participant.share,
    counterpartyRef: userRef,
    counterpartyName: payer.name,
    note: split.title,
    splitId: split.id,
  });

  return {
    receipt: { ...tx, split, ownerBalances: balances },
    event: {
      eventType: EVENT_TYPES.SPLIT_SETTLED,
      userRef,
      payload: { share: participant.share, total: split.total, split_with_ref: split.ownerRef, split_id: split.id },
      userAttributes: payer.attributes,
    },
  };
}

/** Recurring bill. `payee_ref` is the biller, which ADA maps as the
 *  counterparty for RECURRING_PAYMENT. */
export function payBill({ userRef, payeeRef, amount, auto = true }) {
  const user = getUser(userRef);
  const biller = getBiller(payeeRef);
  if (!user) throw new Error("unknown user");
  if (!biller) {
    const err = new Error("Biller not found");
    err.code = "UNKNOWN_PAYEE";
    throw err;
  }

  const value = requireAmount(amount ?? biller.defaultAmount, { min: 1_000 });
  const balances = adjustBalance(userRef, "checking", -value);

  const tx = recordTransaction(userRef, {
    kind: "BILL_PAYMENT",
    direction: "debit",
    amount: value,
    counterpartyRef: biller.ref,
    counterpartyName: biller.name,
    note: `${biller.category} - ${auto ? "autodebet" : "manual"}`,
  });

  return {
    receipt: { ...tx, balances, biller },
    event: {
      eventType: EVENT_TYPES.BILL_AUTOPAY,
      userRef,
      payload: { amount: value, payee_ref: biller.ref, category: biller.category, auto },
      userAttributes: user.attributes,
    },
  };
}

/** Top-up moves money from savings into the spending pocket - it keeps the
 *  demo self-contained without inventing an external funding source. */
export function topUp({ userRef, amount, source = "savings" }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");
  const value = requireAmount(amount, { min: 10_000 });

  if (source === "savings") adjustBalance(userRef, "savings", -value);
  const balances = adjustBalance(userRef, "checking", value);

  const tx = recordTransaction(userRef, {
    kind: "TOPUP",
    direction: "credit",
    amount: value,
    counterpartyName: source === "savings" ? "Tabungan" : "Kartu debit",
    note: "Top up saldo",
  });

  return {
    receipt: { ...tx, balances },
    event: {
      eventType: EVENT_TYPES.TOPUP_COMPLETED,
      userRef,
      payload: { amount: value, source },
      userAttributes: user.attributes,
    },
  };
}

/** QRIS / merchant payment. */
export function payMerchant({ userRef, merchantRef, amount }) {
  const user = getUser(userRef);
  const merchant = getMerchant(merchantRef);
  if (!user) throw new Error("unknown user");
  if (!merchant) {
    const err = new Error("Merchant not found");
    err.code = "UNKNOWN_MERCHANT";
    throw err;
  }

  const value = requireAmount(amount ?? merchant.typicalAmount, { min: 1_000 });
  const balances = adjustBalance(userRef, "checking", -value);

  const tx = recordTransaction(userRef, {
    kind: "QR_PAYMENT",
    direction: "debit",
    amount: value,
    counterpartyRef: merchant.ref,
    counterpartyName: merchant.name,
    note: merchant.category,
  });

  return {
    receipt: { ...tx, balances, merchant },
    event: {
      eventType: EVENT_TYPES.PAYMENT_MERCHANT,
      userRef,
      payload: { amount: value, merchant_ref: merchant.ref, category: merchant.category },
      userAttributes: user.attributes,
    },
  };
}

/** Cardless cash withdrawal. */
export function withdraw({ userRef, amount, atmRef = "atm-sudirman-01" }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");
  const value = requireAmount(amount, { min: 50_000, max: 10_000_000 });
  const balances = adjustBalance(userRef, "checking", -value);

  const tx = recordTransaction(userRef, {
    kind: "WITHDRAWAL",
    direction: "debit",
    amount: value,
    counterpartyName: "Tarik tunai tanpa kartu",
    note: atmRef,
  });

  return {
    receipt: { ...tx, balances, code: String(Math.floor(100000 + Math.random() * 900000)) },
    event: {
      eventType: EVENT_TYPES.WITHDRAW_COMPLETED,
      userRef,
      payload: { amount: value, atm_ref: atmRef },
      userAttributes: user.attributes,
    },
  };
}

/** Transfer to an account at another bank.
 *
 * The beneficiary is outside the demo population, so the counterparty ref is
 * synthesised from bank code + account number. It is still a stable edge: two
 * transfers to the same outside account are the same counterparty to ADA,
 * which is what the graph stage needs.
 */
export function transferInterbank({ userRef, bankCode, accountNumber, beneficiaryName, amount, networkCode, note }) {
  const sender = getUser(userRef);
  if (!sender) throw new Error("unknown sender");

  const bank = getBank(bankCode);
  if (!bank) {
    const err = new Error("Bank tujuan tidak dikenal / unknown destination bank");
    err.code = "UNKNOWN_BANK";
    throw err;
  }

  const network = getNetwork(networkCode);
  if (!network) {
    const err = new Error("Jenis transfer tidak dikenal / unknown transfer network");
    err.code = "UNKNOWN_NETWORK";
    throw err;
  }

  const account = String(accountNumber ?? "").replace(/\D/g, "");
  if (account.length < 8) {
    const err = new Error("Nomor rekening tujuan minimal 8 digit");
    err.code = "INVALID_ACCOUNT";
    throw err;
  }

  const value = requireAmount(amount, { max: network.limit });
  if (network.minAmount && value < network.minAmount) {
    const err = new Error(
      `${network.name} minimum Rp ${network.minAmount.toLocaleString("id-ID")}`
    );
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  // Fee and principal leave the account together, as they do on a real
  // transfer - the receipt shows both lines.
  const balances = adjustBalance(userRef, "checking", -(value + network.fee));
  const counterpartyRef = `ext-${bank.code}-${account}`;

  const tx = recordTransaction(userRef, {
    kind: "TRANSFER_INTERBANK",
    direction: "debit",
    amount: value,
    fee: network.fee,
    counterpartyRef,
    counterpartyName: `${beneficiaryName || "Penerima"} · ${bank.name}`,
    note: note ?? network.name,
    network: network.code,
  });

  return {
    receipt: {
      ...tx,
      balances,
      bank,
      network,
      accountNumber: account,
      beneficiaryName: beneficiaryName || "Penerima",
      total: value + network.fee,
    },
    event: {
      eventType: EVENT_TYPES.TRANSFER_SENT,
      userRef,
      payload: {
        amount: value,
        recipient_ref: counterpartyRef,
        fee: network.fee,
        network: network.code,
        destination_bank: bank.code,
      },
      userAttributes: sender.attributes,
    },
  };
}

/** Prepaid airtime. Sold as a merchant payment, which is what it is. */
export function buyPulsa({ userRef, productRef, msisdn, amount }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");

  const product = getPulsaProduct(productRef);
  if (!product) {
    const err = new Error("Provider tidak dikenal");
    err.code = "UNKNOWN_MERCHANT";
    throw err;
  }

  const number = String(msisdn ?? "").replace(/\D/g, "");
  if (number.length < 9) {
    const err = new Error("Nomor handphone tidak valid");
    err.code = "INVALID_MSISDN";
    throw err;
  }

  const value = requireAmount(amount, { min: 5_000, max: 1_000_000 });
  const balances = adjustBalance(userRef, "checking", -value);

  const tx = recordTransaction(userRef, {
    kind: "PULSA_PURCHASE",
    direction: "debit",
    amount: value,
    counterpartyRef: product.ref,
    counterpartyName: `${product.provider} · ${number}`,
    note: "Pembelian pulsa",
  });

  return {
    receipt: { ...tx, balances, product, msisdn: number },
    event: {
      eventType: EVENT_TYPES.PAYMENT_MERCHANT,
      userRef,
      payload: { amount: value, merchant_ref: product.ref, category: "PULSA" },
      userAttributes: user.attributes,
    },
  };
}

/** Prepaid electricity token. */
export function buyElectricityToken({ userRef, meterNumber, amount }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");

  const meter = String(meterNumber ?? "").replace(/\D/g, "");
  if (meter.length < 11) {
    const err = new Error("Nomor meter/ID pelanggan minimal 11 digit");
    err.code = "INVALID_METER";
    throw err;
  }

  const value = requireAmount(amount, { min: 20_000, max: 5_000_000 });
  const balances = adjustBalance(userRef, "checking", -value);

  // The token a real purchase returns; 20 digits in four groups.
  const token = Array.from({ length: 4 }, () =>
    String(Math.floor(10_000 + Math.random() * 89_999))
  ).join("-");

  const tx = recordTransaction(userRef, {
    kind: "PLN_TOKEN",
    direction: "debit",
    amount: value,
    counterpartyRef: TOKEN_MERCHANT_REF,
    counterpartyName: `PLN Prabayar · ${meter}`,
    note: "Token listrik",
  });

  return {
    receipt: { ...tx, balances, meterNumber: meter, token },
    event: {
      eventType: EVENT_TYPES.PAYMENT_MERCHANT,
      userRef,
      payload: { amount: value, merchant_ref: TOKEN_MERCHANT_REF, category: "ELECTRICITY_TOKEN" },
      userAttributes: user.attributes,
    },
  };
}

/** Top up an external e-wallet from the bank account. Money leaves the bank,
 *  so it debits here even though ADA sees it as a wallet top-up. */
export function topUpEwallet({ userRef, walletRef, phone, amount }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");

  const wallet = getEwallet(walletRef);
  if (!wallet) {
    const err = new Error("e-Wallet tidak dikenal");
    err.code = "UNKNOWN_WALLET";
    throw err;
  }

  const value = requireAmount(amount, { min: wallet.min, max: wallet.max });
  const balances = adjustBalance(userRef, "checking", -value);

  const tx = recordTransaction(userRef, {
    kind: "EWALLET_TOPUP",
    direction: "debit",
    amount: value,
    counterpartyRef: wallet.ref,
    counterpartyName: `${wallet.name}${phone ? ` · ${phone}` : ""}`,
    note: "Top up e-wallet",
  });

  return {
    receipt: { ...tx, balances, wallet },
    event: {
      eventType: EVENT_TYPES.TOPUP_COMPLETED,
      userRef,
      payload: { amount: value, source: "BANK_ACCOUNT", wallet_ref: wallet.ref },
      userAttributes: user.attributes,
    },
  };
}

/** Session open - the only event with no money attached. */
export function sessionOpen({ userRef, surface }) {
  const user = getUser(userRef);
  if (!user) throw new Error("unknown user");
  return {
    event: {
      eventType: EVENT_TYPES.APP_OPENED,
      userRef,
      payload: { surface, channel: surface === "desktop" ? "INTERNET_BANKING" : "MOBILE_APP" },
      userAttributes: user.attributes,
    },
  };
}
