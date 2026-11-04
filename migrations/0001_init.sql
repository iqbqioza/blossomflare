CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_allowlist (
  pubkey   TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_allowlist_added
  ON upload_allowlist (added_at DESC, pubkey DESC);

INSERT OR IGNORE INTO settings (key, value, updated_at)
VALUES ('upload_policy', 'allowlist', CAST(strftime('%s', 'now') AS INTEGER));

CREATE TABLE IF NOT EXISTS blobs (
  sha256   TEXT PRIMARY KEY,
  pubkey   TEXT NOT NULL,
  size     INTEGER NOT NULL,
  type     TEXT NOT NULL,
  filename TEXT,
  uploaded INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blobs_pubkey_uploaded
  ON blobs (pubkey, uploaded DESC, sha256 DESC);

CREATE INDEX IF NOT EXISTS idx_blobs_uploaded
  ON blobs (uploaded DESC, sha256 DESC);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  event_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_received
  ON reports (received_at DESC, id DESC);
