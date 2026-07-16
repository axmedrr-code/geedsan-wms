-- Extend the odoo_sync_queue entity_type constraint to allow 'reading-invoice'
-- (invoice created directly from a meter reading's consumption + tariff).
ALTER TABLE odoo_sync_queue
  DROP CONSTRAINT odoo_sync_queue_entity_type_check,
  ADD CONSTRAINT odoo_sync_queue_entity_type_check
    CHECK (entity_type IN ('customer','product','invoice','payment','meter','reading','alarm','reading-invoice'));
