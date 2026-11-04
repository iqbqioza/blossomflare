CREATE TABLE IF NOT EXISTS report_rate_limits (
  pubkey       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (pubkey, window_start)
);

CREATE INDEX IF NOT EXISTS idx_report_rate_limits_window
  ON report_rate_limits (window_start);
