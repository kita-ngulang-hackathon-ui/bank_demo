/** In-memory state for the demo bank.
 *
 * A hackathon demo does not need durability - it needs a `reset` that puts
 * the stage back exactly as it started. Restarting the process is the reset.
 * The one thing that IS durable is what we sent to ADA, because that lives in
 * ADA's database, not here.
 */
import { randomUUID } from "node:crypto";
import { USERS, getUser } from "./data/users.js";

const MAX_WIRE_LOG = 300;

const state = {
  balances: new Map(),
  transactions: new Map(), // userRef -> [tx]
  splits: new Map(), // splitId -> split
  sessions: new Map(), // token -> {userRef, surface, startedAt, lastSeenAt}
  wireLog: [], // newest first
  offers: new Map(), // recommendationId -> offer
  favourites: new Map(), // userRef -> [favourite]
  scheduled: new Map(), // scheduleId -> schedule
  pending: new Map(), // challengeId -> pending transaction
  loginActivity: new Map(), // userRef -> [entry]
  pinOverrides: new Map(), // userRef -> pin
};

function seed() {
  state.balances.clear();
  state.transactions.clear();
  for (const user of USERS) {
    state.balances.set(user.ref, { checking: user.balance, savings: user.savingsBalance });
    state.transactions.set(user.ref, []);
  }
}
seed();

/** Initialises ledger state for a user created after startup (registration),
 *  without touching anyone else's balances or history. */
export function initUserLedger(ref, { checking = 0, savings = 0 } = {}) {
  if (!state.balances.has(ref)) state.balances.set(ref, { checking, savings });
  if (!state.transactions.has(ref)) state.transactions.set(ref, []);
}

// -- sessions ---------------------------------------------------------------

export function openSession(userRef, surface) {
  const token = randomUUID();
  const now = new Date().toISOString();
  state.sessions.set(token, { userRef, surface, startedAt: now, lastSeenAt: now });
  return token;
}

export const getSession = (token) => (token ? state.sessions.get(token) ?? null : null);
export const closeSession = (token) => state.sessions.delete(token);

/** Idle timeout is what a real internet-banking session enforces, so the demo
 *  does too. Every authenticated request pushes the clock forward. */
export function touchSession(token) {
  const session = state.sessions.get(token);
  if (session) session.lastSeenAt = new Date().toISOString();
  return session ?? null;
}

export function recordLogin(userRef, entry) {
  if (!state.loginActivity.has(userRef)) state.loginActivity.set(userRef, []);
  const list = state.loginActivity.get(userRef);
  list.unshift({ at: new Date().toISOString(), ...entry });
  if (list.length > 20) list.length = 20;
  return list[0];
}

export const listLoginActivity = (userRef) => state.loginActivity.get(userRef) ?? [];

// -- credentials ------------------------------------------------------------

export const getPinOverride = (userRef) => state.pinOverrides.get(userRef) ?? null;
export const setPinOverride = (userRef, pin) => state.pinOverrides.set(userRef, pin);

// -- money ------------------------------------------------------------------

export function getBalances(userRef) {
  return state.balances.get(userRef) ?? { checking: 0, savings: 0 };
}

/** Applies a signed delta to a pocket. Returns the new balances, or throws
 *  when the account cannot cover it - the banking rule is enforced before any
 *  analytics call, never after. */
export function adjustBalance(userRef, pocket, delta) {
  const balances = state.balances.get(userRef);
  if (!balances) throw new Error(`unknown user ${userRef}`);
  const next = balances[pocket] + delta;
  if (next < 0) {
    const err = new Error("Saldo tidak mencukupi / insufficient balance");
    err.code = "INSUFFICIENT_FUNDS";
    throw err;
  }
  balances[pocket] = next;
  return { ...balances };
}

/** Reference number printed on the receipt. Format mirrors what a retail
 *  portal shows: date plus a short sequence. */
let referenceSeq = 1;
function nextReference() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `${stamp}${String(referenceSeq++).padStart(6, "0")}`;
}

export function recordTransaction(userRef, tx) {
  const row = {
    id: randomUUID(),
    at: new Date().toISOString(),
    reference: nextReference(),
    ...tx,
  };
  const list = state.transactions.get(userRef);
  if (list) list.unshift(row);
  return row;
}

export function listTransactions(userRef, limit = 25) {
  return (state.transactions.get(userRef) ?? []).slice(0, limit);
}

// -- split bills ------------------------------------------------------------

export function createSplit({ ownerRef, title, total, participantRefs }) {
  const share = Math.round(total / (participantRefs.length + 1));
  const split = {
    id: randomUUID(),
    ownerRef,
    title,
    total,
    share,
    createdAt: new Date().toISOString(),
    participants: participantRefs.map((ref) => ({
      ref,
      name: getUser(ref)?.name ?? ref,
      share,
      settled: false,
      settledAt: null,
    })),
  };
  state.splits.set(split.id, split);
  return split;
}

export const getSplit = (id) => state.splits.get(id) ?? null;

