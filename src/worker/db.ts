import { getAdminPubkey } from "./auth";
import type {
  BlobMeta,
  Env,
  ReportEntry,
  Stats,
  UploaderEntry,
  UploadPolicy,
} from "./types";

const DEFAULT_UPLOAD_POLICY: UploadPolicy = "allowlist";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function parseLimit(value: string | null, fallback = 50): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 100);
}

export async function getUploadPolicy(env: Env): Promise<UploadPolicy> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'upload_policy'",
  ).first<{ value: string }>();
  return row?.value === "open" ? "open" : DEFAULT_UPLOAD_POLICY;
}

export async function setUploadPolicy(
  env: Env,
  policy: UploadPolicy,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('upload_policy', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(policy, nowSeconds())
    .run();
}

export async function canUpload(env: Env, pubkey: string): Promise<boolean> {
  if (pubkey === getAdminPubkey(env)) {
    return true;
  }

  const policy = await getUploadPolicy(env);
  if (policy === "open") {
    return true;
  }

  const row = await env.DB.prepare(
    "SELECT 1 AS allowed FROM upload_allowlist WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ allowed: number }>();

  return row !== null;
}

const UPLOADER_CURSOR_PATTERN = /^(\d+):([0-9a-f]{64})$/;

export function isUploaderCursor(value: string): boolean {
  const match = UPLOADER_CURSOR_PATTERN.exec(value);
  if (!match) return false;
  const addedAt = Number(match[1]);
  return Number.isSafeInteger(addedAt) && addedAt >= 0;
}

export async function listUploaders(
  env: Env,
  cursor: string | null,
  limit: number,
): Promise<{ uploaders: UploaderEntry[]; nextCursor: string | null }> {
  let rows: UploaderEntry[];

  if (cursor !== null) {
    const match = UPLOADER_CURSOR_PATTERN.exec(cursor);
    if (!match) {
      return { uploaders: [], nextCursor: null };
    }

    const addedAt = Number(match[1]);
    const pubkey = match[2] as string;
    if (!Number.isSafeInteger(addedAt) || addedAt < 0) {
      return { uploaders: [], nextCursor: null };
    }
    const result = await env.DB.prepare(
      `SELECT pubkey, added_at, added_by
       FROM upload_allowlist
       WHERE added_at < ? OR (added_at = ? AND pubkey < ?)
       ORDER BY added_at DESC, pubkey DESC
       LIMIT ?`,
    )
      .bind(addedAt, addedAt, pubkey, limit + 1)
      .all<{ pubkey: string; added_at: number; added_by: string }>();
    rows = result.results.map(mapUploader);
  } else {
    const result = await env.DB.prepare(
      `SELECT pubkey, added_at, added_by
       FROM upload_allowlist
       ORDER BY added_at DESC, pubkey DESC
       LIMIT ?`,
    )
      .bind(limit + 1)
      .all<{ pubkey: string; added_at: number; added_by: string }>();
    rows = result.results.map(mapUploader);
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    uploaders: page,
    nextCursor: hasMore && last ? `${last.addedAt}:${last.pubkey}` : null,
  };
}

function mapUploader(row: {
  pubkey: string;
  added_at: number;
  added_by: string;
}): UploaderEntry {
  return {
    pubkey: row.pubkey,
    addedAt: row.added_at,
    addedBy: row.added_by,
  };
}

export async function addUploader(
  env: Env,
  pubkey: string,
  adminPubkey: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO upload_allowlist (pubkey, added_at, added_by)
     VALUES (?, ?, ?)`,
  )
    .bind(pubkey, nowSeconds(), adminPubkey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function removeUploader(
  env: Env,
  pubkey: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM upload_allowlist WHERE pubkey = ?",
  )
    .bind(pubkey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function consumeAuthEvent(
  env: Env,
  eventId: string,
  expires: number,
): Promise<boolean> {
  const now = nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO used_auth_events (id, expires) VALUES (?, ?)",
    ).bind(eventId, expires),
    env.DB.prepare("DELETE FROM used_auth_events WHERE expires < ?").bind(now),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

export async function getBlobMeta(
  env: Env,
  sha256: string,
): Promise<BlobMeta | null> {
  return env.DB.prepare(
    `SELECT upload_id AS uploadId, sha256, pubkey, size, type, filename, uploaded
     FROM blobs
     WHERE sha256 = ?`,
  )
    .bind(sha256)
    .first<BlobMeta>();
}

export async function insertBlob(
  env: Env,
  meta: BlobMeta,
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO blobs
         (sha256, pubkey, size, type, filename, uploaded, upload_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      meta.sha256,
      meta.pubkey,
      meta.size,
      meta.type,
      meta.filename,
      meta.uploaded,
      meta.uploadId ?? crypto.randomUUID(),
    ),
    env.DB.prepare("DELETE FROM blob_tombstones WHERE sha256 = ?").bind(
      meta.sha256,
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

interface BlobBoundary {
  uploaded: number;
  pubkey: string;
}

export async function getBlobBoundary(
  env: Env,
  sha256: string,
): Promise<BlobBoundary | null> {
  const meta = await getBlobMeta(env, sha256);
  if (meta) {
    return { uploaded: meta.uploaded, pubkey: meta.pubkey };
  }

  return env.DB.prepare(
    "SELECT uploaded, pubkey FROM blob_tombstones WHERE sha256 = ?",
  )
    .bind(sha256)
    .first<BlobBoundary>();
}

const TOMBSTONE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function tombstoneBlob(
  env: Env,
  meta: BlobMeta,
): Promise<boolean> {
  if (meta.uploadId === undefined) {
    return false;
  }

  const deletedAt = nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO blob_tombstones
         (sha256, pubkey, uploaded, deleted_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM blobs WHERE upload_id = ? AND sha256 = ?
       )`,
    ).bind(
      meta.sha256,
      meta.pubkey,
      meta.uploaded,
      deletedAt,
      meta.uploadId,
      meta.sha256,
    ),
    env.DB.prepare(
      "DELETE FROM blobs WHERE upload_id = ? AND sha256 = ?",
    ).bind(meta.uploadId, meta.sha256),
    env.DB.prepare("DELETE FROM blob_tombstones WHERE deleted_at < ?").bind(
      deletedAt - TOMBSTONE_RETENTION_SECONDS,
    ),
  ]);

  return (results[1]?.meta.changes ?? 0) > 0;
}

