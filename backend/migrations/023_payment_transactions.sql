-- 023_payment_transactions.sql
-- Payment gateway integration: transaction log, receipt sequence, gateway settings

CREATE TABLE IF NOT EXISTS payment_transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_ref  VARCHAR(100) UNIQUE NOT NULL,
  gateway          VARCHAR(20) NOT NULL,
  house_number     VARCHAR(50) NOT NULL,
  customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
  invoice_id       UUID REFERENCES invoices(id)  ON DELETE SET NULL,
  amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  currency         VARCHAR(3)  NOT NULL DEFAULT 'USD',
  status           VARCHAR(20) NOT NULL DEFAULT 'pending',
  gateway_status   VARCHAR(100),
  gateway_response JSONB,
  phone_number     VARCHAR(50),
  receipt_number   VARCHAR(50) UNIQUE,
  applied_invoices JSONB,
  remaining_credit NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  processed_at     TIMESTAMPTZ,
  ip_address       INET,
  user_agent       TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_transactions_status_check
    CHECK (status IN ('pending','processing','completed','failed','no_invoice','refunded')),
  CONSTRAINT payment_transactions_gateway_check
    CHECK (gateway IN ('sahal','evc','cash','bank','other'))
);

CREATE INDEX IF NOT EXISTS idx_ptx_house_number  ON payment_transactions(house_number);
CREATE INDEX IF NOT EXISTS idx_ptx_customer_id   ON payment_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_ptx_status        ON payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_ptx_gateway       ON payment_transactions(gateway);
CREATE INDEX IF NOT EXISTS idx_ptx_created_at    ON payment_transactions(created_at DESC);

-- Settings for payment gateways and receipts
INSERT INTO system_settings (key, value, description) VALUES
  ('sahal_callback_secret',  '', 'Sahal HMAC-SHA256 shared secret for callback verification (empty = skip verification)'),
  ('evc_callback_secret',    '', 'EVC Plus HMAC-SHA256 shared secret for callback verification (empty = skip verification)'),
  ('payment_auto_odoo_sync', 'true', 'Auto-queue successful payments to Odoo sync'),
  ('receipt_company_name',   'NUWACO Water Services', 'Company name printed on receipts'),
  ('receipt_company_address','Garowe, Puntland, Somalia', 'Company address printed on receipts'),
  ('receipt_footer',         'Thank you for your payment. Save this receipt for your records.', 'Receipt footer message'),
  ('receipt_sequence',       '0', 'Auto-incrementing receipt number sequence')
ON CONFLICT (key) DO NOTHING;
