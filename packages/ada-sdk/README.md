# @bank-demo/ada-sdk

Server-side SDK for the ADA Solutions ingestion API (`/v1`).

The mobile (`wndr`) surface of bank_demo tracks through this SDK; the desktop
internet-banking portal calls the same API directly through
`server/src/ada/http.js` instead, so the demo shows both integration styles.

**This package must never run in a browser.** It carries a tenant API key.

## Use

```js
import { AdaClient } from "@bank-demo/ada-sdk";

const ada = new AdaClient({
  baseUrl: "http://localhost:8000",
  apiKey: process.env.ADA_API_KEY,
  flushIntervalMs: 1500,
});

ada.track({
  eventType: "wallet.transfer.sent",
  userRef: "bd-user-001",
  payload: { amount: 250000, recipient_ref: "bd-user-004" },
  userAttributes: { region: "JAKARTA", cohort: "C3" },
});

await ada.flush();
```

## Behaviour

- `track()` enqueues and returns immediately. A banking transaction never waits
  on analytics (ADA_project requirement 4: no client-side SDK in the critical
  path).
- The queue auto-flushes on `flushIntervalMs`, when it reaches `maxBatchSize`,
  or on an explicit `flush()`.
- Batches go to `POST /v1/events:batch`, capped at `maxBatchSize` (ADA rejects
  anything over `INGEST_MAX_BATCH_SIZE`, default 500).
- Retries are exponential with jitter on network errors, 429 and 5xx. 4xx other
  than 429 is a permanent reject and is dropped with an `event:rejected` emit.
- `client_event_id` is generated per event if not supplied, so ADA's
  idempotency (duplicate detection) works across retries.
- The client is an `EventEmitter`: listen for `batch:sent`, `batch:failed`,
  `event:rejected`, `queue:dropped`.
