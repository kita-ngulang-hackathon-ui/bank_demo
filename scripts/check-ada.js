/** Preflight: can bank_demo actually reach ADA with this key?
 *
 *   npm run check:ada
 *
 * Run it before the demo. Every failure here is a failure you would otherwise
 * discover on stage.
 */
import { config, assertConfigured } from "../server/src/config.js";
import { AdaClient } from "@bank-demo/ada-sdk";

const line = (label, ok, detail = "") =>
  console.log(`  ${ok ? "ok   " : "FAIL "} ${label.padEnd(34)} ${detail}`);

console.log(`\nbank_demo preflight -> ${config.ada.baseUrl} (tenant ${config.ada.tenantSlug})\n`);

let failures = 0;

for (const problem of assertConfigured()) {
  line("configuration", false, problem);
  failures += 1;
}

const ada = new AdaClient({
  baseUrl: config.ada.baseUrl,
  apiKey: config.ada.apiKey,
  timeoutMs: config.ada.timeoutMs,
  maxRetries: 0,
});

// 1. Is the API up at all?
try {
  const response = await fetch(new URL("/docs", config.ada.baseUrl), { signal: AbortSignal.timeout(3000) });
  line("ADA API reachable", response.ok, `GET /docs -> ${response.status}`);
  if (!response.ok) failures += 1;
} catch (err) {
  line("ADA API reachable", false, String(err?.message ?? err));
  failures += 1;
}

// 2. Does the key authenticate? A 401 here means the wrong INGEST_API_KEY_*.
try {
  const recs = await ada.listApprovedRecommendations({ limit: 1 });
  line("API key accepted", true, `${recs.items?.length ?? 0} approved recommendation(s) visible`);
} catch (err) {
  line("API key accepted", false, String(err?.message ?? err));
  failures += 1;
}

// 3. Will ADA accept an event? Uses a fixed client_event_id so repeated runs
//    are idempotent instead of polluting the tenant with junk.
try {
  const result = await ada.trackNow({
    eventType: "wallet.app.opened",
    userRef: "bd-preflight",
    payload: { surface: "preflight" },
    userAttributes: { region: "JAKARTA", cohort: "C3" },
    clientEventId: "bank_demo_preflight_probe",
  });
  line("event accepted", true, result.result?.duplicate ? "duplicate (probe already sent before)" : "accepted");
} catch (err) {
  line("event accepted", false, String(err?.message ?? err));
  failures += 1;
}

// 4. Per-user offer routing is optional; say which mode the demo will run in.
line(
  "offer routing",
  true,
  config.pseudonym.enabled ? "per-user (pseudonym key configured)" : "shared inbox (no pseudonym key)"
);

console.log(`\n${failures === 0 ? "READY" : `${failures} problem(s) to fix`}\n`);
process.exit(failures === 0 ? 0 : 1);