export async function listBlobs(
  env: Env,
  pubkey: string | null,
  cursor: string | null,
  limit: number,
): Promise<{ blobs: BlobMeta[]; nextCursor: string | null }> {
  const filters: string[] = [];
  const params: unknown[] = [];

  if (pubkey !== null) {
    filters.push("pubkey = ?");
    params.push(pubkey);
  }

  if (cursor !== null) {
    const boundary = await getBlobBoundary(env, cursor);
    if (!boundary || (pubkey !== null && boundary.pubkey !== pubkey)) {
      return { blobs: [], nextCursor: null };
    }
    filters.push("(uploaded < ? OR (uploaded = ? AND sha256 < ?))");
    params.push(boundary.uploaded, boundary.uploaded, cursor);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await env.DB.prepare(
    `SELECT sha256, pubkey, size, type, filename, uploaded
     FROM blobs
     ${where}
     ORDER BY uploaded DESC, sha256 DESC
     LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<BlobMeta>();

  const rows = result.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    blobs: page,
    nextCursor: hasMore ? page[page.length - 1]?.sha256 ?? null : null,
  };
}

export async function getStats(env: Env): Promise<Stats> {
  const [blobs, reports, uploaders] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM blobs",
    ).first<{ count: number; bytes: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM reports").first<{
      count: number;
    }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM upload_allowlist").first<{
      count: number;
    }>(),
  ]);

  return {
    blobCount: blobs?.count ?? 0,
    totalBytes: blobs?.bytes ?? 0,
    reportCount: reports?.count ?? 0,
    uploaderCount: uploaders?.count ?? 0,
  };
}

export async function consumeReportQuota(
  env: Env,
  pubkey: string,
  maxPerHour: number,
): Promise<boolean> {
  const windowStart = Math.floor(nowSeconds() / 3600);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO report_rate_limits (pubkey, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(pubkey, window_start) DO UPDATE SET count = count + 1`,
    ).bind(pubkey, windowStart),
    env.DB.prepare(
      `SELECT count FROM report_rate_limits
       WHERE pubkey = ? AND window_start = ?`,
    ).bind(pubkey, windowStart),
    env.DB.prepare(
      "DELETE FROM report_rate_limits WHERE window_start < ?",
    ).bind(windowStart - 24),
  ]);
  const row = results[1]?.results[0] as { count?: number } | undefined;
  return (row?.count ?? maxPerHour + 1) <= maxPerHour;
}

export async function insertReport(
  env: Env,
  eventId: string,
  pubkey: string,
  createdAt: number,
  eventJson: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports
       (id, pubkey, created_at, received_at, event_json)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(eventId, pubkey, createdAt, nowSeconds(), eventJson)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listReports(
  env: Env,
  cursor: string | null,
  limit: number,
): Promise<{ reports: ReportEntry[]; nextCursor: string | null }> {
  let rows: ReportEntry[];

  if (cursor !== null) {
    const cursorRow = await env.DB.prepare(
      "SELECT received_at FROM reports WHERE id = ?",
    )
      .bind(cursor)
      .first<{ received_at: number }>();

    if (!cursorRow) {
      return { reports: [], nextCursor: null };
    }

    const result = await env.DB.prepare(
      `SELECT id, pubkey, created_at, received_at, event_json
       FROM reports
       WHERE received_at < ? OR (received_at = ? AND id < ?)
       ORDER BY received_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(cursorRow.received_at, cursorRow.received_at, cursor, limit + 1)
      .all<{
        id: string;
        pubkey: string;
        created_at: number;
        received_at: number;
        event_json: string;
      }>();
    rows = result.results.map(mapReport);
  } else {
    const result = await env.DB.prepare(
      `SELECT id, pubkey, created_at, received_at, event_json
       FROM reports
       ORDER BY received_at DESC, id DESC
       LIMIT ?`,
    )
      .bind(limit + 1)
      .all<{
        id: string;
        pubkey: string;
        created_at: number;
        received_at: number;
        event_json: string;
      }>();
    rows = result.results.map(mapReport);
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    reports: page,
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

function mapReport(row: {
  id: string;
  pubkey: string;
  created_at: number;
  received_at: number;
  event_json: string;
}): ReportEntry {
  return {
    id: row.id,
    pubkey: row.pubkey,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    eventJson: row.event_json,
  };
}
