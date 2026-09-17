/** Direct ADA API client - the DESKTOP surface's integration style.
 *
 * The internet-banking portal "shoots" each event straight at
 * `POST /v1/events` from the request handler: no queue, no batching, one
 * event per user action, awaited with a short timeout. It is the simplest
 * possible integration and the one most client banks start with.
 *
 * The mobile surface deliberately does NOT use this - see ./sdk.js.
 */
import { adaFetch, backoffMs, sleep, AdaHttpError } from "@bank-demo/ada-sdk/src/transport.js";
import { newClientEventId, rfc3339, EVENT_TYPES } from "@bank-demo/ada-sdk";
import { config } from "../config.js";

const KNOWN = new Set(Object.values(EVENT_TYPES));

function opts(extra = {}) {
  return {
    baseUrl: config.ada.baseUrl,
    apiKey: config.ada.apiKey,
    timeoutMs: config.ada.timeoutMs,
    ...extra,
  };
}

async function withRetry(fn, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AdaHttpError ? err.retryable : true;
      if (!retryable || attempt === maxRetries) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError;
}

export function buildEvent({ eventType, userRef, payload = {}, userAttributes, occurredAt, clientEventId }) {
  if (!KNOWN.has(eventType)) throw new Error(`unknown event_type "${eventType}"`);
  return {
    client_event_id: clientEventId ?? newClientEventId("bdweb"),
    event_type: eventType,
    occurred_at: occurredAt ?? rfc3339(),
    user_ref: userRef,
    ...(userAttributes
      ? {
          user_attributes: Object.fromEntries(
            Object.entries(userAttributes).map(([k, v]) => [k, String(v)])
          ),
        }
      : {}),
    payload,
  };
}

/** POST /v1/events. Returns {accepted, raw_event_id, duplicate}. */
export async function postEvent(event) {
  return withRetry(() => adaFetch("/v1/events", opts({ method: "POST", body: event })));
}

/** POST /v1/events:batch. Used by the seeding script, not by the portal. */
export async function postEventBatch(events) {
  if (events.length > config.ada.maxBatchSize) {
    throw new Error(`batch of ${events.length} exceeds ADA_MAX_BATCH_SIZE=${config.ada.maxBatchSize}`);
  }
  return withRetry(() => adaFetch("/v1/events:batch", opts({ method: "POST", body: { events } })));
}

export async function listApprovedRecommendations({ limit = 50, cursor = 0 } = {}) {
  return adaFetch("/v1/recommendations", opts({ query: { status: "APPROVED", limit, cursor } }));
}

export async function ackDelivery(recommendationId, { deliveryRef, channel } = {}) {
  return adaFetch(
    `/v1/recommendations/${recommendationId}/delivery-ack`,
    opts({
      method: "POST",
      body: {
        delivered_at: rfc3339(),
        ...(deliveryRef ? { delivery_ref: deliveryRef } : {}),
        ...(channel ? { channel } : {}),
      },
    })
  );
}

export async function postOutcome(body) {
  return adaFetch("/v1/outcomes", opts({ method: "POST", body }));
}
