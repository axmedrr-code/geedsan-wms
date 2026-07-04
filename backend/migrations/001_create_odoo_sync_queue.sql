CREATE TABLE IF NOT EXISTS odoo_sync_queue (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('customer','product','invoice')),
  entity_id UUID NOT NULL,
  payload JSONB,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','retry','failed','completed')),
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_odoo_sync_status ON odoo_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_odoo_sync_next_attempt ON odoo_sync_queue(next_attempt_at);
