-- Migration 030: Production Performance Indexes
-- All CREATE INDEX use IF NOT EXISTS — safe to re-run.

-- ── meter_readings ────────────────────────────────────────────────────────────

-- Covering index for the most common query: readings for a meter in time order
-- plus the two telemetry values queried together most (consumption + flow).
CREATE INDEX IF NOT EXISTS idx_readings_meter_telemetry
  ON meter_readings (meter_id, timestamp DESC)
  INCLUDE (total_consumption, current_flow, battery_voltage, rssi);

-- Timestamp-only index to support "reporting today" count queries efficiently.
-- No NOW()-based predicate — PostgreSQL requires immutable functions in predicates.
CREATE INDEX IF NOT EXISTS idx_readings_timestamp
  ON meter_readings (timestamp DESC)
  INCLUDE (meter_id);

-- ── meters ────────────────────────────────────────────────────────────────────

-- Online/offline status sweep used by the ops dashboard and offline check cron
CREATE INDEX IF NOT EXISTS idx_meters_online_last_seen
  ON meters (is_online, last_seen DESC)
  WHERE status = 'active';

-- Valve status grouping used by ops dashboard
CREATE INDEX IF NOT EXISTS idx_meters_valve_status
  ON meters (valve_status)
  WHERE status = 'active' AND valve_status IS NOT NULL;

-- ── alarms ────────────────────────────────────────────────────────────────────

-- Active alarms dashboard card + alarm severity filter
CREATE INDEX IF NOT EXISTS idx_alarms_active_severity
  ON alarms (severity, triggered_at DESC)
  WHERE status = 'active';

-- ── leak_events ───────────────────────────────────────────────────────────────

-- Leaks opened today (ops dashboard card)
CREATE INDEX IF NOT EXISTS idx_leaks_today_active
  ON leak_events (detected_at DESC)
  WHERE status = 'active';

-- ── meter_consumption_daily ───────────────────────────────────────────────────

-- Cross-meter totals for water-produced / water-sold (ops dashboard NRW card)
CREATE INDEX IF NOT EXISTS idx_consumption_daily_date_total
  ON meter_consumption_daily (date DESC)
  INCLUDE (meter_id, consumption_m3);

-- ── downlink_commands ─────────────────────────────────────────────────────────

-- Pending/sent valve commands for timeout sweep and confirmation lookup
CREATE INDEX IF NOT EXISTS idx_downlink_pending
  ON downlink_commands (meter_id, created_at DESC)
  WHERE status IN ('pending', 'sent', 'queued');

-- ── invoice + payment ─────────────────────────────────────────────────────────

-- Outstanding balance query (unpaid invoices per customer)
CREATE INDEX IF NOT EXISTS idx_invoices_customer_status
  ON invoices (customer_id, status, due_date)
  WHERE status IN ('pending', 'overdue');
