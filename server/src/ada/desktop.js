/** Desktop tracking: one awaited POST /v1/events per action.
 *
 * Fail-open by default (ADA_FAIL_OPEN=true): the transfer already happened in
 * our ledger, so an ADA outage must not turn a successful payment into an
 * error page. The failure is recorded in the wire log instead, where the demo
 * screen shows it.
 */
import { buildEvent, postEvent } from "./http.js";
import { config } from "../config.js";
import { logWire, updateWire } from "../store.js";

export async function trackDesktop({ eventType, userRef, payload, userAttributes, action }) {
  let event;
  try {
    event = buildEvent({ eventType, userRef, payload, userAttributes });
  } catch (err) {
    logWire({
      surface: "desktop",
      transport: "api",
      action,
      eventType,
      userRef,
      status: "FAILED",
      error: String(err?.message ?? err),
    });
    if (config.ada.failOpen) return { sent: false, error: String(err?.message ?? err) };
    throw err;
  }

  const row = logWire({
    surface: "desktop",
    transport: "api",
    action,
    eventType,
    userRef,
    clientEventId: event.client_event_id,
    payload: event.payload,
    status: "PENDING",
  });

  try {
    const result = await postEvent(event);
    updateWire(row.id, {
      status: result?.duplicate ? "DUPLICATE" : "SENT",
      adaResponse: { raw_event_id: result?.raw_event_id, duplicate: result?.duplicate },
    });
    return { sent: true, clientEventId: event.client_event_id, wireId: row.id, result };
  } catch (err) {
    const message = String(err?.message ?? err);
    updateWire(row.id, { status: "FAILED", error: message });
    console.error("[ada-api] event send failed:", message);
    if (config.ada.failOpen) return { sent: false, clientEventId: event.client_event_id, wireId: row.id, error: message };
    throw err;
  }
}
