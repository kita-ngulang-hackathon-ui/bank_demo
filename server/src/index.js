/** bank_demo server.
 *
 * Serves two front ends and holds the one secret that must never reach a
 * browser: the ADA tenant API key. Every event the UI causes is sent from
 * here, server side.
 *
 *   GET  /            -> desktop internet banking portal
 *   GET  /wondr       -> mobile superapp surface
 *   GET  /ops         -> presenter console (wire log, ADA status)
 *   /api/desktop/*    -> banking actions, events via direct ADA API calls
 *   /api/mobile/*     -> same actions, events via the SDK queue
 *   /api/demo/*       -> operator endpoints
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { config, assertConfigured } from "./config.js";
import { cookieMiddleware } from "./middleware/auth.js";
import { makeSurfaceRouter } from "./routes/surface.js";
import { demoRouter } from "./routes/demo.js";
import { trackDesktop } from "./ada/desktop.js";
import { trackMobile, startSdk, adaSdk } from "./ada/sdk.js";
import { startRecommendationPoller } from "./ada/recommendations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../web");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cookieMiddleware);

// Desktop: direct API calls, awaited. Mobile: SDK queue, returns at once.
app.use("/api/desktop", makeSurfaceRouter({ surface: "desktop", track: trackDesktop }));
app.use(
  "/api/mobile",
  makeSurfaceRouter({ surface: "mobile", track: async (event) => trackMobile(event) })
);
app.use("/api/demo", demoRouter);

app.get("/healthz", (_req, res) => res.json({ ok: true, service: "bank_demo" }));

// Static surfaces. /wondr and /ops get explicit entry points so the URLs stay
// clean on stage.
app.use("/shared", express.static(path.join(webRoot, "shared")));
app.use("/wondr", express.static(path.join(webRoot, "mobile")));
app.use("/ops", express.static(path.join(webRoot, "ops")));
app.use("/", express.static(path.join(webRoot, "desktop")));

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));

const problems = assertConfigured();
for (const problem of problems) console.warn(`[config] ${problem}`);

startSdk();
startRecommendationPoller();

const server = app.listen(config.port, () => {
  console.log(`\n  ${config.brand.bankName} demo`);
  console.log(`  Desktop portal   http://localhost:${config.port}/`);
  console.log(`  ${config.brand.mobileAppName} mobile app   http://localhost:${config.port}/wondr/`);
  console.log(`  Presenter ops    http://localhost:${config.port}/ops/`);
  console.log(`  ADA ingest       ${config.ada.baseUrl}  (tenant ${config.ada.tenantSlug})`);
  console.log(
    `  Offer routing    ${config.pseudonym.enabled ? "per-user (pseudonym key set)" : "shared inbox (no pseudonym key)"}\n`
  );
});

async function shutdown(signal) {
  console.log(`\n[${signal}] flushing SDK queue before exit...`);
  try {
    await adaSdk.stop();
  } catch (err) {
    console.error("[shutdown] flush failed:", err?.message ?? err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
