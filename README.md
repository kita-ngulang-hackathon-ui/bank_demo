# bank_demo

A demo retail bank with two front ends — a desktop internet-banking portal and a
mobile superapp — that feeds **real** events into the ADA Solutions retention
engine in the sibling `ADA_project` folder.

The point of this repo is the loop: a user does something in the bank, the event
reaches ADA's ingest API, ADA's pipeline scores it, a reviewer approves a
recommendation in the ADA console, and the approved offer appears back inside the
bank's UI. Nothing here is a fixture — every event is an HTTP call to the real
API.

> **Branding is a placeholder.** The logo, wordmark and bank name in this repo are
> generic stand-ins. No real bank's logo or copyrighted assets are used. Swap the
> three SVGs in `web/shared/assets/` and the `BANK_*` values in `.env` when the
> real assets are cleared for use.

## Surfaces

| URL | What it is | How it talks to ADA |
| --- | --- | --- |
| `http://localhost:4000/` | Desktop internet-banking portal | **Direct API calls** — one awaited `POST /v1/events` per action |
| `http://localhost:4000/wondr/` | Mobile superapp view | **SDK** — `@bank-demo/ada-sdk` queues and batches to `POST /v1/events:batch` |
| `http://localhost:4000/ops/` | Presenter console | Wire log, ADA status, manual pull/flush/reset |

Both surfaces run the same banking logic (`server/src/banking.js`); only the
transport differs. That contrast is deliberate — it shows an integrator both
styles in one demo.

## The desktop portal

The portal is the complete surface: it covers the menu a retail internet-banking
customer actually uses, and it behaves like one.

**Menu**

| Group | Pages |
| --- | --- |
| Rekening | Beranda, Informasi Saldo, Mutasi Rekening |
| Transfer | Antar Rekening, Antar Bank (BI-FAST / SKN / RTGS), Rekening Favorit, Transfer Terjadwal, Split Bill |
| Pembayaran & Pembelian | Tagihan, Pulsa & Data, Token Listrik, Top Up e-Wallet |
| Lainnya | Top Up & Tarik Tunai, Penawaran, Administrasi |

**Two-step confirmation.** No money moves on a single click. Every transaction
goes `POST /tx/prepare` → confirmation dialog with a simulated e-Secure token
device → `POST /tx/confirm`. The challenge expires after 2 minutes, a wrong code
is rejected three times before the transaction is cancelled, and the token is
single-use. Only the confirm step touches the ledger and sends the ADA event.
`DEMO_SHOW_TOKEN=false` hides the expected code if you want the presenter to
work for it.

**Session handling.** The portal shows a live countdown, warns 60 seconds before
the idle timeout with an "extend session" dialog, and logs out to `/?expired=1`
when it lapses. Server-side, `SESSION_IDLE_TIMEOUT_MS` (default 15 minutes) is
enforced on every authenticated request.

**Receipts.** Each confirmed transaction produces a printable *Bukti Transaksi*
with a reference number, the fee breakdown, the closing balance and whether the
ADA event went out. `Cetak` uses a print stylesheet that hides everything else.

**Statement.** Mutasi Rekening filters by date range, direction and free text,
shows credit/debit/closing totals, and exports the same filtered set as CSV via
`GET /api/desktop/statement.csv`.

**Also there:** saved beneficiaries (add from the transfer form or the favourites
page), scheduled transfers with a "run now" button that fires the same
`wallet.transfer.sent` event a manual transfer does, PIN change, login activity,
and a live ADA event log under Administrasi.

Interbank transfers carry a real fee per network (BI-FAST Rp 2.500, SKN
Rp 2.900, RTGS Rp 30.000 with a Rp 100 juta minimum); principal and fee both
leave the account and the fee rides along in the event payload.

## The wndr mobile app

Everything the desktop portal can do, in a phone-frame superapp shell: bottom
sheets instead of pages, quick-amount chips instead of typed totals, no token
device — a signed-in session is enough to move money, which is the mobile
trust model (the desktop's e-Secure step is a *retail internet banking*
convention, not a general security requirement, so the two surfaces
deliberately differ here as well as in transport).

**Primary actions** (home screen grid): Transfer, Split Bill, Top Up, QRIS,
Tagihan, Tarik Tunai, Bayar Share, and **Lainnya** — a sheet that opens onto
the rest:

| Lainnya | Same backend route as the desktop page |
| --- | --- |
| Transfer Antar Bank | `/transfer/interbank` — bank, account, network, fee shown live |
| Pulsa & Data | `/purchase/pulsa` — provider + denomination grid |
| Token Listrik | `/purchase/token` — meter number + denomination grid |
| Top Up e-Wallet | `/topup/ewallet` — GoPay/OVO/DANA/ShopeePay |
| Rekening Favorit | list, add from a circle contact, delete, jump straight into Transfer |
| Transfer Terjadwal | list, create, "Jalankan" (fires the same event a manual transfer does), cancel |

