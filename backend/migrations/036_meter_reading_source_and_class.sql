-- Migration 036: Meter classification (smart/manual), reading source, and
-- Adjustment Invoice support.
--
-- Real, pre-existing bug fixed here (not optional): meters.device_eui and
-- meter_readings.device_eui are both NOT NULL today. A manual/legacy meter
-- has no LoRaWAN radio and therefore no EUI — it would be rejected
-- outright by the current schema. Relaxed below, guarded by a CHECK so an
-- "automatic" meter still can't skip it.
--
-- Deliberately named `reading_mode` here, NOT `meter_type` — Odoo's
-- existing nuwaco_meter.meter_type field already means
-- residential/commercial/industrial/government (a customer-category
-- mirror); reusing that name for "smart vs manual" would collide with a
-- different, already-shipped concept.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout; existing rows need no
-- backfill UPDATE — every meter row that already exists was a LoRaWAN
-- device (device_eui was mandatory until this migration), so
-- DEFAULT 'automatic' is correct for all of them with no data changes.

-- ──────────────────────────────────────────────────────────────────────
-- 1. meters: water type + reading mode (smart/manual) classification
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE meters ADD COLUMN IF NOT EXISTS water_type_id UUID REFERENCES water_types(id);
-- Left NULL on existing rows deliberately ("uncategorized") rather than
-- guessing a default — see plan notes. Surfaced as a non-blocking
-- MISSING_WATER_TYPE warning in billingService.validateBillingPeriod
-- until an operator classifies each meter.

ALTER TABLE meters ADD COLUMN IF NOT EXISTS reading_mode VARCHAR(20) NOT NULL DEFAULT 'automatic'
  CHECK (reading_mode IN ('automatic','manual'));

ALTER TABLE meters ALTER COLUMN device_eui DROP NOT NULL;
ALTER TABLE meters DROP CONSTRAINT IF EXISTS meters_device_eui_required_if_automatic;
ALTER TABLE meters ADD CONSTRAINT meters_device_eui_required_if_automatic
  CHECK (reading_mode = 'manual' OR device_eui IS NOT NULL);
-- UNIQUE(device_eui) already tolerates multiple NULL values in Postgres,
-- so relaxing NOT NULL doesn't weaken uniqueness among real EUIs.

CREATE INDEX IF NOT EXISTS idx_meters_water_type    ON meters(water_type_id);
CREATE INDEX IF NOT EXISTS idx_meters_reading_mode  ON meters(reading_mode);

-- ──────────────────────────────────────────────────────────────────────
-- 2. meter_readings: where did this reading come from, and who entered it
--    if manual
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE meter_readings ALTER COLUMN device_eui DROP NOT NULL;

ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'lorawan'
  CHECK (source IN ('lorawan','manual'));
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS entered_by UUID REFERENCES users(id);
-- entered_by stays NULL for lorawan rows; set to the operator's user id
-- for manual rows — audit/dispute trail for who typed in a reading.

CREATE INDEX IF NOT EXISTS idx_meter_readings_source ON meter_readings(source);

-- ──────────────────────────────────────────────────────────────────────
-- 3. invoices: Adjustment Invoice support
--
-- The free-form manual-amount invoice path (backend/src/routes/billing.js
-- POST /) is reserved for exceptional, non-consumption charges — never
-- for normal monthly water billing, which must always go through the
-- meter-reading-driven path. adjustment_reason marks exactly which kind
-- of exception this is, for audit/reporting; NULL on every normal,
-- reading-driven invoice.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS adjustment_reason VARCHAR(40);
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_adjustment_reason_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_adjustment_reason_check
  CHECK (adjustment_reason IS NULL OR adjustment_reason IN (
    'meter_correction', 'billing_adjustment', 'penalty', 'credit_note',
    'misc_service_charge', 'new_connection_fee', 'reconnection_fee',
    'meter_replacement_fee', 'administrative_charge'
  ));

CREATE INDEX IF NOT EXISTS idx_invoices_adjustment_reason ON invoices(adjustment_reason)
  WHERE adjustment_reason IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- VERIFY
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meters' AND column_name = 'reading_mode'
  ) THEN
    RAISE EXCEPTION 'Migration 036 FAILED: meters.reading_mode not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meters' AND column_name = 'device_eui' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Migration 036 FAILED: meters.device_eui is still NOT NULL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'meter_readings' AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION 'Migration 036 FAILED: meter_readings.source not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'adjustment_reason'
  ) THEN
    RAISE EXCEPTION 'Migration 036 FAILED: invoices.adjustment_reason not found';
  END IF;
  RAISE NOTICE 'Migration 036 OK: meter classification, reading source, and Adjustment Invoice support in place.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- DOWN (manual rollback — not auto-executed)
-- ──────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_invoices_adjustment_reason;
-- ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_adjustment_reason_check;
-- ALTER TABLE invoices DROP COLUMN IF EXISTS adjustment_reason;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS entered_by;
-- ALTER TABLE meter_readings DROP COLUMN IF EXISTS source;
-- ALTER TABLE meter_readings ALTER COLUMN device_eui SET NOT NULL;  -- only safe if no NULLs exist
-- ALTER TABLE meters DROP CONSTRAINT IF EXISTS meters_device_eui_required_if_automatic;
-- ALTER TABLE meters ALTER COLUMN device_eui SET NOT NULL;          -- only safe if no NULLs exist
-- ALTER TABLE meters DROP COLUMN IF EXISTS reading_mode;
-- ALTER TABLE meters DROP COLUMN IF EXISTS water_type_id;
