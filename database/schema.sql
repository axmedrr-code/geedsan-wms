-- GEEDSAN Water Meter Management System
-- Database Schema v1.0

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CUSTOMERS
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_number VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(100),
  phone VARCHAR(30),
  address TEXT,
  city VARCHAR(100),
  district VARCHAR(100),
  tariff_type VARCHAR(30) DEFAULT 'residential' CHECK (tariff_type IN ('residential','commercial','industrial','government')),
  account_status VARCHAR(20) DEFAULT 'active' CHECK (account_status IN ('active','suspended','terminated')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- METERS
-- ============================================================
CREATE TABLE IF NOT EXISTS meters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_eui VARCHAR(16) UNIQUE NOT NULL,
  meter_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  application_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','faulty','removed')),
  is_online BOOLEAN DEFAULT false,
  valve_status VARCHAR(20) DEFAULT 'unknown' CHECK (valve_status IN ('open','closed','unknown','fault')),
  total_consumption NUMERIC(12,3) DEFAULT 0,
  current_flow NUMERIC(8,3) DEFAULT 0,
  battery_voltage NUMERIC(4,2),
  rssi INTEGER,
  snr NUMERIC(6,2),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  installation_address TEXT,
  firmware_version VARCHAR(20),
  installed_at TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meters_device_eui ON meters(device_eui);
CREATE INDEX IF NOT EXISTS idx_meters_status ON meters(status);
CREATE INDEX IF NOT EXISTS idx_meters_customer ON meters(customer_id);
CREATE INDEX IF NOT EXISTS idx_meters_online ON meters(is_online);

-- ============================================================
-- METER READINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS meter_readings (
  id BIGSERIAL PRIMARY KEY,
  meter_id UUID NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  device_eui VARCHAR(16) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_consumption NUMERIC(12,3),
  current_flow NUMERIC(8,3),
  battery_voltage NUMERIC(4,2),
  rssi INTEGER,
  snr NUMERIC(6,2),
  f_port INTEGER,
  f_cnt INTEGER,
  raw_payload TEXT,
  alarm_flags JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_readings_meter_time ON meter_readings(meter_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON meter_readings(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_readings_eui ON meter_readings(device_eui);

-- ============================================================
-- ALARMS
-- ============================================================
CREATE TABLE IF NOT EXISTS alarms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meter_id UUID REFERENCES meters(id) ON DELETE CASCADE,
  device_eui VARCHAR(16) NOT NULL,
  alarm_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','resolved')),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution_notes TEXT,
  ai_analysis TEXT,
  ai_recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alarms_meter ON alarms(meter_id);
CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms(status);
CREATE INDEX IF NOT EXISTS idx_alarms_severity ON alarms(severity);
CREATE INDEX IF NOT EXISTS idx_alarms_triggered ON alarms(triggered_at DESC);

-- ============================================================
-- DOWNLINK COMMANDS
-- ============================================================
CREATE TABLE IF NOT EXISTS downlink_commands (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meter_id UUID REFERENCES meters(id) ON DELETE SET NULL,
  device_eui VARCHAR(16) NOT NULL,
  command_type VARCHAR(50) NOT NULL,
  command_hex VARCHAR(20),
  command_base64 TEXT,
  f_port INTEGER DEFAULT 5,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','sent','confirmed','failed')),
  chirpstack_id VARCHAR(100),
  error_message TEXT,
  sent_by UUID REFERENCES users(id),
  sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commands_meter ON downlink_commands(meter_id);
CREATE INDEX IF NOT EXISTS idx_commands_sent ON downlink_commands(sent_at DESC);

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  period_start DATE,
  period_end DATE,
  parameters JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  file_path VARCHAR(255),
  file_type VARCHAR(10),
  file_size BIGINT,
  generated_by UUID REFERENCES users(id),
  generated_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email','telegram','whatsapp')),
  recipient VARCHAR(200),
  enabled_alarms JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, channel)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alarm_id UUID REFERENCES alarms(id) ON DELETE SET NULL,
  channel VARCHAR(20) NOT NULL,
  recipient VARCHAR(200) NOT NULL,
  subject VARCHAR(255),
  message TEXT,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BILLING / INVOICES
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_number VARCHAR(80) UNIQUE NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  tariff_type VARCHAR(30) DEFAULT 'residential' CHECK (tariff_type IN ('residential','commercial','industrial','government')),
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','overdue','cancelled')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  line_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);

-- ============================================================
-- TANKER DELIVERY MANAGEMENT
-- ============================================================
CREATE TABLE IF NOT EXISTS tanker_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_number VARCHAR(50) NOT NULL,
  driver_name VARCHAR(100) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  delivery_volume NUMERIC(12,3) NOT NULL,
  delivery_address TEXT,
  status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tanker_customer ON tanker_deliveries(customer_id);
CREATE INDEX IF NOT EXISTS idx_tanker_status ON tanker_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_tanker_scheduled ON tanker_deliveries(scheduled_at DESC);

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW meter_summary AS
SELECT
  m.*,
  c.full_name AS customer_name,
  c.customer_number,
  c.phone AS customer_phone,
  c.tariff_type,
  (SELECT COUNT(*) FROM alarms a WHERE a.meter_id = m.id AND a.status = 'active') AS active_alarms,
  (SELECT COUNT(*) FROM alarms a WHERE a.meter_id = m.id AND a.severity = 'critical' AND a.status = 'active') AS critical_alarms,
  (SELECT timestamp FROM meter_readings mr WHERE mr.meter_id = m.id ORDER BY timestamp DESC LIMIT 1) AS last_reading_time
FROM meters m
LEFT JOIN customers c ON m.customer_id = c.id;

CREATE OR REPLACE VIEW dashboard_stats AS
SELECT
  (SELECT COUNT(*) FROM meters WHERE status = 'active') AS total_meters,
  (SELECT COUNT(*) FROM meters WHERE is_online = true AND status = 'active') AS online_meters,
  (SELECT COUNT(*) FROM meters WHERE is_online = false AND status = 'active') AS offline_meters,
  (SELECT COALESCE(SUM(total_consumption), 0) FROM meters WHERE status = 'active') AS total_consumption,
  (SELECT COUNT(*) FROM alarms WHERE status = 'active') AS active_alarms,
  (SELECT COUNT(*) FROM alarms WHERE status = 'active' AND severity = 'critical') AS critical_alarms,
  (SELECT COUNT(*) FROM customers WHERE account_status = 'active') AS total_customers;

-- ============================================================
-- SEED: DEFAULT USERS
-- ============================================================
INSERT INTO users (username, email, password_hash, full_name, role) VALUES
  ('admin',     'admin@geedsan.com',     '$2b$12$GeedsanHash1AdminPas0uRKW0U3RLG1234567890abcdefghij', 'System Administrator', 'admin'),
  ('operator1', 'operator@geedsan.com',  '$2b$12$GeedsanHash2OperPas0uRKW0U3RLG1234567890abcdefghij', 'Field Operator',       'operator'),
  ('viewer1',   'viewer@geedsan.com',    '$2b$12$GeedsanHash3ViewPas0uRKW0U3RLG1234567890abcdefghij', 'Report Viewer',        'viewer')
ON CONFLICT (username) DO NOTHING;

-- NOTE: Passwords above are placeholders. Run this SQL to set correct hashed passwords:
-- UPDATE users SET password_hash = '$2b$12$...' WHERE username = 'admin';
-- Or run: node scripts/seed.js

-- ============================================================
-- SEED: DEFAULT SYSTEM SETTINGS
-- ============================================================
INSERT INTO system_settings (key, description) VALUES
  ('chirpstack_url', 'ChirpStack server URL'),
  ('chirpstack_api_key', 'ChirpStack API key'),
  ('chirpstack_tenant_id', 'ChirpStack tenant ID'),
  ('email_smtp_host', 'SMTP server hostname'),
  ('email_smtp_port', 'SMTP server port'),
  ('email_username', 'SMTP auth username'),
  ('email_password', 'SMTP auth password'),
  ('telegram_bot_token', 'Telegram bot token'),
  ('whatsapp_api_url', 'WhatsApp API endpoint'),
  ('whatsapp_api_key', 'WhatsApp API key'),
  ('anthropic_api_key', 'Anthropic Claude API key'),
  ('low_battery_threshold', 'Low battery voltage threshold (V)'),
  ('leak_detection_threshold', 'Leak detection flow threshold (L/h)'),
  ('consumption_alert_multiplier', 'High consumption alert multiplier')
ON CONFLICT (key) DO NOTHING;

UPDATE system_settings SET value = '3.2' WHERE key = 'low_battery_threshold';
UPDATE system_settings SET value = '5'   WHERE key = 'leak_detection_threshold';
UPDATE system_settings SET value = '3'   WHERE key = 'consumption_alert_multiplier';
