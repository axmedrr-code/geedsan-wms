-- Migration 017: Fine-grained RBAC roles
-- Extends users.role from 3 values to 9 and adds supporting columns + a
-- reference table for per-module permissions.

-- Drop the old 3-value constraint and replace it with the full set.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'admin',            -- full system access
    'operator',         -- existing operator level (field operations)
    'viewer',           -- read-only across all modules
    'manager',          -- admin minus system settings
    'finance',          -- billing + payments + reports
    'billing_officer',  -- billing creation and management only
    'customer_service', -- customers + meter reads + billing reads
    'meter_technician', -- meters + readings + alarms write
    'delivery_officer'  -- tanker deliveries only
  ));

-- Additional user profile columns (idempotent via IF NOT EXISTS)
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name        VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip             INET;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until        TIMESTAMPTZ;

-- Role-permission reference table (informational — permissions are enforced in
-- the Express middleware, not in the DB, so this table is for audit/UI display
-- and documentation purposes).
CREATE TABLE IF NOT EXISTS role_permissions (
  id          SERIAL PRIMARY KEY,
  role        VARCHAR(30) NOT NULL,
  module      VARCHAR(50) NOT NULL,   -- 'billing', 'meters', 'customers', etc.
  can_read    BOOLEAN NOT NULL DEFAULT false,
  can_write   BOOLEAN NOT NULL DEFAULT false,
  can_delete  BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (role, module)
);

-- Seed the reference table (ON CONFLICT DO NOTHING makes re-running safe)
INSERT INTO role_permissions (role, module, can_read, can_write, can_delete) VALUES
  ('admin',            'all',           true,  true,  true),
  ('manager',          'customers',     true,  true,  false),
  ('manager',          'meters',        true,  true,  false),
  ('manager',          'billing',       true,  true,  false),
  ('manager',          'reports',       true,  true,  false),
  ('manager',          'users',         true,  false, false),
  ('finance',          'billing',       true,  true,  false),
  ('finance',          'reports',       true,  true,  false),
  ('finance',          'customers',     true,  false, false),
  ('billing_officer',  'billing',       true,  true,  false),
  ('billing_officer',  'customers',     true,  false, false),
  ('customer_service', 'customers',     true,  true,  false),
  ('customer_service', 'billing',       true,  false, false),
  ('customer_service', 'meters',        true,  false, false),
  ('meter_technician', 'meters',        true,  true,  false),
  ('meter_technician', 'alarms',        true,  true,  false),
  ('meter_technician', 'readings',      true,  false, false),
  ('delivery_officer', 'deliveries',    true,  true,  false),
  ('viewer',           'customers',     true,  false, false),
  ('viewer',           'meters',        true,  false, false),
  ('viewer',           'billing',       true,  false, false),
  ('viewer',           'reports',       true,  false, false)
ON CONFLICT (role, module) DO NOTHING;
