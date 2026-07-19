-- Migration 025: Enhanced Meter Telemetry Fields
-- Adds temperature, valve_status snapshot, and decoded_payload to meter_readings.
-- All ADD COLUMN uses IF NOT EXISTS — safe to run twice.

ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS temperature     NUMERIC(5,2);
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS valve_status    VARCHAR(10);
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS decoded_payload JSONB;

-- Composite index for consumption calculation queries (MAX-MIN over a window)
CREATE INDEX IF NOT EXISTS idx_meter_readings_consumption
  ON meter_readings (meter_id, timestamp DESC, total_consumption)
  WHERE total_consumption IS NOT NULL;

-- Index to speed up duplicate packet detection (same meter + fCnt)
CREATE INDEX IF NOT EXISTS idx_meter_readings_fcnt
  ON meter_readings (meter_id, f_cnt)
  WHERE f_cnt IS NOT NULL;
