-- Migration 035: Tariff Matrix (Customer Category × Water Type)
--
-- Converts the hardcoded CHECK constraints on customers.tariff_type,
-- invoices.tariff_type, and billing_settings.default_tariff into FKs
-- against customer_categories(code) — same values today, now extensible
-- without a schema change every time a category is added. Column names
-- are NOT renamed (see plan notes: 16+ files reference tariff_type
-- directly; an FK gets the same extensibility for far less blast radius
-- than a physical rename).
--
-- Adds a water_type dimension to water_tariffs so a tariff can vary by
-- (customer category × water type), not just customer category alone.
-- water_type_id is nullable: NULL means "generic — applies to any water
-- type", which is exactly what every existing water_tariffs row becomes
-- with zero backfill needed.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS before every ADD CONSTRAINT,
-- ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS throughout.

-- ──────────────────────────────────────────────────────────────────────
-- 1. customers.tariff_type / invoices.tariff_type / billing_settings.default_tariff:
--    hardcoded CHECK -> FK against customer_categories(code)
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tariff_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_tariff_type_fkey
  FOREIGN KEY (tariff_type) REFERENCES customer_categories(code);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tariff_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_tariff_type_fkey
  FOREIGN KEY (tariff_type) REFERENCES customer_categories(code);

ALTER TABLE billing_settings DROP CONSTRAINT IF EXISTS billing_settings_default_tariff_check;
ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_default_tariff_fkey
  FOREIGN KEY (default_tariff) REFERENCES customer_categories(code);

-- ──────────────────────────────────────────────────────────────────────
-- 2. water_tariffs: add water_type dimension, replace single-column
--    UNIQUE(tariff_code) with a compound-aware pair of partial unique
--    indexes (same idiom as idx_invoices_meter_period in 029).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE water_tariffs ADD CONSTRAINT water_tariffs_tariff_code_fkey
  FOREIGN KEY (tariff_code) REFERENCES customer_categories(code);

ALTER TABLE water_tariffs ADD COLUMN IF NOT EXISTS water_type_id UUID REFERENCES water_types(id);

ALTER TABLE water_tariffs DROP CONSTRAINT IF EXISTS water_tariffs_tariff_code_key;

-- Exactly one row per (tariff_code, water_type_id) when water_type_id is set...
CREATE UNIQUE INDEX IF NOT EXISTS idx_water_tariffs_code_watertype
  ON water_tariffs(tariff_code, water_type_id) WHERE water_type_id IS NOT NULL;
-- ...and at most one generic (water_type_id IS NULL = "any water type") row per category.
CREATE UNIQUE INDEX IF NOT EXISTS idx_water_tariffs_code_generic
  ON water_tariffs(tariff_code) WHERE water_type_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_water_tariffs_water_type ON water_tariffs(water_type_id);

-- No backfill UPDATE on existing water_tariffs rows: leaving water_type_id
-- NULL on them is the intended behavior (each becomes the generic
-- fallback rate for that category, for any water type, until an operator
-- adds a specific override row for a given water type).

-- ──────────────────────────────────────────────────────────────────────
-- VERIFY
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'water_tariffs' AND column_name = 'water_type_id'
  ) THEN
    RAISE EXCEPTION 'Migration 035 FAILED: water_tariffs.water_type_id not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'water_tariffs_tariff_code_key'
  ) THEN
    RAISE EXCEPTION 'Migration 035 FAILED: old water_tariffs_tariff_code_key still present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_tariff_type_fkey'
  ) THEN
    RAISE EXCEPTION 'Migration 035 FAILED: customers_tariff_type_fkey not found';
  END IF;
  RAISE NOTICE 'Migration 035 OK: tariff matrix (category x water type) in place.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback — not auto-executed)
-- ──────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_water_tariffs_water_type;
-- DROP INDEX IF EXISTS idx_water_tariffs_code_generic;
-- DROP INDEX IF EXISTS idx_water_tariffs_code_watertype;
-- ALTER TABLE water_tariffs ADD CONSTRAINT water_tariffs_tariff_code_key UNIQUE (tariff_code);
-- ALTER TABLE water_tariffs DROP COLUMN IF EXISTS water_type_id;
-- ALTER TABLE water_tariffs DROP CONSTRAINT IF EXISTS water_tariffs_tariff_code_fkey;
-- ALTER TABLE billing_settings DROP CONSTRAINT IF EXISTS billing_settings_default_tariff_fkey;
-- ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_default_tariff_check
--   CHECK (default_tariff IN ('residential','commercial','industrial','government'));
-- ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tariff_type_fkey;
-- ALTER TABLE invoices ADD CONSTRAINT invoices_tariff_type_check
--   CHECK (tariff_type IN ('residential','commercial','industrial','government','bulk_water','custom'));
-- ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tariff_type_fkey;
-- ALTER TABLE customers ADD CONSTRAINT customers_tariff_type_check
--   CHECK (tariff_type IN ('residential','commercial','industrial','government','bulk_water','custom'));
