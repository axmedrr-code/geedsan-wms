-- 032_payment_sessions.sql
-- Customer self-service online payment sessions table.
-- Also expands the payment_transactions gateway constraint to include
-- 'stripe' and 'paypal' for online payment flows.

-- Expand gateway enum to include online providers
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_gateway_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_gateway_check
  CHECK (gateway IN (
    'sahal','evc','cash','bank','other',
    'pos','cheque','adjustment',
    'stripe','paypal'
  ));

-- Online payment sessions (customer self-service checkout flows)
CREATE TABLE IF NOT EXISTS payment_sessions (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            UUID          NOT NULL REFERENCES customers(id),
  invoice_id             UUID          REFERENCES invoices(id),
  provider               VARCHAR(50)   NOT NULL
                           CHECK (provider IN ('stripe','paypal','bank_transfer','simulation')),
  status                 VARCHAR(50)   NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processing','completed','failed','expired','cancelled')),
  checkout_url           TEXT,
  return_url             TEXT,
  cancel_url             TEXT,
  provider_session_id    VARCHAR(500),
  payment_reference      VARCHAR(255),
  amount                 DECIMAL(10,2) NOT NULL,
  currency               VARCHAR(3)    NOT NULL DEFAULT 'USD',
  expires_at             TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  completed_at           TIMESTAMPTZ,
  payment_transaction_id UUID          REFERENCES payment_transactions(id),
  metadata               JSONB,
  ip_address             INET,
  user_agent             TEXT,
  created_at             TIMESTAMPTZ   DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_customer  ON payment_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_status    ON payment_sessions(status);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_expires   ON payment_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_provider  ON payment_sessions(provider);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_created   ON payment_sessions(created_at DESC);