export function listSplits(userRef) {
  return [...state.splits.values()]
    .filter((s) => s.ownerRef === userRef || s.participants.some((p) => p.ref === userRef))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function settleSplit(splitId, participantRef) {
  const split = state.splits.get(splitId);
  if (!split) throw new Error("split not found");
  const participant = split.participants.find((p) => p.ref === participantRef);
  if (!participant) throw new Error("not a participant of this split");
  if (participant.settled) {
    const err = new Error("share already settled");
    err.code = "ALREADY_SETTLED";
    throw err;
  }
  participant.settled = true;
  participant.settledAt = new Date().toISOString();
  return { split, participant };
}

// -- wire log (what the audience watches) -----------------------------------

/** One row per event we hand to ADA, with how it went. The demo screen tails
 *  this, so a failed send is visible instead of silent. */
export function logWire(entry) {
  const row = {
    id: randomUUID(),
    at: new Date().toISOString(),
    status: "PENDING",
    ...entry,
  };
  state.wireLog.unshift(row);
  if (state.wireLog.length > MAX_WIRE_LOG) state.wireLog.length = MAX_WIRE_LOG;
  return row;
}

export function updateWire(id, patch) {
  const row = state.wireLog.find((r) => r.id === id);
  if (row) Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  return row ?? null;
}

export function listWire({ limit = 60, userRef, surface } = {}) {
  return state.wireLog
    .filter((r) => (userRef ? r.userRef === userRef : true))
    .filter((r) => (surface ? r.surface === surface : true))
    .slice(0, limit);
}

export function wireStats() {
  const counts = { total: state.wireLog.length, sent: 0, failed: 0, pending: 0, duplicate: 0 };
  for (const row of state.wireLog) {
    if (row.status === "SENT") counts.sent += 1;
    else if (row.status === "FAILED") counts.failed += 1;
    else if (row.status === "DUPLICATE") counts.duplicate += 1;
    else counts.pending += 1;
  }
  return counts;
}

// -- offers (recommendations pulled back from ADA) --------------------------

export function upsertOffer(offer) {
  const existing = state.offers.get(offer.recommendationId);
  const merged = { ...existing, ...offer, updatedAt: new Date().toISOString() };
  if (!existing) merged.firstSeenAt = merged.updatedAt;
  state.offers.set(offer.recommendationId, merged);
  return merged;
}

export const getOffer = (id) => state.offers.get(id) ?? null;

/** An offer with no resolved owner is shown to everyone - ADA exposes no
 *  reverse lookup from pseudonym to user_ref, so without the demo-only
 *  pseudonym key we honestly cannot say whose it is. */
export function listOffers(userRef) {
  return [...state.offers.values()]
    .filter((o) => !o.dismissed)
    .filter((o) => !o.targetUserRef || o.targetUserRef === userRef)
    .sort((a, b) => (b.approvedAt ?? b.firstSeenAt).localeCompare(a.approvedAt ?? a.firstSeenAt));
}

export const listAllOffers = () => [...state.offers.values()];

export function markOfferClaimed(id, userRef) {
  const offer = state.offers.get(id);
  if (!offer) return null;
  offer.claimedBy = userRef;
  offer.claimedAt = new Date().toISOString();
  return offer;
}

export function dismissOffer(id) {
  const offer = state.offers.get(id);
  if (offer) offer.dismissed = true;
  return offer ?? null;
}

// -- saved beneficiaries ----------------------------------------------------

export function listFavourites(userRef) {
  return state.favourites.get(userRef) ?? [];
}

export function addFavourite(userRef, favourite) {
  if (!state.favourites.has(userRef)) state.favourites.set(userRef, []);
  const list = state.favourites.get(userRef);
  const key = `${favourite.bankCode ?? "BDN"}:${favourite.accountNumber}`;
  const existing = list.find((f) => `${f.bankCode ?? "BDN"}:${f.accountNumber}` === key);
  if (existing) {
    Object.assign(existing, favourite);
    return existing;
  }
  const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...favourite };
  list.push(row);
  return row;
}

export function removeFavourite(userRef, id) {
  const list = state.favourites.get(userRef) ?? [];
  const index = list.findIndex((f) => f.id === id);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
}

// -- scheduled transfers ----------------------------------------------------

export function addSchedule(schedule) {
  const row = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "ACTIVE",
    runCount: 0,
    lastRunAt: null,
    ...schedule,
  };
  state.scheduled.set(row.id, row);
  return row;
}

export const getSchedule = (id) => state.scheduled.get(id) ?? null;

export function listSchedules(userRef) {
  return [...state.scheduled.values()]
    .filter((s) => s.userRef === userRef)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

export function updateSchedule(id, patch) {
  const row = state.scheduled.get(id);
  if (!row) return null;
  Object.assign(row, patch);
  return row;
}

// -- two-step transaction challenges ----------------------------------------

/** Internet banking confirms a payment with a second factor before it moves
 *  money. A challenge holds the unexecuted request until the token matches. */
export function createChallenge({ userRef, kind, request, summary, ttlMs = 120_000 }) {
  const id = randomUUID();
  const now = Date.now();
  const challenge = {
    id,
    userRef,
    kind,
    request,
    summary,
    // 8-digit challenge shown on screen, 6-digit response the token device
    // would produce from it. Simulated, and only ever compared server side.
    challengeNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
    token: String(Math.floor(100_000 + Math.random() * 899_999)),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    attempts: 0,
  };
  state.pending.set(id, challenge);
  return challenge;
}

export function getChallenge(id) {
  const challenge = state.pending.get(id);
  if (!challenge) return null;
  if (Date.parse(challenge.expiresAt) < Date.now()) {
    state.pending.delete(id);
    return null;
  }
  return challenge;
}

export const consumeChallenge = (id) => state.pending.delete(id);

// -- reset ------------------------------------------------------------------

export function resetDemo() {
  seed();
  state.splits.clear();
  state.wireLog.length = 0;
  state.offers.clear();
  state.favourites.clear();
  state.scheduled.clear();
  state.pending.clear();
  state.loginActivity.clear();
  state.pinOverrides.clear();
  return { ok: true, resetAt: new Date().toISOString() };
}