**Profil** tab adds **Ubah PIN**, saved-beneficiary and schedule shortcuts, a
login-activity list (channel, timestamp, IP), and the same live ADA event log
the desktop shows under Administrasi.

**Aktivitas** tab filters the full transaction list by direction and free text,
client-side over the same data the desktop's `/statement` endpoint serves — the
mobile UI just doesn't need a server round-trip for a filter this small.

**Session expiry** is enforced by the same server-side idle timeout as the
desktop (`SESSION_IDLE_TIMEOUT_MS`), since both surfaces share
`requireSession()`. The mobile UI doesn't run a visible countdown — a phone app
degrades to its lock screen instead — but a 401 from any call drops back to the
login tab with a toast, and the background refresh (every 12s) does the same
silently if you just left it open.

Every mobile action still goes through `@bank-demo/ada-sdk`, not the direct
API client — that contrast with the desktop is the point of the demo, so it
was kept even while filling out the rest of the feature set.

## Quick start

```bash
# 1. ADA must be running first (in ../ADA_project)
cd ../ADA_project && make demo

# 2. Configure and install
cd ../bank_demo
cp .env.example .env          # already done if .env exists
#   set ADA_API_KEY to INGEST_API_KEY_WALLET_DEMO from ADA_project/.env
npm install

# 3. Verify the integration before you need it on stage
npm run check:ada

# 4. Backfill history so ADA's graph has real edges to work with
npm run simulate -- --days 60

# 5. Run
npm run dev
```

Then open the desktop portal and the mobile view side by side. Every demo user's
PIN is `123456`.

## Demo population

Eight users in three "circles" (`server/src/data/users.js`). Transfers and split
bills happen **between** these users, which is what gives ADA's
transaction-circle feature repeated counterparty edges instead of isolated
actions. ADA needs several interactions on an edge before a circle exists at all
(`PIPELINE_MIN_EDGE_INTERACTIONS`, default 3), so run `npm run simulate` before
the demo — live clicking alone will not build a graph.

| Circle | Members |
| --- | --- |
| `kost-sudirman` | Andi Pratama, Bella Anindya, Citra Larasati |
| `kantor-thamrin` | Dimas Nugroho, Eka Wulandari, Fajar Ramadhan |
| `arisan-bandung` | Gita Maharani, Hendra Saputra |

## Event vocabulary

Exactly what `ADA_project/fixtures/mappings/wallet.json` seeds for tenant
`demo-wallet` — anything outside this list is rejected before it leaves the
process:

| UI action | `event_type` | payload |
| --- | --- | --- |
| Transfer | `wallet.transfer.sent` | `amount`, `recipient_ref` |
| Create split bill (one per participant) | `wallet.split.created` | `total`, `share`, `split_with_ref` |
| Pay your share | `wallet.split.settled` | `share`, `total`, `split_with_ref` |
| Pay a bill | `wallet.bill.autopay` | `amount`, `payee_ref` |
| Top up | `wallet.topup.completed` | `amount` |
| QRIS / merchant payment | `wallet.payment.merchant` | `amount`, `merchant_ref` |
| Cardless withdrawal | `wallet.withdraw.completed` | `amount` |
| Sign in | `wallet.app.opened` | `surface` |

Desktop-only actions reuse the same vocabulary rather than inventing types:

| UI action | `event_type` | payload |
| --- | --- | --- |
| Transfer to another bank | `wallet.transfer.sent` | `amount`, `recipient_ref` (`ext-<bank>-<account>`), `fee`, `network`, `destination_bank` |
| Buy airtime | `wallet.payment.merchant` | `amount`, `merchant_ref`, `category: PULSA` |
| Buy electricity token | `wallet.payment.merchant` | `amount`, `merchant_ref`, `category: ELECTRICITY_TOKEN` |
| Top up an e-wallet | `wallet.topup.completed` | `amount`, `source: BANK_ACCOUNT`, `wallet_ref` |
| Scheduled transfer runs | `wallet.transfer.sent` | same as a manual transfer |

An outside beneficiary still gets a stable counterparty ref, so repeat transfers
to the same account are one edge to ADA's graph rather than noise.

## Architecture

