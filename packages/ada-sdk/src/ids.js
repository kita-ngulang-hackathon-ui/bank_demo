import { randomUUID } from "node:crypto";

/** ADA dedupes on (tenant, client_event_id), so this must be stable per event
 *  and unique across events - never regenerated on retry. */
export function newClientEventId(prefix = "bd") {
  return `${prefix}_${randomUUID()}`;
}

/** RFC 3339 with an explicit offset, which is what ADA validates. */
export function rfc3339(date = new Date()) {
  return date.toISOString();
}
