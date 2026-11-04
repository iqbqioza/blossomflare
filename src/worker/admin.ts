import {
  AuthError,
  getAdminPubkey,
  getTagValues,
  parseNostrPubkey,
  verifyAdminRequest,
} from "./auth";
import {
  addUploader,
  consumeAuthEvent,
  getStats,
  getUploadPolicy,
  listBlobs,
  listReports,
  listUploaders,
  isUploaderCursor,
  parseLimit,
  removeUploader,
  setUploadPolicy,
} from "./db";
import { getMaxUploadBytes } from "./blobs";
import { toDescriptor } from "./blobs";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  readBodyWithLimit,
} from "./http";
import { isPubkey, isSha256 } from "./mime";
import {
  adminSessionCookie,
  clearAdminSessionCookie,
  createAdminSession,
  csrfMatches,
  deleteAdminSession,
  getAdminSession,
} from "./session";
import type { Env, UploadPolicy } from "./types";

const MAX_ADMIN_BODY_BYTES = 64 * 1024;

interface AdminAuth {
  csrfToken: string | null;
}

export async function handleAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const adminPubkey = getAdminPubkey(env);
  if (adminPubkey === null) {
    return errorResponse(503, "ADMIN_NPUB is not configured");
  }

  const body = await readBodyWithLimit(request, MAX_ADMIN_BODY_BYTES);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/admin/session") {
    return handleSession(request, env, adminPubkey, body);
  }

  const auth = await authenticateAdmin(request, env, adminPubkey, body);

  if (path === "/api/admin/settings") {
    if (request.method === "GET") {
      return jsonResponse({
        adminPubkey,
        uploadPolicy: await getUploadPolicy(env),
        maxUploadBytes: getMaxUploadBytes(env),
        ...(auth.csrfToken === null ? {} : { csrfToken: auth.csrfToken }),
      });
    }
    if (request.method === "PUT") {
      return updateSettings(env, body);
    }
    return methodNotAllowed("GET, PUT");
  }

  if (path === "/api/admin/uploaders") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !isUploaderCursor(cursor)) {
      return errorResponse(400, "invalid cursor");
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    return jsonResponse(await listUploaders(env, cursor, limit));
  }

  const uploaderMatch = /^\/api\/admin\/uploaders\/([^/]+)$/.exec(path);
  if (uploaderMatch) {
    let raw: string;
    try {
      raw = decodeURIComponent(uploaderMatch[1] ?? "");
    } catch {
      return errorResponse(400, "invalid npub");
    }
    const pubkey = parseNostrPubkey(raw);
    if (pubkey === null) {
      return errorResponse(400, "invalid npub");
    }

    if (request.method === "PUT") {
      const created = await addUploader(env, pubkey, adminPubkey);
      return jsonResponse({ pubkey, created }, created ? 201 : 200);
    }
    if (request.method === "DELETE") {
      await removeUploader(env, pubkey);
      return new Response(null, { status: 204 });
    }
    return methodNotAllowed("PUT, DELETE");
  }

  if (path === "/api/admin/blobs") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const pubkey = url.searchParams.get("pubkey");
    if (pubkey !== null && !isPubkey(pubkey)) {
      return errorResponse(400, "invalid pubkey");
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !isSha256(cursor)) {
      return errorResponse(400, "invalid cursor");
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await listBlobs(env, pubkey, cursor, limit);
    return jsonResponse({
      blobs: result.blobs.map((meta) => ({
        ...meta,
        url: toDescriptor(url.origin, meta).url,
      })),
      nextCursor: result.nextCursor,
    });
  }

  if (path === "/api/admin/stats") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return jsonResponse(await getStats(env));
  }

  if (path === "/api/admin/reports") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !isSha256(cursor)) {
      return errorResponse(400, "invalid cursor");
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await listReports(env, cursor, limit);
    return jsonResponse({
      reports: result.reports.map((report) => ({
        ...report,
        event: safeParseJson(report.eventJson),
      })),
      nextCursor: result.nextCursor,
    });
  }

  return errorResponse(404, "admin endpoint not found");
}

async function handleSession(
  request: Request,
  env: Env,
  adminPubkey: string,
  body: ArrayBuffer,
): Promise<Response> {
  if (request.method === "POST") {
    await consumeAdminToken(request, env, adminPubkey, body);
    const session = await createAdminSession(env, adminPubkey);
    return jsonResponse(
      {
        adminPubkey,
        uploadPolicy: await getUploadPolicy(env),
        maxUploadBytes: getMaxUploadBytes(env),
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      },
      201,
      { "Set-Cookie": adminSessionCookie(request, session) },
    );
  }

  if (request.method === "DELETE") {
    const session = await getAdminSession(env, request, adminPubkey);
    if (session !== null) {
      const csrfToken = request.headers.get("x-csrf-token");
      if (csrfToken === null || !csrfMatches(csrfToken, session.csrfToken)) {
        return errorResponse(403, "invalid CSRF token");
      }
      await deleteAdminSession(env, request);
    }

    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": clearAdminSessionCookie(request) },
    });
  }

  return methodNotAllowed("POST, DELETE");
}

async function authenticateAdmin(
  request: Request,
  env: Env,
  adminPubkey: string,
  body: ArrayBuffer,
): Promise<AdminAuth> {
  if (request.headers.get("authorization") !== null) {
    await consumeAdminToken(request, env, adminPubkey, body);
    return { csrfToken: null };
  }

  const session = await getAdminSession(env, request, adminPubkey);
  if (session === null) {
    throw new AuthError(401, "admin session required");
  }

  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "OPTIONS"
  ) {
    const csrfToken = request.headers.get("x-csrf-token");
    if (csrfToken === null || !csrfMatches(csrfToken, session.csrfToken)) {
      throw new AuthError(403, "invalid CSRF token");
    }
  }

  return { csrfToken: session.csrfToken };
}

async function consumeAdminToken(
  request: Request,
  env: Env,
  adminPubkey: string,
  body: ArrayBuffer,
): Promise<void> {
  const adminEvent = await verifyAdminRequest(
    request,
    adminPubkey,
    body.byteLength > 0 ? body : undefined,
  );

  const expirations = getTagValues(adminEvent, "expiration")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  const expires = expirations.length > 0
    ? Math.max(...expirations)
    : adminEvent.created_at + 60;
  if (!(await consumeAuthEvent(env, adminEvent.id, expires))) {
    throw new AuthError(401, "admin authorization token already used");
  }
}

async function updateSettings(
  env: Env,
  body: ArrayBuffer,
): Promise<Response> {
  if (body.byteLength === 0) {
    return errorResponse(400, "request body is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return errorResponse(400, "invalid JSON body");
  }

  if (parsed === null || typeof parsed !== "object") {
    return errorResponse(400, "invalid JSON body");
  }

  const policy = (parsed as { uploadPolicy?: unknown }).uploadPolicy;
  if (policy !== "open" && policy !== "allowlist") {
    return errorResponse(400, "uploadPolicy must be open or allowlist");
  }

  await setUploadPolicy(env, policy as UploadPolicy);
  return jsonResponse({ ok: true, uploadPolicy: policy });
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
