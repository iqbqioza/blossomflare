CREATE TABLE IF NOT EXISTS used_auth_events (
  id      TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_auth_events_expires
  ON used_auth_events (expires);
