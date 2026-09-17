/** Demo-only pseudonym recomputation.
 *
 * ADA hands back recommendations keyed by `user_pseudonym` and offers no
 * reverse lookup - by design (ADA_project packages/ingest-mapping/.../
 * pseudonymize.py: "No reverse lookup exists anywhere").
 *
 * For a stage demo we want an approved offer to land on the right person's
 * screen. Since bank_demo owns the raw `user_ref` values, it can compute the
 * same HMAC FORWARD for each of its own users and match on the result. That
 * is a lookup table over our own population, not a break of the pseudonym.
 *
 * It needs ADA's PSEUDONYM_HMAC_SECRET and the tenant UUID. Leave them unset
 * and the app falls back to a shared offers inbox.
 */
import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { USERS } from "../data/users.js";

let table = null;

/** pseudonym = HMAC_SHA256(secret, `${tenant_id}:${raw_ref}`) */
export function pseudonymFor(userRef) {
  if (!config.pseudonym.enabled) return null;
  return createHmac("sha256", config.pseudonym.secret)
    .update(`${config.pseudonym.tenantId}:${userRef}`)
    .digest("hex");
}

function ensureTable() {
  if (table) return table;
  table = new Map();
  if (!config.pseudonym.enabled) return table;
  for (const user of USERS) table.set(pseudonymFor(user.ref), user.ref);
  return table;
}

/** null when routing is disabled or the pseudonym belongs to a user that is
 *  not part of this demo population (for example a synthetic seeded user). */
export function userRefForPseudonym(pseudonym) {
  if (!pseudonym) return null;
  return ensureTable().get(pseudonym) ?? null;
}

export const pseudonymRoutingEnabled = () => config.pseudonym.enabled;
