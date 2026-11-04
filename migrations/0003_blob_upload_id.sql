ALTER TABLE blobs ADD COLUMN upload_id TEXT;

UPDATE blobs
SET upload_id = lower(hex(randomblob(16)))
WHERE upload_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blobs_upload_id
  ON blobs (upload_id);
