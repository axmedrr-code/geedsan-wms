-- Migration 018: Customer profile extensions
-- Additive only. All new columns nullable. Fully idempotent. Reversible (see DOWN section below).
-- Extends: customers table + new customer_notes table
-- Safe to re-run: all statements use IF NOT EXISTS / DO $$ blocks.

-- ─────────────────────────────────────────
-- UP
-- ─────────────────────────────────────────

-- 1. New profile columns on customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS national_id      VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS house_number     VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gps_lat          NUMERIC(10,7);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gps_lng          NUMERIC(10,7);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS connection_date  DATE;

-- 2. Audit columns: who created / last updated the record
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by  UUID;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_by  UUID;

-- 3. FK: created_by → users.id  (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'customers_created_by_fkey'
      AND table_name = 'customers'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4. FK: updated_by → users.id  (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'customers_updated_by_fkey'
      AND table_name = 'customers'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 5. Indexes for frequent query patterns
CREATE INDEX IF NOT EXISTS idx_customers_national_id     ON customers(national_id)    WHERE national_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_account_status  ON customers(account_status);
CREATE INDEX IF NOT EXISTS idx_customers_tariff_type     ON customers(tariff_type);
CREATE INDEX IF NOT EXISTS idx_customers_city            ON customers(city)           WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_created_by      ON customers(created_by)     WHERE created_by IS NOT NULL;

-- 6. customer_notes table
CREATE TABLE IF NOT EXISTS customer_notes (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Indexes on customer_notes
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer_id ON customer_notes(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_notes_user_id     ON customer_notes(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_notes_created_at  ON customer_notes(created_at DESC);

-- ─────────────────────────────────────────
-- VERIFY (non-destructive sanity check)
-- ─────────────────────────────────────────
DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name = 'customers'
    AND column_name IN ('national_id','house_number','gps_lat','gps_lng','connection_date','created_by','updated_by');

  IF col_count <> 7 THEN
    RAISE EXCEPTION 'Migration 018 verify failed: expected 7 new columns on customers, found %', col_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_notes') THEN
    RAISE EXCEPTION 'Migration 018 verify failed: customer_notes table not found';
  END IF;

  RAISE NOTICE 'Migration 018 OK: 7 new columns, customer_notes table, all indexes created.';
END $$;

-- ─────────────────────────────────────────
-- DOWN (run manually to reverse; not auto-executed)
-- ─────────────────────────────────────────
-- DROP TABLE IF EXISTS customer_notes;
-- ALTER TABLE customers DROP COLUMN IF EXISTS updated_by;
-- ALTER TABLE customers DROP COLUMN IF EXISTS created_by;
-- ALTER TABLE customers DROP COLUMN IF EXISTS connection_date;
-- ALTER TABLE customers DROP COLUMN IF EXISTS gps_lng;
-- ALTER TABLE customers DROP COLUMN IF EXISTS gps_lat;
-- ALTER TABLE customers DROP COLUMN IF EXISTS house_number;
-- ALTER TABLE customers DROP COLUMN IF EXISTS national_id;
