/** SDK client - the MOBILE surface's integration style.
 *
 * `wndr` actions call `trackMobile()`, which enqueues and returns. The SDK
 * batches to `POST /v1/events:batch` on a timer. The user's transfer is
 * confirmed by the bank before ADA has even heard about it, which is the
 * point: analytics must never sit in the payment path.
 */
import { AdaClient } from "@bank-demo/ada-sdk";
import { config } from "../config.js";
import { logWire, updateWire } from "../store.js";

export const adaSdk = new AdaClient({
  baseUrl: config.ada.baseUrl,
  apiKey: config.ada.apiKey,
  timeoutMs: config.ada.timeoutMs,
  maxBatchSize: config.ada.maxBatchSize,
  flushIntervalMs: config.sdk.flushIntervalMs,
  maxQueue: config.sdk.maxQueue,
  maxRetries: config.sdk.maxRetries,
  source: "mobile-sdk",
});

/** client_event_id -> wire log row id, so a batch result can be attributed
 *  back to the individual action that produced it. */
const pending = new Map();

adaSdk.on("batch:sent", ({ result }) => {
  const rejectedIds = new Set((result?.rejected ?? []).map((r) => r.client_event_id));
  for (const [clientEventId, wireId] of pending) {
    if (rejectedIds.has(clientEventId)) {
      updateWire(wireId, { status: "FAILED", error: "rejected by ADA in batch" });
    } else {
      updateWire(wireId, { status: "SENT", adaResponse: summarise(result) });
    }
    pending.delete(clientEventId);
  }
});

adaSdk.on("batch:failed", (err, batch) => {
  for (const event of batch ?? []) {
    const wireId = pending.get(event.client_event_id);
    if (wireId) {
      updateWire(wireId, { status: "FAILED", error: String(err?.message ?? err) });
      pending.delete(event.client_event_id);
    }
  }
  console.error("[ada-sdk] batch failed:", err?.message ?? err);
});

adaSdk.on("queue:dropped", (event) => {
  const wireId = pending.get(event.client_event_id);
  if (wireId) updateWire(wireId, { status: "FAILED", error: "dropped: SDK queue full" });
});

function summarise(result) {
  if (!result) return null;
  return {
    accepted_count: result.accepted_count,
    duplicate_count: result.duplicate_count,
    rejected: result.rejected?.length ?? 0,
  };
}

/** Queue one event from the mobile surface. Never throws at the caller. */
export function trackMobile({ eventType, userRef, payload, userAttributes, action }) {
  try {
    const wire = adaSdk.buildEvent({ eventType, userRef, payload, userAttributes });
    const row = logWire({
      surface: "mobile",
      transport: "sdk",
      action,
      eventType,
      userRef,
      clientEventId: wire.client_event_id,
      payload: wire.payload,
      status: "QUEUED",
    });
    pending.set(wire.client_event_id, row.id);
    adaSdk.track({ eventType, userRef, payload, userAttributes, clientEventId: wire.client_event_id });
    return { queued: true, clientEventId: wire.client_event_id, wireId: row.id };
  } catch (err) {
    logWire({
      surface: "mobile",
      transport: "sdk",
      action,
      eventType,
      userRef,
      status: "FAILED",
      error: String(err?.message ?? err),
    });
    return { queued: false, error: String(err?.message ?? err) };
  }
}

export function startSdk() {
  adaSdk.start();
  return adaSdk;
}
