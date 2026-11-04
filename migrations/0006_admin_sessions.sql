CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash   TEXT PRIMARY KEY,
  admin_pubkey TEXT NOT NULL,
  csrf_token   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions (expires_at);
