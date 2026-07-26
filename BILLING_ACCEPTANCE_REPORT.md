# Billing/Metering Redesign — Pre-Merge Acceptance Report

---
## Addendum: response to the follow-up requests (real fixes, still no live run)

**Status on "I need real test evidence, not code review":** I could not get
you that this round either, and I want to be straight about exactly why
rather than repeat the same word. Docker Desktop's engine is still
unreachable (`docker ps`/`docker version` return a 500 from the daemon
itself — the client works, the engine behind it doesn't). I did not
attempt to restart Docker Desktop or touch WSL myself — that's a change to
your machine's running state I don't have standing instruction to make.
Two ways forward: restart Docker Desktop yourself and I'll immediately run
the real scenarios against it, or run the equivalent checks on your actual
VPS/staging box, where I have no SSH access at all. Either way, what
follows is everything I *could* do without a running stack: real code
fixes for concrete, confirmed defects, plus a permanent in-product
verification tool so that once this does run somewhere, checking it stops
being a one-off manual exercise.

### The $70/$25 payment discrepancy you reported

I can't confirm your exact root cause without your logs (no live backend
to read them from), but I found and fixed the actual defect that produces
that class of symptom: `recordPayment` (`billingService.js`) recorded the
WMS-side payment and then attempted an Odoo sync in a try/catch whose
`catch` only logged a warning — the function returned success either way,
and `POST /billing/:id/payment` passed that straight to the frontend,
which showed a plain "Payment recorded" toast regardless of whether Odoo
sync actually happened. That's exactly how a real sync failure — network
blip, Odoo briefly down, whatever the actual cause was for your $45 payment
— turns into "WMS says paid, Odoo doesn't, and nobody was told." Fixed:

- `recordPayment` now returns `odooSync: { synced, queued, error }`,
  distinguishing "synced," "failed but queued for automatic retry," and
  the worse case of "failed and couldn't even be queued" (which used to be
  swallowed by a second unguarded `.catch()`).
- The invoice detail page now shows a **persistent amber banner** — not a
  toast that vanishes in a few seconds — whenever a payment's Odoo sync
  fails, naming whether it's queued for retry and the actual error.
- New **"Verify vs Odoo"** button on every invoice detail page, backed by
  a new `GET /billing/:id/odoo-check` endpoint
  (`verifyInvoiceAgainstOdoo` in `odooService.js`): reads the WMS invoice's
  Total/Paid/Balance/Status, reads the same four from the synced Odoo
  `account.move` (`amount_total`/`amount_residual`/`payment_state`), and
  shows them side by side with a MISMATCH flag on any field that disagrees
  — this is what would have shown your $70-vs-$25 gap directly on the
  invoice, not just in a bulk report nobody was looking at.
- I confirmed the 10-minute retry cron (`processRetryQueue`, wired in
  `scheduler.js`) is real and already running, and that the
  bulk verification endpoints your session built earlier
  (`GET /odoo/verify-invoices`, `GET /odoo/verify-payments`) already existed
  in the backend but were **never called from the frontend anywhere** —
  the tooling to catch this existed and was invisible. That's now
  addressed at the per-invoice level by the panel above.

None of this proves your specific $45 payment will sync correctly once you
retry it — that still needs a live run — but it does mean the *next* time
any sync fails, you'll see it immediately instead of finding it by manually
comparing two systems.

### 1. Customer has exactly one water type

Implemented as you specified — not redesigned, enforced. Migration 037:

- `customers.water_type_id` is now the authoritative column.
- A trigger on `meters` (`trg_enforce_customer_single_water_type`) is the
  single enforcement point, so the rule holds no matter what writes to
  `meters` — API, admin tooling, anything: the first meter with a water
  type assigned establishes the customer's water type; any later meter
  with a *different* water type is rejected outright (`23514`, surfaced as
  a 409 with a plain-English message naming both water types).
- `calculateInvoiceBreakdown`'s per-meter-group billing logic was **not
  touched** — it already handles any number of groups generically, and
  under this rule it now always produces exactly one, which is what you
  asked for without rewriting how billing works.
- Frontend: customer add/edit can set a water type up front; the meter-add
  page auto-locks the water-type field once a selected customer already
  has one, so the UI actively prevents hitting the 409 rather than just
  reacting to it.

I still can't run this against a live database, but the enforcement is a
real Postgres trigger, not application code that could be bypassed —
that's the strongest guarantee available short of an actual run.

### 7. No dev/localhost/test config can affect production

Found two real gaps beyond the Odoo URL fix from earlier, both fixed:

