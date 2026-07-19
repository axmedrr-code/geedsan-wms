-- Migration 029: Billing Meter & Tariff Snapshots
-- Stores the exact meter state and tariff at invoice-generation time so that
-- historical invoices remain accurate even when rates or meter details change.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS meter_snapshot  JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tariff_snapshot JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reading_source  VARCHAR(50) DEFAULT 'meter_reading';

-- Prevent duplicate invoices for the same meter in the same billing period.
-- Partial index (WHERE meter_id IS NOT NULL) avoids conflicts on manual invoices
-- that don't reference a specific meter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_meter_period
  ON invoices (meter_id, billing_period_start, billing_period_end)
  WHERE meter_id IS NOT NULL
    AND billing_period_start IS NOT NULL
    AND billing_period_end   IS NOT NULL;

-- Compound index for billing-period queries on customer
CREATE INDEX IF NOT EXISTS idx_invoices_customer_period
  ON invoices (customer_id, billing_period_start DESC)
  WHERE billing_period_start IS NOT NULL;
