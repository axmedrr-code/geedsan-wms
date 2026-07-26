-- Migration 034: Water Types + Customer Categories
--
-- Extracts two concepts that were previously hardcoded CHECK constraints
-- (customers.tariff_type's allowed values, and the implicit single water
-- type every meter was assumed to dispense) into real, extensible tables.
-- Neither existing column is renamed or dropped here — see 035 for how
-- customers.tariff_type gets an FK against customer_categories instead of
-- its hardcoded CHECK, and meters.water_type_id (added in 036) references
-- water_types.
--
-- Idempotent: all CREATE TABLE use IF NOT EXISTS, all INSERTs use
-- ON CONFLICT DO NOTHING. No existing rows are touched.

CREATE TABLE IF NOT EXISTS water_types (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(30) UNIQUE NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO water_types (code, name, description, is_default) VALUES
  ('raw',       'Raw Water',       'Untreated/raw water supply',       true),
  ('distilled', 'Distilled Water', 'Treated/distilled water supply',   false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_categories (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(30) UNIQUE NOT NULL,  -- same domain as customers.tariff_type today
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO customer_categories (code, name) VALUES
  ('residential', 'Residential'),
  ('commercial',  'Commercial'),
  ('industrial',  'Industrial'),
  ('government',  'Government'),
  ('bulk_water',  'Bulk Water'),
  ('custom',      'Custom')
ON CONFLICT (code) DO NOTHING;

-- Defensive backfill: pick up any category codes already present in live
-- data that aren't in the fixed seed list above, so the FK added in 035
-- never fails against real production rows.
INSERT INTO customer_categories (code, name)
  SELECT DISTINCT tariff_type, initcap(replace(tariff_type, '_', ' '))
  FROM customers
  WHERE tariff_type IS NOT NULL
    AND tariff_type NOT IN (SELECT code FROM customer_categories)
ON CONFLICT (code) DO NOTHING;

INSERT INTO customer_categories (code, name)
  SELECT DISTINCT tariff_code, initcap(replace(tariff_code, '_', ' '))
  FROM water_tariffs
  WHERE tariff_code NOT IN (SELECT code FROM customer_categories)
ON CONFLICT (code) DO NOTHING;

INSERT INTO customer_categories (code, name)
  SELECT DISTINCT tariff_type, initcap(replace(tariff_type, '_', ' '))
  FROM invoices
  WHERE tariff_type IS NOT NULL
    AND tariff_type NOT IN (SELECT code FROM customer_categories)
ON CONFLICT (code) DO NOTHING;

INSERT INTO customer_categories (code, name)
  SELECT DISTINCT default_tariff, initcap(replace(default_tariff, '_', ' '))
  FROM billing_settings
  WHERE default_tariff NOT IN (SELECT code FROM customer_categories)
ON CONFLICT (code) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_water_types_active ON water_types(is_active);
CREATE INDEX IF NOT EXISTS idx_customer_categories_active ON customer_categories(is_active);

-- ──────────────────────────────────────────────────────────────────────
-- VERIFY
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'water_types') THEN
    RAISE EXCEPTION 'Migration 034 FAILED: water_types table not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_categories') THEN
    RAISE EXCEPTION 'Migration 034 FAILED: customer_categories table not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM water_types WHERE code = 'raw' AND is_default = true) THEN
    RAISE EXCEPTION 'Migration 034 FAILED: default water type "raw" not seeded';
  END IF;
  RAISE NOTICE 'Migration 034 OK: water_types and customer_categories created and seeded.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback — not auto-executed)
-- ──────────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS customer_categories;
-- DROP TABLE IF EXISTS water_types;
