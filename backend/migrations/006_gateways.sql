CREATE TABLE IF NOT EXISTS gateways (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gateway_eui VARCHAR(16) UNIQUE NOT NULL,
  name VARCHAR(100),
  description TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  is_online BOOLEAN DEFAULT false,
  last_seen TIMESTAMPTZ,
  last_rssi INTEGER,
  last_snr NUMERIC(6,2),
  uplink_count BIGINT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateways_eui ON gateways(gateway_eui);
CREATE INDEX IF NOT EXISTS idx_gateways_online ON gateways(is_online);

ALTER TABLE meter_readings ADD COLUMN IF NOT EXISTS gateway_eui VARCHAR(16);
CREATE INDEX IF NOT EXISTS idx_readings_gateway ON meter_readings(gateway_eui);
