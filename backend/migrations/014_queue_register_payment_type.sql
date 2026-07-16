-- Extend odoo_sync_queue entity_type constraint for register-payment jobs.
ALTER TABLE odoo_sync_queue
  DROP CONSTRAINT odoo_sync_queue_entity_type_check,
  ADD CONSTRAINT odoo_sync_queue_entity_type_check
    CHECK (entity_type IN (
      'customer','product','invoice','payment','meter','reading','alarm',
      'reading-invoice','register-payment'
    ));
