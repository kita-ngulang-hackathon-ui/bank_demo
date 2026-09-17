/** One router, mounted twice.
 *
 * `/api/desktop/*` fires events with the direct API client, awaited.
 * `/api/mobile/*`  fires the same events through the SDK queue.
 *
 * Same banking logic, two integration styles - which is exactly what the demo
 * is meant to show.
 *
 * Money movements exist in two shapes here:
 *   - direct endpoints (`POST /transfer`) - used by the mobile surface, which
 *     authorises with the device instead of a token device;
 *   - prepare/confirm (`POST /tx/prepare` then `POST /tx/confirm`) - used by
 *     the desktop portal, because retail internet banking asks for a second
 *     factor before it moves money.
 * Both end in the same banking function and the same ADA event.
 */
import { Router } from "express";
import * as banking from "../banking.js";
import {
  getBalances,
  listTransactions,
  listSplits,
  listOffers,
  openSession,
  closeSession,
  markOfferClaimed,
  getOffer,
  listWire,
  getSession,
  recordLogin,
  listLoginActivity,
  getPinOverride,
  setPinOverride,
  listFavourites,
  addFavourite,
  removeFavourite,
  addSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  createChallenge,
  getChallenge,
  consumeChallenge,
  initUserLedger,
} from "../store.js";
import {
  getUser,
  getUserByUsername,
  registerUser,
  contactsFor,
  publicUser,
  BILLERS,
  MERCHANTS,
} from "../data/users.js";
import {
  BANKS,
  TRANSFER_NETWORKS,
  PULSA_PRODUCTS,
  TOKEN_DENOMS,
  EWALLETS,
  SCHEDULE_FREQUENCIES,
  getBank,
  getNetwork,
  getFrequency,
} from "../data/catalog.js";
import {
  requireSession,
  setSessionCookie,
  clearSessionCookie,
  cookieName,
  idleRemainingMs,
} from "../middleware/auth.js";
import { config } from "../config.js";

/** Small helper so a domain error becomes a clean 4xx instead of a 500. */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const known = [
        "INSUFFICIENT_FUNDS",
        "INVALID_AMOUNT",
        "LIMIT_EXCEEDED",
        "UNKNOWN_RECIPIENT",
        "INVALID_RECIPIENT",
        "UNKNOWN_PAYEE",
        "UNKNOWN_MERCHANT",
        "UNKNOWN_BANK",
        "UNKNOWN_NETWORK",
        "UNKNOWN_WALLET",
        "INVALID_ACCOUNT",
        "INVALID_MSISDN",
        "INVALID_METER",
        "NO_PARTICIPANTS",
        "ALREADY_SETTLED",
        "NOT_FOUND",
        "VALIDATION",
        "USERNAME_TAKEN",
      ];
      const code = err?.code;
      const status = code === "NOT_FOUND" ? 404 : known.includes(code) ? 400 : 500;
      if (status === 500) console.error("[surface] unhandled:", err);
      res.status(status).json({ error: code ?? "INTERNAL", message: err?.message ?? "Unexpected error" });
    }
  };
}

const idr = (value) => `Rp ${Number(value ?? 0).toLocaleString("id-ID")}`;

/**
 * Every kind of money movement the portal can confirm with a token, in one
 * table: how to describe it before it happens, and how to execute it after.
 * `execute` returns `{receipt, event}` or `{receipt, events}`.
 */
