-- Migration 020: Add fields_changed column to odoo_sync_log
-- Required for phase-2 customer sync logging (tracks which fields changed per sync).
-- Additive only, idempotent, reversible.

-- UP
ALTER TABLE odoo_sync_log ADD COLUMN IF NOT EXISTS fields_changed JSONB;

-- VERIFY
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'odoo_sync_log' AND column_name = 'fields_changed'
  ) THEN
    RAISE EXCEPTION 'Migration 020 verify failed: fields_changed column not found on odoo_sync_log';
  END IF;
  RAISE NOTICE 'Migration 020 OK: fields_changed JSONB column added to odoo_sync_log.';
END $$;

-- DOWN (manual rollback)
-- ALTER TABLE odoo_sync_log DROP COLUMN IF EXISTS fields_changed;
