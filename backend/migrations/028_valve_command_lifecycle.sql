-- Migration 028: Extended Valve Command Lifecycle
-- Adds status tracking columns to downlink_commands for the full
-- pending → sent → delivered → acknowledged → executed → timeout chain.

ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMPTZ;
ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS acknowledged_at   TIMESTAMPTZ;
ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS executed_at       TIMESTAMPTZ;
ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS timeout_at        TIMESTAMPTZ;
ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS response_payload  TEXT;
ALTER TABLE downlink_commands ADD COLUMN IF NOT EXISTS lifecycle_log     JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_downlink_commands_meter_status
  ON downlink_commands (meter_id, status, created_at DESC)
  WHERE status NOT IN ('executed','timeout','failed');
