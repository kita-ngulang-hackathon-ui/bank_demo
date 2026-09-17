/** Operator surface for the demo: what went over the wire, what came back,
 *  and the buttons the presenter needs when something misbehaves on stage.
 */
import { Router } from "express";
import { config, publicConfig, assertConfigured } from "../config.js";
import { listWire, wireStats, resetDemo, listAllOffers } from "../store.js";
import { pollRecommendations, recommendationStatus } from "../ada/recommendations.js";
import { postOutcome, ackDelivery } from "../ada/http.js";
import { adaSdk } from "../ada/sdk.js";
import { USERS, publicUser } from "../data/users.js";
import { pseudonymFor } from "../ada/pseudonym.js";

export const demoRouter = Router();

demoRouter.get("/config", (_req, res) => res.json(publicConfig()));

demoRouter.get("/users", (_req, res) =>
  res.json({
    items: USERS.map((u) => ({
      ...publicUser(u),
      // null unless the demo-only pseudonym key is configured
      pseudonym: pseudonymFor(u.ref),
    })),
  })
);

demoRouter.get("/wire", (req, res) => {
  res.json({
    stats: wireStats(),
    sdk: adaSdk.stats,
    queued: adaSdk.queue.length,
    items: listWire({
      limit: Number(req.query.limit ?? 60),
      surface: req.query.surface,
      userRef: req.query.userRef,
    }),
  });
});

demoRouter.get("/status", async (_req, res) => {
  const problems = assertConfigured();
  let reachable = null;
  let error = null;
  try {
    await adaSdk.health();
    reachable = true;
  } catch (err) {
    reachable = false;
    error = String(err?.message ?? err);
  }
  res.json({
    ada: { baseUrl: config.ada.baseUrl, tenantSlug: config.ada.tenantSlug, reachable, error },
    configProblems: problems,
    recommendations: recommendationStatus(),
    wire: wireStats(),
    sdk: { ...adaSdk.stats, queued: adaSdk.queue.length },
  });
});

demoRouter.get("/offers", (_req, res) => res.json({ items: listAllOffers() }));

/** Force a pull instead of waiting for the poll interval. */
demoRouter.post("/recommendations/refresh", async (_req, res) => {
  const result = await pollRecommendations();
  res.json({ poll: result, offers: listAllOffers() });
});

/** Flush the SDK queue on demand - useful right before showing ADA's console. */
demoRouter.post("/flush", async (_req, res) => {
  try {
    const result = await adaSdk.flush();
    res.json({ ok: true, result, stats: adaSdk.stats });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err?.message ?? err) });
  }
});

demoRouter.post("/recommendations/:id/ack", async (req, res) => {
  try {
    const result = await ackDelivery(req.params.id, { channel: req.body?.channel ?? "IN_APP" });
    res.json(result);
  } catch (err) {
    res.status(err?.status ?? 502).json({ error: String(err?.message ?? err) });
  }
});

/** Manual outcome report. `userRef` must be the PSEUDONYM ADA returned on the
 *  recommendation, not a bank_demo user id (ingest.py is explicit about it). */
demoRouter.post("/outcome", async (req, res) => {
  const { clientOutcomeId, userRef, experimentId, outcomeType, valueIdr } = req.body ?? {};
  if (!userRef || !experimentId || !outcomeType) {
    return res.status(400).json({ error: "VALIDATION", message: "userRef, experimentId, outcomeType are required" });
  }
  try {
    const result = await postOutcome({
      client_outcome_id: clientOutcomeId ?? `bd_out_${Date.now()}`,
      user_ref: userRef,
      experiment_id: experimentId,
      outcome_type: outcomeType,
      observed_at: new Date().toISOString(),
      ...(valueIdr != null ? { value_idr: Number(valueIdr) } : {}),
    });
    res.json(result);
  } catch (err) {
    res.status(err?.status ?? 502).json({ error: String(err?.message ?? err) });
  }
});

/** Local reset only. Events already accepted by ADA stay in ADA - that is the
 *  whole point of sending them. */
demoRouter.post("/reset", (_req, res) => res.json(resetDemo()));
