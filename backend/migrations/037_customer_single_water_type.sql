-- Migration 037: enforce "a customer has exactly one water type"
--
-- Business rule (confirmed, not a redesign of the billing engine): a
-- customer may have several meters, but every meter belonging to that
-- customer must share the same water type. customers.water_type_id is the
-- authoritative value; a DB trigger on meters is the single enforcement
-- point so the rule holds regardless of which code path writes to meters
-- (API, admin tooling, a future migration) — not just an application-level
-- check that a forgotten code path could bypass.
--
-- Deliberately NOT touched: calculateInvoiceBreakdown's per-meter grouping
-- in billingService.js. That logic already handles N groups generically;
-- under this rule every customer's meters share one water_type_id, so it
-- simply always produces exactly one group in practice. No redesign
-- needed there.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS water_type_id UUID REFERENCES water_types(id);
CREATE INDEX IF NOT EXISTS idx_customers_water_type ON customers(water_type_id);

-- Backfill from existing data: if a customer already has any meter with a
-- water_type_id set, adopt the earliest such meter's value as the
-- customer's water type. In practice this is a no-op today — water_type_id
-- was only added to meters in migration 036 and nothing has set it yet on
-- any real deployment — but it's written to behave correctly if it isn't.
UPDATE customers c
SET water_type_id = sub.water_type_id
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, water_type_id
  FROM meters
  WHERE customer_id IS NOT NULL AND water_type_id IS NOT NULL
  ORDER BY customer_id, created_at ASC
) sub
WHERE c.id = sub.customer_id AND c.water_type_id IS NULL;

-- Enforcement: before a meter's water_type_id or customer_id changes,
-- either adopt it as the customer's first water type (if the customer
-- doesn't have one yet) or reject the write if it conflicts with the
-- customer's already-established water type.
CREATE OR REPLACE FUNCTION enforce_customer_single_water_type() RETURNS TRIGGER AS $$
DECLARE
  existing_water_type UUID;
  existing_code TEXT;
  rejected_code TEXT;
BEGIN
  IF NEW.water_type_id IS NULL OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT water_type_id INTO existing_water_type FROM customers WHERE id = NEW.customer_id;

  IF existing_water_type IS NULL THEN
    UPDATE customers SET water_type_id = NEW.water_type_id, updated_at = NOW() WHERE id = NEW.customer_id;
  ELSIF existing_water_type <> NEW.water_type_id THEN
    SELECT code INTO existing_code FROM water_types WHERE id = existing_water_type;
    SELECT code INTO rejected_code FROM water_types WHERE id = NEW.water_type_id;
    RAISE EXCEPTION 'This customer is already classified as water type "%" — a customer may only have one water type (rejected: "%")',
      COALESCE(existing_code, existing_water_type::TEXT), COALESCE(rejected_code, NEW.water_type_id::TEXT)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_customer_single_water_type ON meters;
CREATE TRIGGER trg_enforce_customer_single_water_type
  BEFORE INSERT OR UPDATE OF water_type_id, customer_id ON meters
  FOR EACH ROW EXECUTE FUNCTION enforce_customer_single_water_type();

-- ──────────────────────────────────────────────────────────────────────
-- VERIFY
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'water_type_id'
  ) THEN
    RAISE EXCEPTION 'Migration 037 FAILED: customers.water_type_id not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_customer_single_water_type'
  ) THEN
    RAISE EXCEPTION 'Migration 037 FAILED: trg_enforce_customer_single_water_type not found';
  END IF;
  RAISE NOTICE 'Migration 037 OK: customers.water_type_id in place, single-water-type-per-customer enforced by trigger.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback — not auto-executed)
-- ──────────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS trg_enforce_customer_single_water_type ON meters;
-- DROP FUNCTION IF EXISTS enforce_customer_single_water_type();
-- ALTER TABLE customers DROP COLUMN IF EXISTS water_type_id;
