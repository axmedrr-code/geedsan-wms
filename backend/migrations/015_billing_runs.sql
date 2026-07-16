-- Tracks each scheduled or manual monthly billing run and its per-customer results.
CREATE TABLE IF NOT EXISTS billing_runs (
  id                BIGSERIAL   PRIMARY KEY,
  period_start      DATE        NOT NULL,
  period_end        DATE        NOT NULL,
  triggered_by      VARCHAR(30) NOT NULL DEFAULT 'scheduler',
  status            VARCHAR(20) NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','partial','failed')),
  customers_total   INTEGER     NOT NULL DEFAULT 0,
  customers_ok      INTEGER     NOT NULL DEFAULT 0,
  customers_skipped INTEGER     NOT NULL DEFAULT 0,
  customers_failed  INTEGER     NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- Per-customer result rows for each billing run.
-- billing_period_start/end + invoice_reference + billing_status satisfy the
-- storage requirements from the billing-engine spec.
CREATE TABLE IF NOT EXISTS billing_run_items (
  id                   BIGSERIAL    PRIMARY KEY,
  run_id               BIGINT       NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  customer_id          UUID         NOT NULL,
  customer_number      VARCHAR(50),
  billing_period_start DATE         NOT NULL,
  billing_period_end   DATE         NOT NULL,
  invoice_reference    VARCHAR(100),
  billing_status       VARCHAR(20)  NOT NULL DEFAULT 'pending'
                       CHECK (billing_status IN ('success','skipped','failed')),
  amount               NUMERIC(14,2),
  error_message        TEXT,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_run_items_run_id   ON billing_run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_billing_run_items_customer ON billing_run_items(customer_id);
