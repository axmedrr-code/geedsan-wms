-- Migration 021: House Number redesign + Zone Management + Meter Replace workflow
--
-- Changes:
--   1. Rename customers.house_number → address_ref  (free up the column name)
--   2. Rename customers.customer_number → house_number  (permanent customer identifier)
--   3. Create zones table (zone management)
--   4. Add zone_id FK to customers and meters
--   5. Add 'replaced' to meters.status allowed values
--   6. Add serial_number, replacement_reason, replaced_at to meters
--   7. Seed default zones (ZA–ZD) and assign existing records to ZA
--
-- Data safety: all UUID references (customer_id, meter_id on readings/alarms/invoices)
-- are unchanged. No records are deleted. Fully reversible (see DOWN section).
-- Idempotent: all ADD COLUMN / CREATE TABLE use IF NOT EXISTS.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Rename house_number → address_ref (free up the name)
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'house_number'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'address_ref'
  ) THEN
    ALTER TABLE customers RENAME COLUMN house_number TO address_ref;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Rename customer_number → house_number (permanent customer ID)
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'customer_number'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'house_number'
  ) THEN
    ALTER TABLE customers RENAME COLUMN customer_number TO house_number;
  END IF;
END $$;

-- Ensure the unique index is present on the renamed column
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_house_number_unique ON customers(house_number)
  WHERE house_number IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Zones table
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS zones (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  zone_code   VARCHAR(10) UNIQUE NOT NULL,
  zone_name   VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────────────
-- 4. Add zone_id to customers and meters
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE customers ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES zones(id) ON DELETE SET NULL;
ALTER TABLE meters    ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES zones(id) ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 5. Add 'replaced' to meters.status allowed values
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  con TEXT;
BEGIN
  -- Drop any existing CHECK constraint on status so we can recreate with 'replaced'
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'meters'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE 'ALTER TABLE meters DROP CONSTRAINT ' || quote_ident(con);
  END LOOP;

  ALTER TABLE meters ADD CONSTRAINT meters_status_check
    CHECK (status IN ('active','inactive','faulty','removed','replaced'));
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- 6. Meter Replace workflow fields
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE meters ADD COLUMN IF NOT EXISTS serial_number       VARCHAR(100);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS replacement_reason  TEXT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS replaced_at         TIMESTAMPTZ;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS replaced_by_meter_id UUID REFERENCES meters(id) ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 7. Seed default zones and assign existing records to ZA
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO zones (zone_code, zone_name, description, status) VALUES
  ('ZA', 'Garowe Central', 'Garowe Central district', 'active'),
  ('ZB', 'Garowe East',    'Garowe East district',    'active'),
  ('ZC', 'Garowe West',    'Garowe West district',    'active'),
  ('ZD', 'Garowe North',   'Garowe North district',   'active')
ON CONFLICT (zone_code) DO NOTHING;

-- Assign unzoned customers and meters to ZA
UPDATE customers SET zone_id = (SELECT id FROM zones WHERE zone_code = 'ZA')
  WHERE zone_id IS NULL;

UPDATE meters SET zone_id = (SELECT id FROM zones WHERE zone_code = 'ZA')
  WHERE zone_id IS NULL;

-- ──────────────────────────────────────────────────────────────────────
-- 8. Indexes
-- ──────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_customers_zone_id        ON customers(zone_id);
CREATE INDEX IF NOT EXISTS idx_meters_zone_id           ON meters(zone_id);
CREATE INDEX IF NOT EXISTS idx_meters_status            ON meters(status);
CREATE INDEX IF NOT EXISTS idx_meters_replaced_by       ON meters(replaced_by_meter_id) WHERE replaced_by_meter_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- VERIFY
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'house_number'
  ) THEN
    RAISE EXCEPTION 'Migration 021 FAILED: customers.house_number not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'zones') THEN
    RAISE EXCEPTION 'Migration 021 FAILED: zones table not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meters' AND column_name = 'serial_number'
  ) THEN
    RAISE EXCEPTION 'Migration 021 FAILED: meters.serial_number not found';
  END IF;
  RAISE NOTICE 'Migration 021 OK: house_number renamed, zones created, meter replace fields added.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback — not auto-executed)
-- ──────────────────────────────────────────────────────────────────────
-- ALTER TABLE meters DROP COLUMN IF EXISTS replaced_by_meter_id;
-- ALTER TABLE meters DROP COLUMN IF EXISTS replaced_at;
-- ALTER TABLE meters DROP COLUMN IF EXISTS replacement_reason;
-- ALTER TABLE meters DROP COLUMN IF EXISTS serial_number;
-- ALTER TABLE meters DROP CONSTRAINT IF EXISTS meters_status_check;
-- ALTER TABLE meters ADD CONSTRAINT meters_status_check CHECK (status IN ('active','inactive','faulty','removed'));
-- ALTER TABLE meters DROP COLUMN IF EXISTS zone_id;
-- ALTER TABLE customers DROP COLUMN IF EXISTS zone_id;
-- DROP TABLE IF EXISTS zones;
-- ALTER TABLE customers RENAME COLUMN house_number TO customer_number;
-- ALTER TABLE customers RENAME COLUMN address_ref TO house_number;
