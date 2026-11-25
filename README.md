# Tawseel (توصيل)

A delivery dispatch and tracking system for Egyptian delivery teams, in Arabic (RTL) and English.

**Live demo:** https://tawseel-gray.vercel.app  (sample data only, resets every 6 hours)

Product direction and scope: Nada Gamal. Implementation: AI-assisted. This is a demonstration build, not a production deployment for a real delivery company.

## What it does

- **Customer tracking** by code (`TWS-XXXXXX`): stage, estimated arrival, delay notice, driver first name. No phone number, street or internal notes are exposed.
- **Dispatcher dashboard:** order board by stage, orders table with filters, new order form with a live fee quote, assign / reassign / remove driver, cancel with reason, retry failed deliveries (max 3 attempts), alerts, driver list, zones and fee rules, performance stats.
- **Driver view (mobile first):** accept or decline, picked up, delivered with a proof note and cash collected, or "could not deliver" with a reason. Works with no signal.
- **Fee rules:** zone base fee, free weight allowance and per-kg surcharge, express multiplier, night surcharge (22:00 to 06:00 Cairo time), free delivery over a threshold (waives the base fee only, never for express), cash on delivery fee (1%, min 5, max 25 EGP).
- **SLA and alerts:** each zone has a delivery target (express is 60% of it). The board flags at risk, late, no driver yet, driver has not accepted, not picked up, driver went offline, delivery failed.
- **Cash on delivery control:** the driver enters the cash collected. A mismatch is stored and flagged, not hidden.
- **Roles:** admin, dispatcher, driver, viewer. Enforced on the server. Viewers get masked phone numbers. Drivers only see their own orders.
- **Arabic and English**, full RTL, Egyptian phone validation (accepts Arabic digits and `+20`).

## Stack

Vanilla JS front end (no build step), Vercel serverless function for the API, Vercel Blob for state. Business rules live in `lib/core.js` as pure functions and are unit tested.

```
lib/core.js      fees, SLA, state machine, validation, alerts, stats (pure)
lib/service.js   API routes, roles, idempotency, rate limit
lib/store.js     Blob store (versioned, optimistic concurrency) and memory store
lib/seed.js      sample day of orders, built by replaying real actions
api/index.js     Vercel function entry
public/          pages, i18n (AR/EN), service worker
test/            unit and API tests (node:test)
e2e/run.mjs      browser end-to-end test (puppeteer-core)
```

## Run it

```
npm install
npm run dev        # http://localhost:4173, in-memory data
npm test           # 33 unit and API tests
BASE=http://localhost:4173 npm run e2e
```

## Tests

- 33 unit and API tests: fee rules (each rule and combination), night window across midnight, phone and code validation, every state transition and refusal, roles, idempotency, SLA states, alerts, stats, public tracking privacy, rate limit, 6-hour reset.
- 18 browser end-to-end checks against the live deployment: full order life (create, assign, accept, pick up, deliver, tracking page), form validation, offline queue and sync, a queued action refused by the server after a reassignment, Arabic RTL, admin fee edit, viewer limits, 8 simultaneous writes.

## Honest limits

- **Demo sign-in has no passwords.** It is a role picker. Tokens are signed and expire after 12 hours, and the server enforces what each role can do, but do not put real customer data in it.
- **No live GPS.** Tracking shows the delivery stage and an SLA based estimate, not a vehicle position. The map is an illustration of the stage.
- **Estimated arrival is the zone target** (or now plus 15 minutes when late). It is not a routing estimate.
- **No SMS or WhatsApp sending.** Tracking codes are shown on screen; nothing is sent to customers.
- **One shared demo dataset.** All visitors see and change the same orders. Each save writes a new version, so simultaneous writers cannot overwrite each other; under heavy load a write can answer "busy" and should be retried.
- **Offline support covers the driver's actions** (accept, pick up, deliver, fail, decline) and the app shell. Order lists need a first online load. An action refused by the server on sync (for example the order was reassigned) is dropped and the driver is told.
- The night window is evaluated in the Africa/Cairo time zone using the platform time zone database.

## Screenshots

See `docs/screenshots/`.
