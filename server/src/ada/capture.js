/** File sink for ADA-bound events.
 *
 * Writes each event as one JSON object per line, in the exact raw-event shape
 * ADA's ingest API accepts (services/api/src/api/routers/ingest.py: RawEventIn)
 * and its worker normalizes (packages/ingest-mapping/.../normalize.py):
 *
 *   {client_event_id, event_type, occurred_at, user_ref, user_attributes, payload}
 *
 * JSONL rather than one big array, so a run that is interrupted still leaves a
 * usable file. `scripts/simulate-population.js` converts it to the JSON array
 * `python -m worker.main --events` expects.
 *
 * Appends are synchronous on purpose: the simulation drives thousands of
 * requests and an async write queue would reorder lines under concurrency for
 * no benefit - the writes are small and the file is local.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

let ready = false;

function ensureDir() {
  if (ready) return;
  const dir = path.dirname(path.resolve(config.capture.file));
  mkdirSync(dir, { recursive: true });
  ready = true;
}

/** Append one event. Never throws at the caller: a capture failure must not
 *  turn a successful transaction into an error, same rule as ADA_FAIL_OPEN. */
export function captureEvent(event) {
  try {
    ensureDir();
    appendFileSync(path.resolve(config.capture.file), `${JSON.stringify(event)}\n`, "utf8");
    return { captured: true };
  } catch (err) {
    const message = String(err?.message ?? err);
    console.error("[ada-capture] write failed:", message);
    return { captured: false, error: message };
  }
}

export const captureFilePath = () => path.resolve(config.capture.file);
