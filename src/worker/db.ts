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

export async function listUploaders(
  env: Env,
  cursor: string | null,
  limit: number,
): Promise<{ uploaders: UploaderEntry[]; nextCursor: string | null }> {
  let rows: UploaderEntry[];

  if (cursor !== null) {
    const cursorRow = await env.DB.prepare(
      "SELECT added_at FROM upload_allowlist WHERE pubkey = ?",
    )
      .bind(cursor)
      .first<{ added_at: number }>();

    if (!cursorRow) {
      return { uploaders: [], nextCursor: null };
    }

    const result = await env.DB.prepare(
      `SELECT pubkey, added_at, added_by
       FROM upload_allowlist
       WHERE added_at < ? OR (added_at = ? AND pubkey < ?)
       ORDER BY added_at DESC, pubkey DESC
       LIMIT ?`,
    )
      .bind(cursorRow.added_at, cursorRow.added_at, cursor, limit + 1)
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
  return {
    uploaders: page,
    nextCursor: hasMore ? page[page.length - 1]?.pubkey ?? null : null,
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

export async function getBlobMeta(
  env: Env,
  sha256: string,
): Promise<BlobMeta | null> {
  return env.DB.prepare(
    `SELECT sha256, pubkey, size, type, filename, uploaded
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
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO blobs
       (sha256, pubkey, size, type, filename, uploaded)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      meta.sha256,
      meta.pubkey,
      meta.size,
      meta.type,
      meta.filename,
      meta.uploaded,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteBlobMeta(
  env: Env,
  sha256: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM blobs WHERE sha256 = ?")
    .bind(sha256)
    .run();
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
    const cursorMeta = await getBlobMeta(env, cursor);
    if (!cursorMeta) {
      return { blobs: [], nextCursor: null };
    }
    filters.push("(uploaded < ? OR (uploaded = ? AND sha256 < ?))");
    params.push(cursorMeta.uploaded, cursorMeta.uploaded, cursor);
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
