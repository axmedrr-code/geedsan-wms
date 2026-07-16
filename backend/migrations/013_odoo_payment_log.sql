-- Tracks Odoo payments registered via registerPaymentOnOdooMove.
-- Separate from invoice_payments (WMS billing) — covers invoices created from
-- readings (odoo_invoice_id) that have no corresponding WMS invoices row.
CREATE TABLE IF NOT EXISTS odoo_payment_log (
  id              BIGSERIAL PRIMARY KEY,
  odoo_move_id    INTEGER       NOT NULL,
  odoo_payment_id INTEGER,
  amount          NUMERIC(14,2) NOT NULL,
  payment_date    DATE          NOT NULL,
  payment_status  VARCHAR(30),
  journal_name    VARCHAR(100),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_odoo_payment_log_move_id ON odoo_payment_log(odoo_move_id);