```
browser ──► bank_demo server (Node/Express, port 4000) ──► ADA API (port 8000)
             │  holds ADA_API_KEY                            POST /v1/events
             │  desktop → direct API client                  POST /v1/events:batch
             │  mobile  → @bank-demo/ada-sdk queue           GET  /v1/recommendations
             │  poller  → pulls APPROVED recs                POST /v1/recommendations/{id}/delivery-ack
             └─ in-memory ledger, balances, splits           POST /v1/outcomes
```

```
bank_demo/
  packages/ada-sdk/       queueing SDK: batching, retry, backoff, recs pull, ack
  server/src/
    ada/                  http.js (direct), sdk.js (SDK), desktop.js (tracking),
                          recommendations.js (poller), pseudonym.js (demo routing)
    data/                 users.js, catalog.js (banks, prepaid, e-wallets),
                          incentives.js (offer copy)
    middleware/auth.js    cookie sessions + idle timeout
    routes/               surface.js (mounted twice), demo.js (operator endpoints)
    banking.js            the bank's own domain logic
    store.js              in-memory state, wire log, challenges, favourites
  web/desktop/            internet-banking portal (portal.css + modules.css)
  web/mobile/             superapp view
  web/ops/                presenter console
  scripts/                check-ada.js, simulate-network.js
```

### Surface API

Mounted at both `/api/desktop` and `/api/mobile`:

| Endpoint | Purpose |
| --- | --- |
| `POST /session`, `DELETE /session`, `GET /session`, `POST /session/extend` | sign in/out, remaining idle time |
| `GET /home` | everything one screen needs, in one call |
| `GET /statement`, `GET /statement.csv` | filtered mutations, and the CSV export |
| `POST /tx/prepare`, `POST /tx/confirm` | two-step confirmation (desktop) |
| `POST /transfer`, `/transfer/interbank`, `/split`, `/split/:id/settle`, `/bill`, `/topup`, `/topup/ewallet`, `/purchase/pulsa`, `/purchase/token`, `/qr`, `/withdraw` | direct one-shot movements (mobile) |
| `GET/POST/DELETE /favourites` | saved beneficiaries |
| `GET/POST/DELETE /schedules`, `POST /schedules/:id/run` | standing instructions |
| `GET /profile`, `POST /profile/pin` | administration |
| `GET /offers`, `POST /offers/:id/claim` | ADA offers |

Both shapes end in the same banking function and emit the same ADA event.

### The API key never reaches the browser

Every ADA call is made server-side. The browser only ever talks to
`/api/desktop/*`, `/api/mobile/*` and `/api/demo/*` on this server. `.env` is
gitignored.

### ADA is never in the payment path

Money moves in the local ledger first; the ADA call happens after and is
fail-open (`ADA_FAIL_OPEN=true`). If ADA is down, transfers still succeed and the
failure shows up in the wire log at `/ops/`. This mirrors ADA's own requirement
that ingestion must never block a client's transaction.

## Getting offers back

The server polls `GET /v1/recommendations?status=APPROVED` every
`RECS_POLL_INTERVAL_MS` and acknowledges each new one with
`POST /v1/recommendations/{id}/delivery-ack` (once — a second ack is a 409 on
ADA's side). Approved offers then render in the portal's *Penawaran* page and in
the mobile offers rail.

ADA keys recommendations by `user_pseudonym` and exposes no reverse lookup, so
by default offers land in a **shared inbox** visible to every demo user. To route
an offer to the right person on stage, set both of these in `.env`:

```
ADA_PSEUDONYM_HMAC_SECRET=<PSEUDONYM_HMAC_SECRET from ADA_project/.env>
ADA_TENANT_ID=<uuid of tenant_slug=demo-wallet>
```

bank_demo then recomputes the same HMAC **forward** over its own users
(`HMAC_SHA256(secret, "<tenant_id>:<user_ref>")`) and matches. That is a lookup
table over our own population, not a break of the pseudonym.

Get the tenant id with:

```bash
docker compose -f ../ADA_project/docker-compose.yml exec postgres \
  psql -U postgres -d retention -c "select id, slug from tenants where slug='demo-wallet';"
```

## Presenter console (`/ops/`)

- Live wire log: every event, which surface and transport it used, and whether
  ADA accepted it
- Approved recommendations pulled back, with their routing and ack state
- Buttons: pull recommendations now, flush the SDK queue, reset local state

`POST /api/demo/reset` clears local balances, transactions, wire log and offers.
It does **not** delete anything in ADA — events already accepted live there.

## Known caveats

- **ADA's worker can fail at risk-scoring** on real pipeline runs (being fixed
  separately in `ADA_project`). Ingestion and the recommendations pull are
  unaffected, but do not plan a live on-stage run that depends on a fresh
  recommendation being generated end to end without checking first.
