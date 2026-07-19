-- Migration 024: Billing Engine Phase 4
-- Adds: water_tariffs table, invoice billing period/consumption columns,
--       bulk_water and custom tariff types, billing stats view.
-- Safe: all ADD COLUMN uses IF NOT EXISTS; all INSERTs use ON CONFLICT DO NOTHING.

-- ── 1. water_tariffs table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS water_tariffs (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  tariff_code   VARCHAR(30)   UNIQUE NOT NULL,
  name          VARCHAR(100)  NOT NULL,
  description   TEXT,
  min_charge    NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_per_m3  NUMERIC(10,4) NOT NULL DEFAULT 0,
  service_fee   NUMERIC(10,2) NOT NULL DEFAULT 0,
  vat_rate      NUMERIC(5,2)  NOT NULL DEFAULT 0,
  penalty_rate  NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_rate NUMERIC(5,2)  NOT NULL DEFAULT 0,
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_by    UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_water_tariffs_code ON water_tariffs(tariff_code);
CREATE INDEX IF NOT EXISTS idx_water_tariffs_active ON water_tariffs(is_active);

-- ── 2. Extend invoices with billing period, readings, and tariff breakdown ────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period_start DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS billing_period_end   DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS consumption_m3       NUMERIC(12,3);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_reading     NUMERIC(12,3);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS current_reading      NUMERIC(12,3);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS meter_id             UUID REFERENCES meters(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS subtotal             NUMERIC(14,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_amount           NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_fee_amount   NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_amount      NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoices_billing_period ON invoices(billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_invoices_meter ON invoices(meter_id) WHERE meter_id IS NOT NULL;

-- ── 3. Extend tariff_type CHECK in invoices ────────────────────────────────────
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tariff_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_tariff_type_check
  CHECK (tariff_type IN ('residential','commercial','industrial','government','bulk_water','custom'));

-- ── 4. Extend tariff_type CHECK in billing_settings ───────────────────────────
ALTER TABLE billing_settings DROP CONSTRAINT IF EXISTS billing_settings_default_tariff_check;
ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_default_tariff_check
  CHECK (default_tariff IN ('residential','commercial','industrial','government','bulk_water','custom'));

-- ── 5. Extend tariff_type CHECK in customers ──────────────────────────────────
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tariff_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_tariff_type_check
  CHECK (tariff_type IN ('residential','commercial','industrial','government','bulk_water','custom'));

-- ── 6. Seed default water tariffs ────────────────────────────────────────────
INSERT INTO water_tariffs (tariff_code, name, description, min_charge, price_per_m3, service_fee, vat_rate) VALUES
  ('residential', 'Residential',  'Standard household tariff',           2.00, 1.20, 1.50, 0),
  ('commercial',  'Commercial',   'Business & commercial premises',       5.00, 1.80, 3.00, 0),
  ('industrial',  'Industrial',   'Industrial high-volume usage',        10.00, 2.40, 5.00, 0),
  ('government',  'Government',   'Government buildings & facilities',    3.00, 1.00, 2.00, 0),
  ('bulk_water',  'Bulk Water',   'Bulk tanker & wholesale supply',      15.00, 0.80, 0.00, 0),
  ('custom',      'Custom',       'Custom rate — configured per account', 0.00, 1.00, 0.00, 0)
ON CONFLICT (tariff_code) DO NOTHING;
