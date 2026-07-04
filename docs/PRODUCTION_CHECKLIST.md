# Production Readiness Checklist

State as of this stabilization pass — each item below was actually
verified against the running stack, not just written. For the *how*, see
`docs/PRODUCTION_DEPLOYMENT.md` (VPS/SSL/domain) and
`docs/HARDWARE_ONBOARDING.md` (real meter onboarding).

## 1. Real meter onboarding
- [x] DevEUI/AppKey join flow documented and verified against ChirpStack's
      actual device table (`docs/HARDWARE_ONBOARDING.md`).
- [x] Gateway self-registration verified (no manual provisioning step).
- [ ] **Action needed**: run through the full checklist with an actual
      physical meter once hardware is available — everything here was
      validated with synthetic frames through the real decode pipeline,
      not yet a real device on real RF.

## 2. Telemetry validation
- [x] Shengda protocol decoder verified byte-for-byte against the vendor
      PDF's own worked examples (checksum, status words, historical flow,
      and the OTA config encoder all independently cross-checked).
- [x] MQTT and HTTP webhook ingestion paths verified to produce identical
      results for the same input.
- [x] Gateway/meter online-offline state transitions verified.

## 3. Billing accuracy
- [x] **Bug fixed**: `billing_cycles.status` was being collapsed to a
      blanket `'posted'` on any non-full payment, losing the `overdue`
      distinction that `invoices.status` correctly tracked — fixed to
      mirror the real status.
- [x] **Bug fixed**: `markOverdueInvoices` (daily cron) updated
      `invoices.status` but never propagated to the linked
      `billing_cycles.status` — same fix applied there.
- [x] Verified the duplicate-invoice guard (`invoice_number` uniqueness +
      `billing_cycles.invoice_id`) is unaffected by the above fix.
- [ ] **Known limitation, not fixed (would require a billing-model
      change)**: `calculateUsageAmount` uses `MAX(total_consumption) -
      MIN(total_consumption)` within the billing window. If a meter is
      replaced/reset mid-period, or a corrupted-but-checksum-valid frame
      reports a spurious value, this can over/under-charge. Mitigate by
      reviewing any meter that had a `metering_fault`/`battery_removed`
      alarm during its billing period before finalizing that invoice.
- [ ] **Not implemented (flagged, not silently built — these are real
      features, not bugs)**: VAT/tax line items, tiered/penalty pricing
      beyond the flat per-tariff rate. Confirm whether your billing needs
      these before going live with real customer invoices.

## 4. Uptime monitoring
- [x] `/dashboard/system-health` — DB, MQTT, backend, frontend, Odoo,
      ChirpStack checked live (HTTP/DB/MQTT-level, not container-level).
- [x] Restart notification verified wired (skips the noisy first-ever-boot case).
- [ ] **Known limitation, explicitly not built**: no per-container restart
      tracking for the full Docker stack — that requires mounting the
      Docker socket (root-equivalent access to the host) or an external
      tool (cAdvisor/Prometheus, Watchtower). Deliberately not added
      without a separate decision, since it's a real privilege tradeoff.

## 5. Backup / recovery
- [x] **Actually executed** `scripts/backup.sh` against the live stack —
      not just code-reviewed. Produced real dumps for all 3 databases.
- [x] **Actually executed** `scripts/restore.sh`'s restore path into a
      throwaway database and verified table count (24/24) and row counts
      (users/customers/meters/alarms/invoices) match the original exactly.
- [x] `backup_log` correctly recorded the run, visible on System Health.
- [ ] **Action needed**: set up the cron schedule (`docs/PRODUCTION_DEPLOYMENT.md`
      §5) and off-box sync — backups currently only exist locally and only
      run when triggered manually.

## 6. Security review
- [x] SQL injection: audited every dynamic-WHERE-clause route — confirmed
      all user input goes through parameterized `$N` placeholders; only
      static SQL structure is ever string-interpolated.
- [x] **Vulnerability found and fixed**: `POST /api/reports/generate`
      interpolated unvalidated `report_type`/`file_type` directly into a
      filesystem path (`path.join` resolves `../`), letting *any*
      authenticated user (no role check existed) write/read files outside
      `REPORTS_DIR`. Fixed with a whitelist on the write side and a
      path-containment check on the download side (defense in depth).
- [x] CORS confirmed scoped to a fixed origin list, not wildcard.
- [x] `.env` confirmed git-ignored; no secrets in tracked files.
- [x] Auth: JWT-based, role-gated (admin/operator/viewer) consistently
      across mutating routes — reviewed all `POST`/`PUT`/`DELETE` routes;
      the few missing `authorize()` (AI analysis, notification settings,
      report generation) are intentionally viewer-accessible (read/analysis
      actions scoped to the user's own data), not oversights.
- [ ] **Re-verified, not fixed (deliberately — see below)**: `npm audit` in
      `backend/` shows 2 real issues:
      - **High**: `nodemailer` ≤9.0.0 (several CVEs — SMTP/CRLF command
        injection, SSRF via the `raw` message option). This package is
        actively used in `notificationService.js` for email alarm
        delivery, so this is a real exposure, not a transitive
        dependency you can ignore.
      - **Moderate**: `uuid` <11.1.1, pulled in transitively via
        `exceljs` (used for report Excel export) — lower direct risk.
      Both fixes are major-version bumps (`npm audit fix --force` →
      nodemailer 6→9, uuid major bump) that change library APIs —
      **not applied here** since that's exactly the kind of
      change this stabilization pass is scoped to avoid without testing
      first. Recommend upgrading `nodemailer` specifically (it's the high
      one and it's network-facing) in a dedicated, tested change before
      relying on email alerts in production.

## 7. Deployment hardening
- [x] nginx reverse proxy live and healthy, fronting both API and frontend.
- [x] Production logging: winston (console + file), process-level crash
      handlers, no silently-swallowed errors.
- [x] All containers confirmed healthy with zero errors in logs at time of
      this review.
- [ ] **Action needed before going live** (see `docs/PRODUCTION_DEPLOYMENT.md` §6):
      change `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHIRPSTACK_API_SECRET`,
      all DB passwords, ChirpStack's `admin`/`admin` bootstrap password,
      and the demo NUWACO accounts (`admin`/`admin123` etc.) from their
      current development defaults.
- [ ] SSL/domain not yet configured (no domain assigned to this
      environment) — steps ready in `docs/PRODUCTION_DEPLOYMENT.md` §3-4.
