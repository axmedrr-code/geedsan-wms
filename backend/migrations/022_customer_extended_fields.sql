-- 022_customer_extended_fields.sql
-- Extended customer registration fields + zone auto-numbering sequence

ALTER TABLE customers ADD COLUMN IF NOT EXISTS mobile_money_number   VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS owner_name            VARCHAR(200);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_payment_method VARCHAR(50) DEFAULT 'cash';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS priority              VARCHAR(20) NOT NULL DEFAULT 'normal';

-- Priority check constraint (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_priority_check'
      AND conrelid = 'customers'::regclass
  ) THEN
    ALTER TABLE customers ADD CONSTRAINT customers_priority_check
      CHECK (priority IN ('normal', 'high', 'vip'));
  END IF;
END $$;

-- Zone customer_seq for Mode B auto house-number generation (e.g. ZB-000001)
ALTER TABLE zones ADD COLUMN IF NOT EXISTS customer_seq INT NOT NULL DEFAULT 0;

-- House number mode system setting
INSERT INTO system_settings (key, value, description)
  VALUES (
    'house_number_mode',
    'manual',
    'House number generation: ''manual'' = user enters (e.g. 2526) | ''auto'' = zone-prefixed sequence (e.g. ZB-000001)'
  )
ON CONFLICT (key) DO NOTHING;
