# Customer Statement Feature — Deployment Notes

Covers commit `0824e7c` on `feature/dev-environment`: extended customer
statement (opening balance, chronological running-balance ledger, aging,
PDF export) and new invoice/payment Odoo sync verification endpoints.

## Correction on scope, checked before writing this

This feature does **not** touch `addons/nuwaco_wms` (the Odoo Python
module) and does **not** add any database migration. Verified directly
against the commit, not assumed:

```bash
git show 0824e7c --stat | grep -c "addons/\|migrations/"
# → 0
```

The six files it actually changed: `backend/src/routes/billingReports.js`,
`backend/src/routes/odoo.js`, `backend/src/services/odooService.js`,
`frontend/src/app/dashboard/customers/[id]/page.js`,
`frontend/src/lib/api.js`, `.claude/launch.json`. `res_partner.py` and
`account_move.py` were only *read* during the earlier architecture
investigation, never edited.

(The `nuwaco_wms` module install/upgrade — `-u nuwaco_wms
--stop-after-init` — belongs to the earlier, separate incident fix
documented in `docs/EMERGENCY_RECOVERY_GUIDE.md`. That module already
needs to be installed for Odoo sync to work at all, but that's a
pre-existing prerequisite of the *whole system*, not something this
feature newly requires.)

## What deployment actually requires

Every new query in this feature (opening balance, ledger, aging, sync
verification) reads from tables/columns that already existed in
`backend/migrations/000_baseline_schema.sql` before this feature:
`customers.odoo_id` (line 37), `invoices.odoo_id` (line 255),
`invoice_payments.odoo_id` (line 301), `odoo_sync_queue` (line 327).
Nothing new was added to reach them.

**Required:** a standard code deploy — nothing else.
```bash
git pull origin feature/dev-environment   # once merged to main: git pull origin main
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build backend frontend
```

**Not required:**
- Odoo module upgrade (`-u nuwaco_wms`) — no Odoo-side code changed.
- Any migration — none exists in this commit.
- Any specific ordering between backend/frontend/Odoo — since neither a
  migration nor an Odoo change is in play, there's no sequencing concern;
  restart both containers whenever convenient.

## Data risk

Every new/changed code path in this feature — `buildCustomerStatement()`,
`verifyInvoiceSync()`, `verifyPaymentSync()`, and the PDF route — issues
`SELECT` queries only (plus read-only `account.move`/`account.payment`
reads over XML-RPC for verification). **Nothing in this feature writes to
the database.** Combined with zero migrations, there is no schema risk
and no data-mutation risk to production from deploying it.

## Rollback

Pure code revert — no migration to reverse, no Odoo module state to undo:
```bash
git revert 0824e7c   # or redeploy the previous backend/frontend image
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build backend frontend
```
Safe to roll back at any time; no data was written or restructured by
this feature in either direction.