const MOVEMENTS = {
  transfer: {
    action: "transfer",
    summary: (userRef, request) => {
      const recipient = getUser(request.recipientRef);
      return {
        title: "Transfer Antar Rekening",
        lines: [
          ["Rekening tujuan", recipient ? `${recipient.name} — ${recipient.accountNumber}` : request.recipientRef],
          ["Nominal", idr(request.amount)],
          ["Biaya", "Gratis"],
          ["Berita", request.note || "-"],
        ],
        totalDebit: Number(request.amount ?? 0),
      };
    },
    execute: (userRef, request) => banking.transfer({ userRef, ...request }),
  },

  transferInterbank: {
    action: "transfer.interbank",
    summary: (userRef, request) => {
      const bank = getBank(request.bankCode);
      const network = getNetwork(request.networkCode);
      const fee = network?.fee ?? 0;
      return {
        title: "Transfer Antar Bank",
        lines: [
          ["Bank tujuan", bank?.name ?? request.bankCode],
          ["Rekening tujuan", `${request.accountNumber} — ${request.beneficiaryName || "Penerima"}`],
          ["Jenis transfer", `${network?.name ?? request.networkCode} (${network?.sla ?? "-"})`],
          ["Nominal", idr(request.amount)],
          ["Biaya", idr(fee)],
          ["Total debet", idr(Number(request.amount ?? 0) + fee)],
        ],
        totalDebit: Number(request.amount ?? 0) + fee,
      };
    },
    execute: (userRef, request) => banking.transferInterbank({ userRef, ...request }),
  },

  bill: {
    action: "bill.autopay",
    summary: (userRef, request) => {
      const biller = BILLERS.find((b) => b.ref === request.payeeRef);
      return {
        title: "Pembayaran Tagihan",
        lines: [
          ["Penyedia", biller?.name ?? request.payeeRef],
          ["Kategori", biller?.category ?? "-"],
          ["Nominal", idr(request.amount)],
        ],
        totalDebit: Number(request.amount ?? 0),
      };
    },
    execute: (userRef, request) => banking.payBill({ userRef, ...request }),
  },

  pulsa: {
    action: "purchase.pulsa",
    summary: (userRef, request) => {
      const product = PULSA_PRODUCTS.find((p) => p.ref === request.productRef);
      return {
        title: "Pembelian Pulsa",
        lines: [
          ["Provider", product?.provider ?? request.productRef],
          ["Nomor handphone", request.msisdn],
          ["Nominal", idr(request.amount)],
        ],
        totalDebit: Number(request.amount ?? 0),
      };
    },
    execute: (userRef, request) => banking.buyPulsa({ userRef, ...request }),
  },

  token: {
    action: "purchase.token",
    summary: (userRef, request) => ({
      title: "Token Listrik PLN",
      lines: [
        ["ID pelanggan / meter", request.meterNumber],
        ["Nominal", idr(request.amount)],
      ],
      totalDebit: Number(request.amount ?? 0),
    }),
    execute: (userRef, request) => banking.buyElectricityToken({ userRef, ...request }),
  },

  ewallet: {
    action: "topup.ewallet",
    summary: (userRef, request) => {
      const wallet = EWALLETS.find((w) => w.ref === request.walletRef);
      return {
        title: "Top Up e-Wallet",
        lines: [
          ["e-Wallet", wallet?.name ?? request.walletRef],
          ["Nomor terdaftar", request.phone || "-"],
          ["Nominal", idr(request.amount)],
        ],
        totalDebit: Number(request.amount ?? 0),
      };
    },
    execute: (userRef, request) => banking.topUpEwallet({ userRef, ...request }),
  },

  topup: {
    action: "topup",
    summary: (userRef, request) => ({
      title: "Top Up Saldo",
      lines: [
        ["Sumber dana", "Tabungan Berjangka"],
        ["Nominal", idr(request.amount)],
      ],
      totalDebit: 0,
    }),
    execute: (userRef, request) => banking.topUp({ userRef, ...request }),
  },

  withdraw: {
    action: "withdraw",
    summary: (userRef, request) => ({
      title: "Tarik Tunai Tanpa Kartu",
      lines: [
        ["Nominal", idr(request.amount)],
        ["Berlaku", "30 menit"],
      ],
      totalDebit: Number(request.amount ?? 0),
    }),
    execute: (userRef, request) => banking.withdraw({ userRef, ...request }),
  },

  split: {
    action: "split.create",
    summary: (userRef, request) => ({
      title: "Split Bill",
      lines: [
        ["Judul", request.title || "Split bill"],
        ["Total tagihan", idr(request.total)],
        ["Jumlah peserta", String((request.participantRefs ?? []).length + 1)],
      ],
      totalDebit: 0,
    }),
    execute: (userRef, request) => banking.splitBill({ userRef, ...request }),
  },

  splitSettle: {
    action: "split.settle",
    summary: (userRef, request) => ({
      title: "Bayar Share Split Bill",
      lines: [["Split", request.splitId]],
      totalDebit: 0,
    }),
    execute: (userRef, request) => banking.settleShare({ userRef, ...request }),
  },

  qr: {
    action: "qr.pay",
    summary: (userRef, request) => {
      const merchant = MERCHANTS.find((m) => m.ref === request.merchantRef);
      return {
        title: "Pembayaran Merchant",
        lines: [
          ["Merchant", merchant?.name ?? request.merchantRef],
          ["Nominal", idr(request.amount)],
        ],
        totalDebit: Number(request.amount ?? 0),
      };
    },
    execute: (userRef, request) => banking.payMerchant({ userRef, ...request }),
  },
};

