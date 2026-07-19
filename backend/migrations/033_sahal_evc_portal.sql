-- 033_sahal_evc_portal.sql
-- Extend payment_sessions to include sahal and evc as online payment providers.

-- Expand the provider CHECK to allow Sahal and EVC push-payment sessions
ALTER TABLE payment_sessions DROP CONSTRAINT IF EXISTS payment_sessions_provider_check;
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_provider_check
  CHECK (provider IN ('stripe','paypal','bank_transfer','simulation','sahal','evc'));

-- Store the customer phone number used for USSD payments
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);

-- Timestamp when USSD initiation was sent (for expiry/retry tracking)
ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMPTZ;
