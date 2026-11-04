CREATE TABLE IF NOT EXISTS blob_tombstones (
  sha256     TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  uploaded   INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blob_tombstones_pubkey_uploaded
  ON blob_tombstones (pubkey, uploaded DESC, sha256 DESC);

CREATE INDEX IF NOT EXISTS idx_blob_tombstones_uploaded
  ON blob_tombstones (uploaded DESC, sha256 DESC);

CREATE INDEX IF NOT EXISTS idx_blob_tombstones_deleted
  ON blob_tombstones (deleted_at);

CREATE INDEX IF NOT EXISTS idx_reports_pubkey_received
  ON reports (pubkey, received_at DESC);