/**
 * @param surface "desktop" | "mobile"
 * @param track   async ({eventType, userRef, payload, userAttributes, action}) => result
 */
export function makeSurfaceRouter({ surface, track }) {
  const router = Router();
  const auth = requireSession(surface);

  /** Runs a movement and sends its event(s). Shared by the direct endpoints
   *  and by the token-confirmed path so they cannot drift apart. */
  async function runMovement(kind, userRef, request) {
    const movement = MOVEMENTS[kind];
    if (!movement) {
      const err = new Error(`unknown transaction kind "${kind}"`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const result = movement.execute(userRef, request);
    const events = result.events ?? (result.event ? [result.event] : []);
    const tracked = [];
    for (const event of events) tracked.push(await track({ ...event, action: movement.action }));
    return { receipt: result.receipt, tracked: tracked.length === 1 ? tracked[0] : tracked };
  }

  // -- session ------------------------------------------------------------

  /** Shared by /session and /register: issue the cookie, log the login, and
   *  fire the wallet.app.opened event (activity dips are one of the signals
   *  the pipeline looks for, so a first-time login is an event too). */
  async function startSession(req, res, user) {
    const token = openSession(user.ref, surface);
    setSessionCookie(res, surface, token);
    recordLogin(user.ref, {
      surface,
      ip: req.ip,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 120),
    });

    const { event } = banking.sessionOpen({ userRef: user.ref, surface });
    const tracked = await track({ ...event, action: "session.open" });

    return { user: publicUser(user), balances: getBalances(user.ref), tracked };
  }

  router.post(
    "/session",
    handle(async (req, res) => {
      const { username, pin } = req.body ?? {};
      const user = getUserByUsername(String(username ?? "").trim().toLowerCase());
      const expectedPin = user ? getPinOverride(user.ref) ?? user.pin : null;
      if (!user || String(pin ?? "") !== expectedPin) {
        return res.status(401).json({ error: "BAD_CREDENTIALS", message: "User ID atau PIN salah." });
      }
      res.json(await startSession(req, res, user));
    })
  );

  /** New demo customer, self-service. Creates the account with a starter
   *  balance, then signs them straight in - same response shape as
   *  /session, so the frontend doesn't need a separate success path. */
  router.post(
    "/register",
    handle(async (req, res) => {
      const { name, username, pin, confirmPin } = req.body ?? {};
      if (String(pin ?? "") !== String(confirmPin ?? "")) {
        return res.status(400).json({ error: "VALIDATION", message: "Konfirmasi PIN tidak cocok." });
      }
      const user = registerUser({ name, username, pin });
      initUserLedger(user.ref, { checking: user.balance, savings: user.savingsBalance });
      res.json(await startSession(req, res, user));
    })
  );

  router.delete("/session", (req, res) => {
    closeSession(req.cookies?.[cookieName(surface)]);
    clearSessionCookie(res, surface);
    res.json({ ok: true });
  });

  router.get("/session", (req, res) => {
    const session = getSession(req.cookies?.[cookieName(surface)]);
    if (!session || session.surface !== surface) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
    const remainingMs = idleRemainingMs(session);
    if (remainingMs === 0) return res.status(401).json({ error: "SESSION_EXPIRED" });
    res.json({
      user: publicUser(getUser(session.userRef)),
      startedAt: session.startedAt,
      remainingMs,
      idleTimeoutMs: config.session.idleTimeoutMs,
    });
  });

  /** Keeps the session alive without performing an action - the "extend
   *  session" button on the countdown dialog. */
  router.post("/session/extend", auth, (req, res) => {
    res.json({ remainingMs: config.session.idleTimeoutMs });
  });

  // -- read models --------------------------------------------------------

  router.get(
    "/home",
    auth,
    handle(async (req, res) => {
      const user = getUser(req.userRef);
      const session = req.session;
      res.json({
        user: publicUser(user),
        balances: getBalances(req.userRef),
        transactions: listTransactions(req.userRef, 15),
        splits: listSplits(req.userRef),
        offers: listOffers(req.userRef),
        contacts: contactsFor(req.userRef),
        favourites: listFavourites(req.userRef),
        schedules: listSchedules(req.userRef),
        billers: BILLERS,
        merchants: MERCHANTS,
        catalog: {
          banks: BANKS,
          networks: TRANSFER_NETWORKS,
          pulsa: PULSA_PRODUCTS,
          tokenDenoms: TOKEN_DENOMS,
          ewallets: EWALLETS,
          frequencies: SCHEDULE_FREQUENCIES,
        },
        loginActivity: listLoginActivity(req.userRef),
        session: {
          startedAt: session.startedAt,
          remainingMs: idleRemainingMs(session),
          idleTimeoutMs: config.session.idleTimeoutMs,
        },
        wire: listWire({ limit: 12, userRef: req.userRef }),
      });
    })
  );

  router.get("/transactions", auth, (req, res) => {
    res.json({ items: listTransactions(req.userRef, Number(req.query.limit ?? 30)) });
  });

  router.get("/contacts", auth, (req, res) => res.json({ items: contactsFor(req.userRef) }));

  router.get("/offers", auth, (req, res) => res.json({ items: listOffers(req.userRef) }));

  /** Account statement with the filters a portal offers: period, direction
   *  and free-text search. */
  router.get("/statement", auth, (req, res) => {
    const { from, to, direction, q } = req.query;
    const items = filterStatement(listTransactions(req.userRef, 500), { from, to, direction, q });
    const summary = items.reduce(
      (acc, tx) => {
        if (tx.direction === "credit") acc.credit += tx.amount;
        if (tx.direction === "debit") acc.debit += tx.amount + (tx.fee ?? 0);
        return acc;
      },
      { credit: 0, debit: 0 }
    );
    res.json({ items, summary, count: items.length, balances: getBalances(req.userRef) });
  });

  /** Same filter, as a CSV download. */
  router.get("/statement.csv", auth, (req, res) => {
    const { from, to, direction, q } = req.query;
    const items = filterStatement(listTransactions(req.userRef, 500), { from, to, direction, q });
    const header = "reference,datetime,kind,direction,counterparty,note,amount,fee\n";
    const rows = items
      .map((tx) =>
        [
          tx.reference,
          tx.at,
          tx.kind,
          tx.direction,
          csvCell(tx.counterpartyName ?? ""),
          csvCell(tx.note ?? ""),
          tx.amount,
          tx.fee ?? 0,
        ].join(",")
      )
      .join("\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="mutasi-${req.userRef}.csv"`);
    res.send(header + rows + "\n");
  });

  // -- two-step transactions (desktop) ------------------------------------

  /** Step 1: describe the transaction and issue a token challenge. No money
   *  moves here, and nothing is sent to ADA. */
  router.post(
    "/tx/prepare",
    auth,
    handle(async (req, res) => {
      const { kind, request } = req.body ?? {};
      const movement = MOVEMENTS[kind];
      if (!movement) return res.status(400).json({ error: "UNKNOWN_KIND", message: `Unknown kind "${kind}"` });

      const summary = movement.summary(req.userRef, request ?? {});
      const balances = getBalances(req.userRef);
      if (summary.totalDebit > balances.checking) {
        return res.status(400).json({
          error: "INSUFFICIENT_FUNDS",
          message: "Saldo tidak mencukupi untuk transaksi ini.",
        });
      }

      const challenge = createChallenge({ userRef: req.userRef, kind, request: request ?? {}, summary });
      res.json({
        challengeId: challenge.id,
        challengeNumber: challenge.challengeNumber,
        expiresAt: challenge.expiresAt,
        summary,
        // Only a demo build hands the expected code to the browser.
        token: config.session.showToken ? challenge.token : undefined,
      });
    })
  );

  /** Step 2: verify the token, then execute and send the ADA event. */
  router.post(
    "/tx/confirm",
    auth,
    handle(async (req, res) => {
      const { challengeId, token } = req.body ?? {};
      const challenge = getChallenge(challengeId);
      if (!challenge || challenge.userRef !== req.userRef) {
        return res.status(400).json({
          error: "CHALLENGE_EXPIRED",
          message: "Kode konfirmasi sudah tidak berlaku. Ulangi transaksi.",
        });
      }

      if (String(token ?? "").trim() !== challenge.token) {
        challenge.attempts += 1;
        if (challenge.attempts >= 3) {
          consumeChallenge(challengeId);
          return res.status(400).json({
            error: "CHALLENGE_LOCKED",
            message: "Kode salah 3 kali. Transaksi dibatalkan.",
          });
        }
        return res.status(400).json({
          error: "BAD_TOKEN",
          message: `Kode konfirmasi salah. Sisa percobaan: ${3 - challenge.attempts}.`,
        });
      }

      // Consume first: a token is single-use even if execution then fails.
      consumeChallenge(challengeId);
      const result = await runMovement(challenge.kind, req.userRef, challenge.request);
      res.json({ ...result, kind: challenge.kind, summary: challenge.summary });
    })
  );

  // -- money movements (direct, used by the mobile surface) ---------------

  const direct = (path, kind, mapBody = (body) => body) =>
    router.post(
      path,
      auth,
      handle(async (req, res) => {
        const result = await runMovement(kind, req.userRef, mapBody(req.body ?? {}, req));
        res.json(result);
      })
    );

  direct("/transfer", "transfer");
  direct("/transfer/interbank", "transferInterbank");
  direct("/split", "split");
  direct("/bill", "bill");
  direct("/topup", "topup");
  direct("/topup/ewallet", "ewallet");
  direct("/purchase/pulsa", "pulsa");
  direct("/purchase/token", "token");
  direct("/qr", "qr");
  direct("/withdraw", "withdraw");

  router.post(
    "/split/:splitId/settle",
    auth,
    handle(async (req, res) => {
      const result = await runMovement("splitSettle", req.userRef, { splitId: req.params.splitId });
      res.json(result);
    })
  );

  // -- saved beneficiaries ------------------------------------------------

  router.get("/favourites", auth, (req, res) => res.json({ items: listFavourites(req.userRef) }));

  router.post(
    "/favourites",
    auth,
    handle(async (req, res) => {
      const { alias, accountNumber, beneficiaryName, bankCode, userRef: targetRef } = req.body ?? {};
      if (!accountNumber && !targetRef) {
        return res.status(400).json({ error: "VALIDATION", message: "Nomor rekening wajib diisi." });
      }
      const target = targetRef ? getUser(targetRef) : null;
      const row = addFavourite(req.userRef, {
        alias: alias || target?.name || beneficiaryName || "Penerima",
        accountNumber: target?.accountNumber ?? String(accountNumber),
        beneficiaryName: target?.name ?? beneficiaryName ?? "Penerima",
        bankCode: target ? null : bankCode ?? null,
        bankName: target ? config.brand.bankName : getBank(bankCode)?.name ?? null,
        targetRef: target?.ref ?? null,
      });
      res.json({ favourite: row });
    })
  );

  router.delete("/favourites/:id", auth, (req, res) => {
    const removed = removeFavourite(req.userRef, req.params.id);
    if (!removed) return res.status(404).json({ error: "NOT_FOUND" });
    res.json({ ok: true });
  });

  // -- scheduled transfers ------------------------------------------------

  router.get("/schedules", auth, (req, res) => res.json({ items: listSchedules(req.userRef) }));

  router.post(
    "/schedules",
    auth,
    handle(async (req, res) => {
      const { recipientRef, amount, note, frequency, startDate } = req.body ?? {};
      const recipient = getUser(recipientRef);
      if (!recipient) return res.status(400).json({ error: "UNKNOWN_RECIPIENT", message: "Penerima tidak dikenal." });
      const freq = getFrequency(frequency);
      if (!freq) return res.status(400).json({ error: "VALIDATION", message: "Frekuensi tidak dikenal." });
      const value = Number(amount);
      if (!Number.isFinite(value) || value < 10_000) {
        return res.status(400).json({ error: "INVALID_AMOUNT", message: "Minimum Rp 10.000." });
      }

      const row = addSchedule({
        userRef: req.userRef,
        recipientRef,
        recipientName: recipient.name,
        amount: value,
        note: note ?? "Transfer terjadwal",
        frequency: freq.code,
        frequencyName: freq.name,
        nextRunAt: startDate ? new Date(startDate).toISOString() : new Date(Date.now() + 86_400_000).toISOString(),
      });
      res.json({ schedule: row });
    })
  );

  router.delete("/schedules/:id", auth, (req, res) => {
    const row = getSchedule(req.params.id);
    if (!row || row.userRef !== req.userRef) return res.status(404).json({ error: "NOT_FOUND" });
    updateSchedule(row.id, { status: "CANCELLED" });
    res.json({ ok: true });
  });

  /** Executes a standing instruction immediately. Useful on stage: it proves
   *  a scheduled transfer produces the same ADA event as a manual one. */
  router.post(
    "/schedules/:id/run",
    auth,
    handle(async (req, res) => {
      const row = getSchedule(req.params.id);
      if (!row || row.userRef !== req.userRef) return res.status(404).json({ error: "NOT_FOUND" });
      if (row.status !== "ACTIVE") {
        return res.status(400).json({ error: "VALIDATION", message: "Jadwal tidak aktif." });
      }

      const result = await runMovement("transfer", req.userRef, {
        recipientRef: row.recipientRef,
        amount: row.amount,
        note: row.note,
      });

      const freq = getFrequency(row.frequency);
      updateSchedule(row.id, {
        runCount: row.runCount + 1,
        lastRunAt: new Date().toISOString(),
        status: freq.days === 0 ? "COMPLETED" : "ACTIVE",
        nextRunAt:
          freq.days === 0
            ? row.nextRunAt
            : new Date(Date.now() + freq.days * 86_400_000).toISOString(),
      });

      res.json({ ...result, schedule: getSchedule(row.id) });
    })
  );

  // -- profile / administration -------------------------------------------

  router.get("/profile", auth, (req, res) => {
    const user = getUser(req.userRef);
    res.json({
      user: publicUser(user),
      loginActivity: listLoginActivity(req.userRef),
      pinChanged: Boolean(getPinOverride(req.userRef)),
    });
  });

  router.post(
    "/profile/pin",
    auth,
    handle(async (req, res) => {
      const { currentPin, newPin, confirmPin } = req.body ?? {};
      const user = getUser(req.userRef);
      const expected = getPinOverride(req.userRef) ?? user.pin;
      if (String(currentPin ?? "") !== expected) {
        return res.status(400).json({ error: "BAD_CREDENTIALS", message: "PIN saat ini salah." });
      }
      if (!/^\d{6}$/.test(String(newPin ?? ""))) {
        return res.status(400).json({ error: "VALIDATION", message: "PIN baru harus 6 digit angka." });
      }
      if (newPin !== confirmPin) {
        return res.status(400).json({ error: "VALIDATION", message: "Konfirmasi PIN tidak cocok." });
      }
      if (newPin === expected) {
        return res.status(400).json({ error: "VALIDATION", message: "PIN baru harus berbeda." });
      }
      setPinOverride(req.userRef, String(newPin));
      res.json({ ok: true });
    })
  );

  // -- offers -------------------------------------------------------------

  /** Claiming is a bank-side action. ADA hears about it as an outcome only
   *  once an experiment id is known, which a recommendation payload does not
   *  currently carry - see /api/demo/outcome for the manual path. */
  router.post(
    "/offers/:id/claim",
    auth,
    handle(async (req, res) => {
      const offer = getOffer(req.params.id);
      if (!offer) return res.status(404).json({ error: "NOT_FOUND", message: "Offer not found" });
      const claimed = markOfferClaimed(req.params.id, req.userRef);
      res.json({ offer: claimed });
    })
  );

  return router;
}

// -- helpers ----------------------------------------------------------------

function filterStatement(items, { from, to, direction, q }) {
  const fromTime = from ? Date.parse(`${from}T00:00:00`) : null;
  const toTime = to ? Date.parse(`${to}T23:59:59`) : null;
  const needle = q ? String(q).toLowerCase() : null;

  return items.filter((tx) => {
    const at = Date.parse(tx.at);
    if (fromTime && at < fromTime) return false;
    if (toTime && at > toTime) return false;
    if (direction && direction !== "all" && tx.direction !== direction) return false;
    if (needle) {
      const haystack = `${tx.counterpartyName ?? ""} ${tx.note ?? ""} ${tx.kind} ${tx.reference ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;
