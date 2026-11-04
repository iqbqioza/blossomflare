import { isEventShape } from "./auth";
import { verifyEvent } from "nostr-tools/pure";
import { insertReport } from "./db";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  methodNotAllowed,
  readBodyWithLimit,
} from "./http";
import { isSha256 } from "./mime";
import type { Env } from "./types";

const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORT_HASHES = 20;
const MAX_REPORTS_PER_HOUR = 20;

export async function handleReport(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "PUT") {
    return methodNotAllowed("PUT, OPTIONS");
  }

  let event: unknown;
  try {
    const body = await readBodyWithLimit(request, MAX_REPORT_BYTES);
    event = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return errorResponse(400, "invalid report body");
  }

  if (!isEventShape(event)) {
    return errorResponse(400, "invalid report event");
  }

  let valid = false;
  try {
    valid = verifyEvent(event);
  } catch {
    valid = false;
  }
  if (!valid) {
    return errorResponse(400, "invalid report signature");
  }

  if (event.kind !== 1984) {
    return errorResponse(400, "report event must be kind 1984");
  }

  const hashes = event.tags
    .filter((tag) => tag[0] === "x" && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
  if (hashes.length === 0 || hashes.length > MAX_REPORT_HASHES) {
    return errorResponse(400, "report must reference 1-20 blob hashes");
  }
  if (!hashes.every(isSha256)) {
    return errorResponse(400, "report must reference valid blob hashes");
  }

  const uniqueHashes = [...new Set(hashes)];
  const placeholders = uniqueHashes.map(() => "?").join(", ");
  const existing = await env.DB.prepare(
    `SELECT COUNT(DISTINCT sha256) AS count FROM blobs
     WHERE sha256 IN (${placeholders})`,
  )
    .bind(...uniqueHashes)
    .first<{ count: number }>();
  if ((existing?.count ?? 0) !== uniqueHashes.length) {
    return errorResponse(400, "report must reference existing blobs");
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM reports
     WHERE pubkey = ? AND received_at > ?`,
  )
    .bind(event.pubkey, Math.floor(Date.now() / 1000) - 60 * 60)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= MAX_REPORTS_PER_HOUR) {
    return errorResponse(429, "too many reports from this pubkey");
  }

  await insertReport(
    env,
    event.id,
    event.pubkey,
    event.created_at,
    JSON.stringify(event),
  );

  return jsonResponse({ ok: true });
}
