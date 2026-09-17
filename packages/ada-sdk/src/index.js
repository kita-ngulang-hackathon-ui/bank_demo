/** AdaClient - queueing SDK over the ADA Solutions ingestion API.
 *
 * Contract source of truth: ADA_project/services/api/src/api/routers/ingest.py
 *   POST /v1/events                           single event, 202
 *   POST /v1/events:batch                     {events: [...]}, max 500, 202
 *   GET  /v1/recommendations?status=APPROVED  APPROVED is the only legal value
 *   POST /v1/recommendations/{id}/delivery-ack
 *   POST /v1/outcomes
 */
import { EventEmitter } from "node:events";
import { adaFetch, AdaHttpError, backoffMs, sleep } from "./transport.js";
import { newClientEventId, rfc3339 } from "./ids.js";

export { AdaHttpError, newClientEventId, rfc3339 };

/** Exactly the vocabulary seeded in ADA_project/fixtures/mappings/wallet.json.
 *  Anything else is dropped before it leaves the process - an unmapped event
 *  type is silently useless to the pipeline, so fail loudly here instead. */
export const EVENT_TYPES = Object.freeze({
  TRANSFER_SENT: "wallet.transfer.sent",
  SPLIT_CREATED: "wallet.split.created",
  SPLIT_SETTLED: "wallet.split.settled",
  BILL_AUTOPAY: "wallet.bill.autopay",
  TOPUP_COMPLETED: "wallet.topup.completed",
  PAYMENT_MERCHANT: "wallet.payment.merchant",
  WITHDRAW_COMPLETED: "wallet.withdraw.completed",
  APP_OPENED: "wallet.app.opened",
});

const KNOWN_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

export class AdaClient extends EventEmitter {
  constructor({
    baseUrl,
    apiKey,
    timeoutMs = 4000,
    maxBatchSize = 500,
    flushIntervalMs = 1500,
    maxQueue = 500,
    maxRetries = 3,
    source = "sdk",
  }) {
    super();
    if (!baseUrl) throw new Error("AdaClient: baseUrl is required");
    if (!apiKey) throw new Error("AdaClient: apiKey is required");

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxBatchSize = Math.min(maxBatchSize, 500);
    this.flushIntervalMs = flushIntervalMs;
    this.maxQueue = maxQueue;
    this.maxRetries = maxRetries;
    this.source = source;

    this.queue = [];
    this.inFlight = null;
    this.stats = { queued: 0, sent: 0, duplicates: 0, rejected: 0, dropped: 0, failures: 0 };
    this.timer = null;
  }