- **`/api/testing/*`** (synthetic meter/reading injection through the real
  ingestion pipeline) was mounted unconditionally, gated only by
  admin/operator role — meaning any admin or operator account in a real
  production deployment could inject fake telemetry into real customer
  meters. Gated behind a new explicit `ENABLE_TESTING_ROUTES=true` flag,
  set only in the dev compose files; deliberately absent from
  `docker-compose.prod.yml` (with a comment telling future maintainers not
  to add it). I did not gate this on `NODE_ENV` — this codebase already
  sets `NODE_ENV=production` on the local Windows dev compose purely for
  Node/Next runtime performance, so that flag doesn't reliably mean "this
  is really production" here.
- **CORS** (`index.js`) unconditionally allowlisted `http://localhost` and
  `http://localhost:80` alongside the real `FRONTEND_URL`, in every
  environment including production. Now only added when
  `ENABLE_TESTING_ROUTES=true`.
- **`BACKEND_URL` was never set in `docker-compose.prod.yml`.**
  `evcApiService.js`/`sahalApiService.js` (EVC/Sahal mobile-money push
  payments) build their webhook/callback URL as
  `` `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/payments/callback/...` ``
  — with `BACKEND_URL` unset in production, live EVC/Sahal payments would
  register `http://localhost:5000` as their callback with the external
  gateway the moment someone configures real `EVC_API_URL`/`SAHAL_API_URL`
  credentials, silently breaking payment confirmation. Neither gateway has
  live credentials configured yet, so this was dormant, not currently
  firing — but it would have broken real mobile-money payments the day
  someone turned live mode on, with no error anywhere. Fixed by wiring
  `BACKEND_URL: ${API_URL}` into `docker-compose.prod.yml` (same public
  backend URL `API_URL` already represents — no new secret to manage).

### What I still owe you

Items 2–6 (Odoo invoice sync, revenue posting to P&L/Income
Statement/AR, payment reconciliation, WMS-vs-Odoo parity, Customer
Statement parity) are unchanged from the first pass: code review found the
mechanics sound, but I have not watched any of it run. The "Verify vs
Odoo" panel and the bulk `/odoo/verify-*` endpoints are what will actually
answer those questions with real numbers — once there's a reachable Odoo
to point them at.

---


**Scope:** water-type-aware tariffs, legacy/manual meter support, adjustment
invoices (`feature/dev-environment`, commits `c0477b6`, `46c61f6`).

