-- Additive: track which Odoo account.move was created for a meter reading
-- Used by syncInvoiceFromReadingToOdoo for idempotency (fast-path skip on re-run).
ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS odoo_invoice_id VARCHAR(100);
