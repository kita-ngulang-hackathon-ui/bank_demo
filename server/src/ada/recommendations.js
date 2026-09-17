/** The pull-back half of the loop.
 *
 * ADA never pushes. bank_demo polls `GET /v1/recommendations?status=APPROVED`,
 * turns each row into an offer, and acknowledges delivery once the offer is
 * actually on a screen the user can reach.
 *
 * Delivery-ack is idempotent-hostile on ADA's side: a second ack for the same
 * recommendation is a 409 (IllegalTransition). So ack exactly once and
 * remember that we did.
 */
import { listApprovedRecommendations, ackDelivery } from "./http.js";
import { userRefForPseudonym, pseudonymRoutingEnabled } from "./pseudonym.js";
import { copyForIncentive } from "../data/incentives.js";
import { upsertOffer, getOffer, listAllOffers } from "../store.js";
import { config, sendsToAda } from "../config.js";

let timer = null;
let lastPoll = { at: null, ok: null, count: 0, error: null };

function toOffer(row) {
  const copy = copyForIncentive(row.incentive_code);
  return {
    recommendationId: row.recommendation_id,
    subjectType: row.subject_type,
    userPseudonym: row.user_pseudonym ?? null,
    circleId: row.circle_id ?? null,
    incentiveCode: row.incentive_code,
    costIdr: row.cost_idr,
    reasonText: row.reason_text ?? null,
    approvedAt: row.approved_at ?? null,
    expiresAt: row.expires_at ?? null,
    targetUserRef: userRefForPseudonym(row.user_pseudonym),
    copy,
  };
}

/** One poll cycle: page through APPROVED, upsert, ack the new ones. */
export async function pollRecommendations() {
  const collected = [];
  let cursor = 0;

  try {
    // ADA pages with an opaque-ish integer cursor and returns next_cursor
    // only while a full page came back.
    for (let page = 0; page < 10; page += 1) {
      const result = await listApprovedRecommendations({ limit: 50, cursor });
      collected.push(...(result?.items ?? []));
      if (!result?.next_cursor) break;
      cursor = Number.parseInt(result.next_cursor, 10);
      if (!Number.isFinite(cursor)) break;
    }
  } catch (err) {
    lastPoll = { at: new Date().toISOString(), ok: false, count: 0, error: String(err?.message ?? err) };
    return lastPoll;
  }

  let fresh = 0;
  for (const row of collected) {
    const existing = getOffer(row.recommendation_id);
    const offer = upsertOffer({ ...toOffer(row), acked: existing?.acked ?? false });
    if (!existing) fresh += 1;
    if (config.recs.autoAck && !offer.acked) {
      try {
        await ackDelivery(offer.recommendationId, {
          deliveryRef: `bank_demo:${offer.targetUserRef ?? "inbox"}`,
          channel: offer.targetUserRef ? "IN_APP" : "INBOX",
        });
        upsertOffer({ recommendationId: offer.recommendationId, acked: true, ackedAt: new Date().toISOString() });
      } catch (err) {
        // 409 means someone already acked it; that is a success for us.
        const conflict = err?.status === 409;
        upsertOffer({
          recommendationId: offer.recommendationId,
          acked: conflict,
          ackError: conflict ? null : String(err?.message ?? err),
        });
      }
    }
  }

  lastPoll = {
    at: new Date().toISOString(),
    ok: true,
    count: collected.length,
    fresh,
    error: null,
    routed: pseudonymRoutingEnabled(),
  };
  return lastPoll;
}

export function startRecommendationPoller() {
  if (timer) return timer;
  // Capture mode runs with no ADA behind it, so polling would only log a
  // connection error every RECS_POLL_INTERVAL_MS.
  if (!sendsToAda()) {
    lastPoll = { at: null, ok: null, count: 0, error: "disabled: ADA_TRANSPORT_MODE=capture" };
    return null;
  }
  pollRecommendations().catch((err) => console.error("[ada-recs] first poll failed:", err?.message ?? err));
  timer = setInterval(() => {
    pollRecommendations().catch((err) => console.error("[ada-recs] poll failed:", err?.message ?? err));
  }, config.recs.pollIntervalMs);
  timer.unref?.();
  return timer;
}

export const recommendationStatus = () => ({
  lastPoll,
  offers: listAllOffers().length,
  pollIntervalMs: config.recs.pollIntervalMs,
  pseudonymRouting: pseudonymRoutingEnabled(),
});