- `/api/demo/outcome` exists for reporting `RESPONDED` / `RETAINED` / `CHURNED`
  back to ADA, but it needs an `experiment_id`, which the recommendations
  endpoint does not currently return. Until it does, outcomes are a manual call
  with an id taken from the ADA console.
- State is in memory. Restarting the server resets the bank (by design — it is
  the fastest way to reset the stage). A changed PIN resets with it.
- Demo auth is a random token in a map, and the e-Secure token device is
  simulated. Neither is a security control.
- Scheduled transfers do not fire on their own — nothing runs them on a clock.
  Use "Jalankan sekarang", which is also what you want on stage.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run with `--watch` |
| `npm start` | Run once |
| `npm run check:ada` | Preflight: API reachable, key valid, event accepted |
| `npm run simulate -- --days 60` | Backfill deterministic history for all demo users |
| `npm run simulate -- --days 60 --dry-run` | Print what would be sent, send nothing |
| `npm run simulate:population` | Drive 120 simulated customers through the live surfaces (see below) |
| `npm run make:labels` | Write the prior-cycle labeled examples ADA's IMPACT stage needs |

`simulate` derives each `client_event_id` from the seed, so re-running it is
idempotent at ADA's end (duplicates are detected, not double-counted).

## Generating a dataset for ADA

`npm run simulate` fabricates event objects and posts them. `simulate:population`
does the opposite: it puts a whole synthetic customer base through the real
surfaces — sign in, prepare, answer the token challenge, confirm — so every
event is produced by the bank's own domain logic rather than by the script. It
needs no ADA stack, because the server writes the events to a file instead of
posting them.

```bash
# .env
ADA_TRANSPORT_MODE=capture       # write events to a file, make no HTTP call
ADA_CAPTURE_FILE=out/ada-events.jsonl
DEMO_POPULATION_SIZE=120         # tops the handwritten 8 up to 120
DEMO_ALLOW_BACKDATE=true         # lets the script stamp past timestamps
DEMO_SHOW_TOKEN=true             # the script answers the e-Secure challenge

npm run dev                                                  # terminal 1
node scripts/simulate-population.js --users 120 --days 90     # terminal 2
node scripts/make-labeled-examples.js
```

Roughly 24,000 events across 120 customers and 90 days, in about 15 seconds.
Output:

| File | What it is |
| --- | --- |
| `out/ada-events.json` | Every event, sorted, in ADA's raw-event shape |
| `out/ada-labeled-examples.json` | A synthetic prior cycle, 240 treated + 240 control |

Feed both to ADA's offline worker — no Postgres, no Docker:

```bash
cd ../ADA_project
uv run python -m worker.main \
  --tenant-slug demo-wallet \
  --events  ../bank_demo/out/ada-events.json \
  --labeled ../bank_demo/out/ada-labeled-examples.json
```

### Three things that are easy to get wrong

**Timestamps.** Ninety days of history driven over live HTTP would carry ninety
days of identical timestamps, and every window ADA measures — recency, 30/60/90
day trends, neighbour activity now versus thirty days ago — would collapse.
Each request sends `X-Demo-Occurred-At`, which the server honours only when
`DEMO_ALLOW_BACKDATE` is on, and which moves the ADA event only: the ledger and
the printed receipt still say "now".

**Attribute names.** ADA's canonical event model whitelists exactly
`{channel, region_code, cohort_key}` and drops everything else without warning.
The demo users carry those keys, with `region_code` values that exist in
`ADA_project/fixtures/churn_scorer_mapping.json`. What the UI displays lives in
a separate `profile` field, so changing a label cannot quietly change pipeline
input.

**Labeled examples are not optional.** The IMPACT stage fits one model per arm
and refuses to run below `IMPACT_MIN_TRAIN_ROWS` (200) rows in each, and no
candidate exists without an impact score. Events alone give you churn risk and a
transaction graph and then zero recommendations. `make-labeled-examples.js`
measures `out/ada-events.json` and generates a prior cycle that matches that
distribution — run the simulation first, or the two disagree and the segment
split comes out meaningless.

### What it plants

The population is split across circles of eight, and two failure modes are
planted so the graph stage has something to distinguish:

- **`MARKET_DRIVEN`** — everyone in `cohort-3` goes quiet together. That is the
  only cohort carrying a negative COHORT signal in ADA's canned feed (-0.62),
  and the tag needs all three of a local dip, a cohort-wide median dip, and a
  negative signal.
- **`CIRCLE_SPECIFIC`** — half of two circles outside that cohort go quiet, so
  their neighbours' activity drops while the wider cohort carries on.

Both quiet windows are 34 days, deliberately longer than ADA's 30-day activity
window: a customer who went quiet three weeks ago still counts as active inside
it, and the dip would not register.