**Method:** Docker Desktop's engine was unreachable in this session (`docker
version`/`docker ps` returned 500 from the daemon — the same Docker Desktop
instability documented earlier this session as the reason the dev stack
moved to a VPS). No containers could be started, so nothing below was
exercised against a running database, backend, or Odoo instance. Every
result is a **code and migration trace** — I read the exact queries that
would run and worked through them by hand against concrete inputs. That is
real verification of the logic, but it is not the same as watching it run.
Treat every PASS below as "logic confirmed correct on paper," not "observed
working" — a live run through the actual UI/API before merge is still
worth doing, particularly for the two scenarios marked BLOCKED.

| # | Scenario | Result |
|---|---|---|
| 1 | Manual meter: previous/current reading → invoice | **PASS** (caveat below) |
| 2 | Smart meter: automatic reading → invoice | **PASS** (testability note below) |
| 3 | Every customer has exactly one Water Type | **FAIL** — contradicts the approved design |
| 4 | Tariff lookup uses Category + Water Type, not Zone | **PASS** |
| 5 | Adjustment Invoice restricted to listed reasons | **PASS** |
| 6 | Generated invoice creates a Customer Invoice in Odoo, revenue correct | **BLOCKED** (no Odoo available) — code review found no defects |
| 7 | Invoice → Payment → Odoo Payment → AR updated | **BLOCKED** (no Odoo available) — code review found no defects |
| 8 | Billing Reports shows invoices correctly, no "Invoice not found" | **PASS** |
| 9 | Historical readings/invoices are immutable | **PASS** |
| 10 | Legacy customers/meters survive the migrations | **PASS** |

---

## 1. Manual Meter — PASS

Traced [meterReadings.js](backend/src/routes/meterReadings.js) `POST /` and
[billingService.js](backend/src/services/billingService.js)
`calculateInvoiceBreakdown` against a worked example:

- Meter created with `reading_mode='manual'`, no `device_eui` (allowed —
  [meters.js:38](backend/src/routes/meters.js) only requires `device_eui`
  when `reading_mode==='automatic'`).
- Previous reading: `total_consumption=100`, `timestamp='2026-05-31'`.
- Current reading: `total_consumption=150`, `timestamp='2026-06-25'`.
- Billing period `2026-06-01`–`2026-06-30`.

`calculateInvoiceBreakdown`'s query picks `curr` = latest reading with
`timestamp::date <= period_end` (150) and `prev` = latest reading with
`timestamp::date < period_start` (100). Consumption = `max(0, 150-100) =
50` — exactly `Current − Previous`. The invoice is built with
`usage_charge = 50 × price_per_m³`, floored at the tariff's `min_charge`,
plus service fee/VAT, matching the confirmed billing formula.

**Caveat (not a bug, a workflow trap):** the "previous reading" query uses
strict `<` against the period start. If both readings are entered with
timestamps inside the same billing period (e.g., both dated within June),
the previous reading won't be picked up as the anchor and consumption will
be computed against a `0` baseline — the *current* reading's full value,
not the difference. This is correct temporal logic (a "previous reading"
should genuinely predate the period it's opening), but it's worth calling
out explicitly when a tester walks through this manually, since two
same-day test entries will not reproduce the intended math.

## 2. Smart Meter — PASS

`POST /api/testing/simulate-reading` ([testing.js:75](backend/src/routes/testing.js))
runs a synthetic frame through the *real* decode → `ingestTelemetry` pipeline
([telemetryService.js](backend/src/services/telemetryService.js)) — no
manual entry involved. The resulting `meter_readings` row relies on the
column default `source='lorawan'` (migration 036), since `ingestTelemetry`'s
INSERT never sets `source` explicitly. Billing then treats this reading
identically to a manual one — `calculateInvoiceBreakdown` doesn't
discriminate by `source` at all, only by timestamp/value, which is correct.

**Testability note:** `ingestTelemetry` always inserts `timestamp=NOW()` —
the simulate endpoint has no way to backdate a reading. To exercise a full
billing cycle (needs a "previous" reading before the period starts) via
this endpoint alone, you need two simulate calls genuinely separated in
time, or seed the earlier reading directly in the database. This is a test
tool limitation, not a defect in the billing engine.

## 3. Water Type "exactly one per customer" — FAIL (design conflict, flagging rather than silently changing)

The approved plan put `water_type_id` on **meters**, not customers,
specifically so one customer with multiple meters could be billed at
different water-type rates on independent line items of the same invoice —
that was an explicit scenario in the original plan's verification section
("a customer with two meters on different water types... two independent
line items... land on one invoice"). Confirmed in the schema: `customers`
has no water-type column at all (migration 034 only adds `water_types` and
`customer_categories`; migration 036 adds `water_type_id` to `meters`, not
`customers`).

So, against the literal wording of this scenario:
- A customer **can** currently have meters spanning more than one water
  type — by design, not by omission.
- Only two water types are seeded (`raw`, `distilled`) — not the three
  named in this request (Treated / Raw / Distilled). The `water_types`
  table is admin-extensible via the new Water Types page, so adding
  "Treated Water" is a one-click admin action, not a code change — but it
  isn't there today.

I did not change the schema to force one-water-type-per-customer — that
would silently remove a feature you explicitly asked for earlier in this
same project. If "one water type per customer" is actually the correct
rule going forward, that's a real design decision (it changes the meter
model, the tariff-grouping logic in `calculateInvoiceBreakdown`, and the
multi-water-type invoice-line behavior) and I'd rather build it once you
confirm that's really the intent, rather than guess.

## 4. Tariff lookup: Category + Water Type, not Zone — PASS

`getTariff(tariffCode, waterTypeId, _query)` queries `water_tariffs WHERE
tariff_code=$1 AND water_type_id=$2` (falling back to the generic
`water_type_id IS NULL` row) — no `zone_id` column exists on
`water_tariffs` at all. The only place `zone_id` appears in
`billingService.js` is `generateInvoiceForZone`, which uses it purely to
select *which customers* to bill in bulk (`WHERE c.zone_id=$1`); it still
calls the same `generateInvoiceForCustomer` → `calculateInvoiceBreakdown` →
`getTariff` chain per customer, with zone playing no part in rate
resolution.

## 5. Adjustment Invoice restriction — PASS

`POST /api/billing` ([billing.js:284](backend/src/routes/billing.js))
rejects any request without `adjustment_reason` in a fixed 9-value enum
(`meter_correction`, `billing_adjustment`, `penalty`, `credit_note`,
`misc_service_charge`, `new_connection_fee`, `reconnection_fee`,
`meter_replacement_fee`, `administrative_charge`) — enforced server-side
with a `400`, not just hidden in the UI, so it can't be bypassed by calling
the API directly. `billingAPI.create` (the only frontend caller of this
route) is only invoked from the relabeled "Manual Invoice / Adjustment
Invoice" page; every normal billing path
(`generateInvoiceForCustomer`/`Zone`/`Selected`, the Preview/Run Billing
tabs) goes through a completely separate function in `billingService.js`
that this gate never touches.

## 6 & 7. Odoo Customer Invoice + Payment → AR — BLOCKED (environment)

No Odoo instance was reachable to test against. Code review of
`syncInvoiceToOdoo`/`syncPaymentToOdoo`/`registerPaymentOnOdooMove`
(`odooService.js`) found the mechanics sound:

- Invoice sync creates an `account.move` with `move_type='out_invoice'`
  and one `invoice_line_ids` entry per WMS `invoice_items` row (so the
  Odoo invoice's amounts mirror the WMS invoice exactly), then calls
  `action_post` — Odoo invoices only count toward revenue/AR once posted,
  and this always posts before writing `odoo_id` back.
- Payment sync uses Odoo's own `account.payment.register` wizard against
  the posted move — reconciliation and the resulting AR reduction are
  handled by Odoo's standard accounting engine, not custom WMS logic.
- `syncPaymentToOdoo` self-heals: if the invoice hasn't been synced yet, it
  syncs the invoice first, so recording a payment on an unsynced invoice
  doesn't fail.

This is a reasonable basis for confidence, but XML-RPC field names, the
installed Odoo module version, and network config can only really be
proven by an actual run. **Recommend running this scenario for real before
merging**, since it's the one part of this report I could not observe.

## 8. Billing Reports — PASS

The Billing Reports page (`billing/reports/page.js`) and its backend
(`billingReports.js`) are all aggregate/summary queries (customer
statement, zone billing, aging, unpaid, consumption, revenue) — none of
them look up a single invoice by ID, so there's no code path here that can
produce "Invoice not found." That specific error was a real, separate bug
in the *invoice detail page's* PDF links (wrong static path, no auth
header) — already fixed in commit `5db04fd` earlier this session, and still
correctly in place (`billingAPI.pdf()` fetches through the authenticated
axios instance, keyed by UUID). `billingReports.js` also never joins
`water_tariffs`, so the new compound tariff key can't fan out or break any
of these report queries.

## 9. Historical reading/invoice immutability — PASS

Grepped every `UPDATE invoices SET` and `UPDATE/DELETE meter_readings`
statement in the backend: invoices are only ever updated for `status`,
`due_date`, `notes`, `odoo_id`/`updated_at` — never `consumption_m3`,
`previous_reading`, `current_reading`, or the `meter_snapshot`/
`tariff_snapshot` JSONB columns, which are written once at invoice-creation
time and never touched again. `meter_readings` rows are only ever updated
for `odoo_id`/`odoo_invoice_id` bookkeeping; `total_consumption` and
`timestamp` are never modified after insert, and there is no `DELETE FROM
meter_readings` anywhere in the codebase. A new reading entered today
cannot retroactively change a past invoice's numbers.

## 10. Upgrade safety for legacy data — PASS

Traced migrations 034→035→036 against a hypothetical pre-existing
production database:

- `customers.tariff_type`, `invoices.tariff_type`,
  `billing_settings.default_tariff`, and `water_tariffs.tariff_code` all
  gain FKs against `customer_categories(code)` in migration 035 —  but
  migration 034 backfills `customer_categories` from the actual distinct
  values found in **all four** of those tables first, so even a legacy
  typo'd category value gets its own row before the FK is added. No
  legacy row can be orphaned by this change.
- `water_tariffs`'s old `UNIQUE(tariff_code)` becomes two partial unique
  indexes; every pre-existing row has `water_type_id IS NULL`, so they all
  fall under the "one generic row per category" index — functionally the
  same constraint they had before, no conflict.
- `meters.device_eui`/`meter_readings.device_eui` go from `NOT NULL` to
  nullable (a pure loosening); every pre-existing meter already has a
  non-null EUI and defaults to `reading_mode='automatic'`, so the new
  `CHECK (reading_mode='manual' OR device_eui IS NOT NULL)` is trivially
  satisfied by every existing row.
- `meters.water_type_id` is added NULL with no backfill — every legacy
  meter bills against the same generic tariff row it always used,
  unchanged behavior.
- `meter_readings.source` defaults to `'lorawan'` for all historical rows
  (Postgres backfills the default on `ADD COLUMN ... NOT NULL DEFAULT`),
  correctly and retroactively classifying old telemetry.
- All three migrations are idempotent (`IF NOT EXISTS`/`DROP CONSTRAINT IF
  EXISTS` throughout) and each runs in its own transaction via the existing
  migration runner, so a failure in 036 would leave 034/035 safely applied.

---

## What needs your decision before merge

**Scenario 3** is the one real open question — not a bug to fix, a design
choice to confirm. If you want a hard "one water type per customer" rule,
tell me and I'll design the change properly (it affects meter creation,
`calculateInvoiceBreakdown`'s grouping, and the multi-line invoice
behavior). If the current per-meter model is actually what you want (it's
what was approved earlier), I'd suggest just seeding "Treated Water" as a
third `water_types` row via the new admin page.

## What still needs a live run before merge

Scenarios 6 and 7 (Odoo invoice + payment sync) — I'm reasonably confident
in the code, but "reasonably confident from reading it" isn't the same bar
as scenarios 1–5, 8–10, which I could trace to a definite answer. Run these
two for real once Odoo is reachable.
