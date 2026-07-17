-- Migration 010: widen odoo_sync_queue.entity_id from UUID to TEXT
-- Reason: the sync queue must hold both UUID primary keys (customers, meters,
--         invoices, payments, alarms) and BIGSERIAL integer IDs (meter_readings).
--         The UUID type silently rejected integer IDs, causing the auto-enqueue
--         of readings to fail with "invalid input syntax for type uuid".
-- Safe:   USING entity_id::TEXT preserves every existing UUID value as-is.
--         The unique constraint is recreated with identical semantics.
-- Reversible DOWN:
--   ALTER TABLE odoo_sync_queue DROP CONSTRAINT odoo_sync_queue_entity_type_entity_id_key;
--   ALTER TABLE odoo_sync_queue ALTER COLUMN entity_id TYPE UUID USING entity_id::UUID;
--   ALTER TABLE odoo_sync_queue ADD CONSTRAINT odoo_sync_queue_entity_type_entity_id_key
--     UNIQUE (entity_type, entity_id);

BEGIN;

-- Step 1: drop the unique constraint that references entity_id (must be done before type change)
ALTER TABLE odoo_sync_queue
  DROP CONSTRAINT odoo_sync_queue_entity_type_entity_id_key;

-- Step 2: widen the column from UUID to TEXT (USING cast preserves all existing UUID values)
ALTER TABLE odoo_sync_queue
  ALTER COLUMN entity_id TYPE TEXT USING entity_id::TEXT;

-- Step 3: recreate the unique constraint with identical semantics
ALTER TABLE odoo_sync_queue
  ADD CONSTRAINT odoo_sync_queue_entity_type_entity_id_key
  UNIQUE (entity_type, entity_id);

COMMIT;
