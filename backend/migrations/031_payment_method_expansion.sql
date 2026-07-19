-- 031_payment_method_expansion.sql
-- Expands the payment gateway enum to include POS/Card, Cheque, and Adjustment.
-- Adds payment_meta JSONB column for storing method-specific conditional fields.
-- Safe: DROP CONSTRAINT + ADD CONSTRAINT is instant on an unconstrained column.

-- 1. Expand gateway CHECK to include new manual payment methods
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_gateway_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_gateway_check
  CHECK (gateway IN ('sahal','evc','cash','bank','other','pos','cheque','adjustment'));

-- 2. Add structured metadata column for conditional payment fields (cashier, cheque no, terminal id, etc.)
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS payment_meta JSONB;
