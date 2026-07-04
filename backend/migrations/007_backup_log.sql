CREATE TABLE IF NOT EXISTS backup_log (
  id BIGSERIAL PRIMARY KEY,
  database_name VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed')),
  file_path TEXT,
  file_size_bytes BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_log_db_time ON backup_log(database_name, created_at DESC);
