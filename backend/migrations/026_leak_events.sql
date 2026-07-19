-- Migration 026: Leak Events Table
-- Stores server-detected leak events with severity scoring and evidence.

CREATE TABLE IF NOT EXISTS leak_events (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  meter_id        UUID          NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  detection_type  VARCHAR(30)   NOT NULL,
  severity        VARCHAR(10)   NOT NULL DEFAULT 'medium',
  ai_score        NUMERIC(4,3)  NOT NULL DEFAULT 0,
  ai_analysis     TEXT,
  evidence        JSONB         NOT NULL DEFAULT '{}',
  detected_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID          REFERENCES users(id) ON DELETE SET NULL,
  status          VARCHAR(20)   NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT leak_events_detection_type_check
    CHECK (detection_type IN ('continuous_flow','night_flow','abnormal_consumption','reverse_flow','burst_pipe','pressure_drop')),
  CONSTRAINT leak_events_severity_check
    CHECK (severity IN ('low','medium','high','critical')),
  CONSTRAINT leak_events_status_check
    CHECK (status IN ('active','resolved','false_positive'))
);

CREATE INDEX IF NOT EXISTS idx_leak_events_meter      ON leak_events (meter_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_leak_events_status     ON leak_events (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_leak_events_type       ON leak_events (detection_type);
CREATE INDEX IF NOT EXISTS idx_leak_events_severity   ON leak_events (severity);
CREATE INDEX IF NOT EXISTS idx_leak_events_detected   ON leak_events (detected_at DESC);
