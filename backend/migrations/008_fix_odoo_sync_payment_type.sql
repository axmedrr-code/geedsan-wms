-- Add 'payment' to the odoo_sync_queue entity_type CHECK constraint.
-- The billing service calls enqueueOdooSync('payment', paymentId) but the
-- original constraint only listed ('customer','product','invoice'), causing
-- a constraint-violation crash on every payment recorded after the Odoo
-- payment-sync feature was wired in.
--
-- PostgreSQL does not support ALTER TABLE ... ALTER CONSTRAINT, so the
-- standard approach is: drop the old constraint, add the new one.

ALTER TABLE odoo_sync_queue
  DROP CONSTRAINT IF EXISTS odoo_sync_queue_entity_type_check;

ALTER TABLE odoo_sync_queue
  ADD CONSTRAINT odoo_sync_queue_entity_type_check
  CHECK (entity_type IN ('customer', 'product', 'invoice', 'payment'));
