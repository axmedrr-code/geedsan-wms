ALTER TABLE meters ADD COLUMN IF NOT EXISTS pulse_count BIGINT;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS pulse_constant_liters NUMERIC(8,2) DEFAULT 100;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS meter_serial VARCHAR(20);
ALTER TABLE meters ADD COLUMN IF NOT EXISTS status_word_1 INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS status_word_2 INTEGER;
ALTER TABLE meters ADD COLUMN IF NOT EXISTS trigger_source INTEGER;

ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS pulse_count BIGINT;
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS status_word_1 INTEGER;
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS status_word_2 INTEGER;
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS trigger_source INTEGER;

CREATE TABLE IF NOT EXISTS meter_flow_history (
  id BIGSERIAL PRIMARY KEY,
  meter_id UUID NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  device_eui VARCHAR(16) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  interval_minutes INTEGER NOT NULL,
  consumption_pulses BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_history_meter_time ON meter_flow_history(meter_id, recorded_at DESC);
