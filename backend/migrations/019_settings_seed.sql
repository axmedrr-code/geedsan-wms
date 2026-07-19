-- Migration 019: Seed extended system_settings keys for full admin center
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING preserves existing values
-- DOWN: DELETE FROM system_settings WHERE key IN (...) — see list at bottom

-- ── General ────────────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('company_name',    'NUWACO',            'Company display name'),
  ('company_logo_url','',                  'URL to company logo image'),
  ('timezone',        'Africa/Mogadishu',  'System timezone'),
  ('currency',        'USD',               'Display currency code'),
  ('date_format',     'DD MMM YYYY',       'Date display format'),
  ('language',        'en',                'System UI language')
ON CONFLICT (key) DO NOTHING;

-- ── Notification channels ──────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('email_enabled',     'true',  'Enable email notification channel'),
  ('whatsapp_enabled',  'false', 'Enable WhatsApp notification channel'),
  ('telegram_enabled',  'false', 'Enable Telegram notification channel'),
  ('sms_enabled',       'false', 'Enable SMS notification channel'),
  ('push_enabled',      'false', 'Enable push notification channel')
ON CONFLICT (key) DO NOTHING;

-- ── Security ───────────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('session_timeout_minutes', '60',    'Session idle timeout in minutes (0=never)'),
  ('password_min_length',     '8',     'Minimum password character length'),
  ('two_factor_enabled',      'false', 'Require two-factor authentication for all users'),
  ('max_login_attempts',      '5',     'Maximum failed login attempts before lockout'),
  ('audit_logging_enabled',   'true',  'Record all user actions in audit log'),
  ('password_expiry_days',    '0',     'Force password change after N days (0=never)'),
  ('force_https',             'false', 'Reject all non-HTTPS requests')
ON CONFLICT (key) DO NOTHING;

-- ── Backup ─────────────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('backup_enabled',         'false',        'Enable automatic scheduled backups'),
  ('backup_schedule',        'daily',        'Backup frequency: daily or weekly'),
  ('backup_time',            '02:00',        'Backup start time (HH:MM local)'),
  ('backup_retention_days',  '30',           'Delete backups older than N days'),
  ('backup_location',        '/app/backups', 'Filesystem path for backup files')
ON CONFLICT (key) DO NOTHING;

-- ── AI Settings ────────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('ai_forecast_enabled',       'true',  'Enable AI consumption forecast feature'),
  ('forecast_horizon_days',     '30',    'Days ahead for forecast horizon'),
  ('ai_confidence_threshold',   '0.7',   'Minimum confidence score (0.0–1.0) to display forecast'),
  ('leak_sensitivity',          '0.5',   'Leak detection sensitivity (0.0=least, 1.0=most sensitive)'),
  ('leak_detection_enabled',    'true',  'Enable AI-powered leak detection'),
  ('abnormal_detection_enabled','true',  'Enable abnormal consumption alerts')
ON CONFLICT (key) DO NOTHING;

-- ── Water Utility Settings ─────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, description) VALUES
  ('default_meter_type',     'LoRaWAN',      'Default meter communication type'),
  ('pressure_threshold_bar', '4.0',          'Pressure alert threshold in bar'),
  ('reverse_flow_detection', 'true',         'Alert on detected reverse flow'),
  ('min_consumption_m3',     '0',            'Minimum expected daily consumption (m³)'),
  ('max_consumption_m3',     '100',          'Maximum expected daily consumption (m³)'),
  ('default_tariff_type',    'residential',  'Default tariff type for new customers')
ON CONFLICT (key) DO NOTHING;

-- VERIFY ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM system_settings
  WHERE key IN (
    'company_name','email_enabled','session_timeout_minutes',
    'backup_enabled','ai_forecast_enabled','default_meter_type'
  );
  IF v_count < 6 THEN
    RAISE EXCEPTION 'Migration 019 verification failed: expected 6+ seeded keys, got %', v_count;
  END IF;
END $$;

-- DOWN (for rollback only — removes keys added by this migration):
-- DELETE FROM system_settings WHERE key IN (
--   'company_name','company_logo_url','timezone','currency','date_format','language',
--   'email_enabled','whatsapp_enabled','telegram_enabled','sms_enabled','push_enabled',
--   'session_timeout_minutes','password_min_length','two_factor_enabled','max_login_attempts',
--   'audit_logging_enabled','password_expiry_days','force_https',
--   'backup_enabled','backup_schedule','backup_time','backup_retention_days','backup_location',
--   'ai_forecast_enabled','forecast_horizon_days','ai_confidence_threshold',
--   'leak_sensitivity','leak_detection_enabled','abnormal_detection_enabled',
--   'default_meter_type','pressure_threshold_bar','reverse_flow_detection',
--   'min_consumption_m3','max_consumption_m3','default_tariff_type'
-- );
