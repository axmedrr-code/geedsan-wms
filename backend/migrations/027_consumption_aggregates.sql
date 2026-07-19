-- Migration 027: Daily Consumption Aggregates Table
-- Pre-aggregated daily consumption per meter for fast analytics queries.

CREATE TABLE IF NOT EXISTS meter_consumption_daily (
  id                  BIGSERIAL     PRIMARY KEY,
  meter_id            UUID          NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  date                DATE          NOT NULL,
  consumption_m3      NUMERIC(12,3) NOT NULL DEFAULT 0,
  avg_flow_lpm        NUMERIC(8,3),
  peak_flow_lpm       NUMERIC(8,3),
  min_reading_m3      NUMERIC(12,3),
  max_reading_m3      NUMERIC(12,3),
  reading_count       INTEGER       NOT NULL DEFAULT 0,
  night_flow_avg_lpm  NUMERIC(8,3),
  night_flow_duration INTEGER,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (meter_id, date)
);

CREATE INDEX IF NOT EXISTS idx_consumption_daily_meter_date
  ON meter_consumption_daily (meter_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_consumption_daily_date
  ON meter_consumption_daily (date DESC);