  // -- lifecycle ----------------------------------------------------------

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.emit("batch:failed", err));
    }, this.flushIntervalMs);
    this.timer.unref?.();
    return this;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  // -- ingestion ----------------------------------------------------------

  /** Build the wire shape. Callers pass camelCase, ADA gets snake_case. */
  buildEvent({ eventType, userRef, payload = {}, userAttributes, occurredAt, clientEventId }) {
    if (!KNOWN_EVENT_TYPES.has(eventType)) {
      throw new Error(
        `AdaClient: "${eventType}" is not in the demo-wallet vocabulary. ` +
          `Known: ${[...KNOWN_EVENT_TYPES].join(", ")}`
      );
    }
    if (!userRef) throw new Error("AdaClient: userRef is required");

    return {
      client_event_id: clientEventId ?? newClientEventId(),
      event_type: eventType,
      occurred_at: occurredAt ?? rfc3339(),
      user_ref: userRef,
      ...(userAttributes ? { user_attributes: stringifyAttrs(userAttributes) } : {}),
      payload,
    };
  }

  /** Enqueue and return at once. Never await this on a banking action path. */
  track(event) {
    const wire = this.buildEvent(event);
    if (this.queue.length >= this.maxQueue) {
      const dropped = this.queue.shift();
      this.stats.dropped += 1;
      this.emit("queue:dropped", dropped);
    }
    this.queue.push(wire);
    this.stats.queued += 1;
    this.emit("event:queued", wire);

    if (this.queue.length >= this.maxBatchSize) {
      this.flush().catch((err) => this.emit("batch:failed", err));
    }
    return wire;
  }

  /** Bypass the queue - one event, awaited. Used by scripts and tests. */
  async trackNow(event) {
    const wire = this.buildEvent(event);
    const result = await this.withRetry(() =>
      adaFetch("/v1/events", {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        method: "POST",
        body: wire,
        timeoutMs: this.timeoutMs,
      })
    );
    this.stats.sent += 1;
    if (result?.duplicate) this.stats.duplicates += 1;
    this.emit("batch:sent", { count: 1, result });
    return { event: wire, result };
  }

  async flush() {
    if (this.inFlight) return this.inFlight;
    if (this.queue.length === 0) return { accepted_count: 0, duplicate_count: 0, rejected: [] };

    const batch = this.queue.splice(0, this.maxBatchSize);
    this.inFlight = this.sendBatch(batch).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async sendBatch(batch) {
    try {
      const result = await this.withRetry(() =>
        adaFetch("/v1/events:batch", {
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
          method: "POST",
          body: { events: batch },
          timeoutMs: this.timeoutMs,
        })
      );
      this.stats.sent += result?.accepted_count ?? 0;
      this.stats.duplicates += result?.duplicate_count ?? 0;
      for (const bad of result?.rejected ?? []) {
        this.stats.rejected += 1;
        this.emit("event:rejected", bad);
      }
      this.emit("batch:sent", { count: batch.length, result });
      return result;
    } catch (err) {
      this.stats.failures += 1;
      // A permanently rejected batch is dropped; a retryable one already
      // exhausted its attempts, so re-queueing forever would grow unbounded.
      this.emit("batch:failed", err, batch);
      throw err;
    }
  }

  async withRetry(fn) {
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retryable = err instanceof AdaHttpError ? err.retryable : true;
        if (!retryable || attempt === this.maxRetries) break;
        await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  }

  // -- pull-back loop -----------------------------------------------------

  /** APPROVED is the only status ADA will serve; anything else is a 403. */
  async listApprovedRecommendations({ limit = 50, cursor = 0 } = {}) {
    return adaFetch("/v1/recommendations", {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      query: { status: "APPROVED", limit, cursor },
      timeoutMs: this.timeoutMs,
    });
  }

  /** Marks the recommendation delivered. ADA rejects a second ack with 409. */
  async ackDelivery(recommendationId, { deliveredAt, deliveryRef, channel } = {}) {
    return adaFetch(`/v1/recommendations/${recommendationId}/delivery-ack`, {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      method: "POST",
      body: {
        delivered_at: deliveredAt ?? rfc3339(),
        ...(deliveryRef ? { delivery_ref: deliveryRef } : {}),
        ...(channel ? { channel } : {}),
      },
      timeoutMs: this.timeoutMs,
    });
  }

  /** user_ref here is the pseudonym ADA handed back on the recommendation,
   *  not our own user id (ingest.py says so explicitly). */
  async reportOutcome({ clientOutcomeId, userRef, experimentId, outcomeType, observedAt, valueIdr }) {
    return adaFetch("/v1/outcomes", {
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      method: "POST",
      body: {
        client_outcome_id: clientOutcomeId ?? newClientEventId("out"),
        user_ref: userRef,
        experiment_id: experimentId,
        outcome_type: outcomeType,
        observed_at: observedAt ?? rfc3339(),
        ...(valueIdr != null ? { value_idr: valueIdr } : {}),
      },
      timeoutMs: this.timeoutMs,
    });
  }

  async health() {
    // Any authenticated call proves key + reachability; the recommendations
    // list is the cheapest one that does not write.
    await this.listApprovedRecommendations({ limit: 1 });
    return { ok: true, baseUrl: this.baseUrl };
  }
}

/** ADA types user_attributes as dict[str, str]. Coerce early so a number in a
 *  demo script does not become a 422 on stage. */
function stringifyAttrs(attrs) {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)])
  );
}
