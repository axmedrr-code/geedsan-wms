-- Migration 009: Odoo sync linkage for meters, readings, and alarms.
-- Safe to re-run: all statements use IF NOT EXISTS / IF EXISTS.

-- Odoo linkage for meters → nuwaco.meter in Odoo
ALTER TABLE meters ADD COLUMN IF NOT EXISTS odoo_id VARCHAR(100);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS odoo_synced_at TIMESTAMPTZ;

-- Odoo linkage for meter_readings → nuwaco.reading in Odoo
-- High-volume table: only the most recent batch is synced; index on odoo_id
-- allows the sync service to skip already-pushed readings efficiently.
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS odoo_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_meter_readings_odoo_id ON meter_readings(odoo_id) WHERE odoo_id IS NOT NULL;

-- Odoo linkage for alarms → nuwaco.alarm in Odoo
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS odoo_id VARCHAR(100);
ALTER TABLE alarms ADD COLUMN IF NOT EXISTS odoo_synced_at TIMESTAMPTZ;

-- Extend entity_type CHECK constraint to include the three new types.
-- Drop current constraint first (Postgres does not support ALTER CONSTRAINT).
ALTER TABLE odoo_sync_queue
  DROP CONSTRAINT IF EXISTS odoo_sync_queue_entity_type_check;

ALTER TABLE odoo_sync_queue
  ALTER COLUMN entity_type TYPE VARCHAR(30);

ALTER TABLE odoo_sync_queue
  ADD CONSTRAINT odoo_sync_queue_entity_type_check
  CHECK (entity_type IN ('customer','product','invoice','payment','meter','reading','alarm'));

-- Lightweight append-only log for tracing every Odoo sync attempt.
CREATE TABLE IF NOT EXISTS odoo_sync_log (
  id          BIGSERIAL   PRIMARY KEY,
  entity_type VARCHAR(30),
  entity_id   TEXT,
  odoo_id     INTEGER,
  action      VARCHAR(30),
  status      VARCHAR(20),
  error       TEXT,
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_odoo_sync_log_entity  ON odoo_sync_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_odoo_sync_log_created ON odoo_sync_log(created_at DESC);
