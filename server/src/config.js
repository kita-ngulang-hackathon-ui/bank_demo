/** Every environment read happens here, once.
 *
 * Nothing in this module is ever serialised to the browser except
 * `publicConfig()`, which is deliberately narrow: the ADA API key stays on
 * this side of the wire, always.
 */

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 4000),
  env: process.env.NODE_ENV ?? "development",

  brand: {
    bankName: process.env.BANK_NAME ?? "Bank Demo Nusantara",
    bankShort: process.env.BANK_SHORT ?? "BDN",
    tagline: process.env.BANK_TAGLINE ?? "Placeholder tagline",
    mobileAppName: process.env.MOBILE_APP_NAME ?? "wndr",
    showDemoBanner: bool(process.env.SHOW_DEMO_BANNER, true),
  },

  session: {
    /** Retail internet banking logs an idle session out. 15 minutes matches
     *  the usual Indonesian retail portal. */
    idleTimeoutMs: int(process.env.SESSION_IDLE_TIMEOUT_MS, 15 * 60 * 1000),
    /** The simulated e-Secure token device shows the expected code on screen.
     *  Turn it off to make a presenter type a code they cannot see. */
    showToken: bool(process.env.DEMO_SHOW_TOKEN, true),
  },

  ada: {
    baseUrl: process.env.ADA_BASE_URL ?? "http://localhost:8000",
    apiKey: process.env.ADA_API_KEY ?? "",
    tenantSlug: process.env.ADA_TENANT_SLUG ?? "demo-wallet",
    timeoutMs: int(process.env.ADA_TIMEOUT_MS, 4000),
    maxBatchSize: Math.min(int(process.env.ADA_MAX_BATCH_SIZE, 500), 500),
    failOpen: bool(process.env.ADA_FAIL_OPEN, true),
  },

  sdk: {
    flushIntervalMs: int(process.env.SDK_FLUSH_INTERVAL_MS, 1500),
    maxQueue: int(process.env.SDK_MAX_QUEUE, 500),
    maxRetries: int(process.env.SDK_MAX_RETRIES, 3),
  },

  recs: {
    pollIntervalMs: int(process.env.RECS_POLL_INTERVAL_MS, 10000),
    autoAck: bool(process.env.RECS_AUTO_ACK, true),
  },

  /** Demo-only. Both set => bank_demo can recompute ADA's pseudonym and route
   *  an offer to the right user. Unset => offers land in a shared inbox. */
  pseudonym: {
    secret: process.env.ADA_PSEUDONYM_HMAC_SECRET ?? "",
    tenantId: process.env.ADA_TENANT_ID ?? "",
    get enabled() {
      return Boolean(this.secret && this.tenantId);
    },
  },
};

/** The only config shape the browser ever receives. */
export function publicConfig() {
  return {
    brand: config.brand,
    demo: {
      adaBaseUrl: config.ada.baseUrl,
      tenantSlug: config.ada.tenantSlug,
      pseudonymRouting: config.pseudonym.enabled,
      idleTimeoutMs: config.session.idleTimeoutMs,
      showToken: config.session.showToken,
    },
  };
}

export function assertConfigured() {
  const problems = [];
  if (!config.ada.apiKey) problems.push("ADA_API_KEY is empty (see ADA_project/.env INGEST_API_KEY_WALLET_DEMO)");
  if (!config.ada.baseUrl) problems.push("ADA_BASE_URL is empty");
  return problems;
}
