-- Billing engine configuration (single row, upserted by id=1)
CREATE TABLE IF NOT EXISTS billing_settings (
  id                SERIAL      PRIMARY KEY,
  billing_cycle     VARCHAR(20) NOT NULL DEFAULT 'monthly'
                    CHECK (billing_cycle IN ('monthly','weekly','custom')),
  due_days          INTEGER     NOT NULL DEFAULT 14,
  default_tariff    VARCHAR(20) NOT NULL DEFAULT 'residential'
                    CHECK (default_tariff IN ('residential','commercial','industrial','government')),
  currency          VARCHAR(10) NOT NULL DEFAULT 'USD',
  auto_post_invoice BOOLEAN     NOT NULL DEFAULT true,
  auto_sync_odoo    BOOLEAN     NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        VARCHAR(100)
);

INSERT INTO billing_settings (id, billing_cycle, due_days, default_tariff, currency, auto_post_invoice, auto_sync_odoo)
VALUES (1, 'monthly', 14, 'residential', 'USD', true, true)
ON CONFLICT (id) DO NOTHING;

-- Extend billing_runs with totals and cancellation support
ALTER TABLE billing_runs ADD COLUMN IF NOT EXISTS total_consumption NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE billing_runs ADD COLUMN IF NOT EXISTS total_revenue     NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE billing_runs ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ;
ALTER TABLE billing_runs ADD COLUMN IF NOT EXISTS cancelled_by      VARCHAR(100);
ALTER TABLE billing_runs ADD COLUMN IF NOT EXISTS cancel_reason     TEXT;

-- Expand status enum: add pending_post (cycles created but invoices not yet posted) + cancelled
ALTER TABLE billing_runs DROP CONSTRAINT IF EXISTS billing_runs_status_check;
ALTER TABLE billing_runs ADD CONSTRAINT billing_runs_status_check
  CHECK (status IN ('running','pending_post','completed','partial','failed','cancelled'));

-- Extend billing_run_items with per-customer detail for history view
ALTER TABLE billing_run_items ADD COLUMN IF NOT EXISTS consumption      NUMERIC(14,3);
ALTER TABLE billing_run_items ADD COLUMN IF NOT EXISTS meter_number     VARCHAR(200);
ALTER TABLE billing_run_items ADD COLUMN IF NOT EXISTS billing_account  VARCHAR(100);
ALTER TABLE billing_run_items ADD COLUMN IF NOT EXISTS billing_cycle_id UUID REFERENCES billing_cycles(id) ON DELETE SET NULL;

-- Fix status constraint: migrate orphaned 'pending' default rows, then expand enum
UPDATE billing_run_items SET billing_status = 'skipped' WHERE billing_status = 'pending';
ALTER TABLE billing_run_items DROP CONSTRAINT IF EXISTS billing_run_items_billing_status_check;
ALTER TABLE billing_run_items ADD CONSTRAINT billing_run_items_billing_status_check
  CHECK (billing_status IN ('success','pending_post','skipped','failed'));
ALTER TABLE billing_run_items ALTER COLUMN billing_status SET DEFAULT 'failed';

CREATE INDEX IF NOT EXISTS idx_billing_run_items_cycle ON billing_run_items(billing_cycle_id);
