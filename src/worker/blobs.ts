import {
  getAdminPubkey,
  getTagValues,
  verifyBlossomAuth,
} from "./auth";
import {
  canUpload,
  consumeAuthEvent,
  getBlobMeta,
  listBlobs,
} from "./db";
import { getBlobCoordinator } from "./coordinator-client";
import { sha256Hex } from "./crypto";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  readBodyWithLimit,
} from "./http";
import {
  extensionFor,
  isInlineSafe,
  isPubkey,
  isSha256,
  sanitizeContentType,
} from "./mime";
import type { BlobDescriptor, BlobMeta, Env } from "./types";

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function getMaxUploadBytes(env: Env): number {
  const parsed = Number(env.MAX_UPLOAD_BYTES);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_UPLOAD_BYTES;
  }
  return Math.min(parsed, ABSOLUTE_MAX_UPLOAD_BYTES);
}

export function toDescriptor(origin: string, meta: BlobMeta): BlobDescriptor {
  return {
    url: `${origin}/${meta.sha256}${extensionFor(meta.type)}`,
    sha256: meta.sha256,
    size: meta.size,
    type: meta.type,
    uploaded: meta.uploaded,
  };
}

export async function handleGetBlob(
  request: Request,
  env: Env,
  sha256: string,
): Promise<Response> {
  const meta = await getBlobMeta(env, sha256);
  if (!meta) {
    return errorResponse(404, "blob not found");
  }

  const head = await env.BLOBS.head(sha256);
  if (!head) {
    return errorResponse(404, "blob not found");
  }

  const type = sanitizeContentType(meta.type);
  const etag = head.httpEtag || `"${sha256}"`;
  const lastModified = head.uploaded.toUTCString();
  const headers = blobHeaders(sha256, type, head.size, etag);
  headers.set("Last-Modified", lastModified);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const ifRangeMatches = ifRange === null ||
    ifRange === etag ||
    ifRange === lastModified;

  if (rangeHeader !== null && ifRangeMatches) {
    const range = parseRange(rangeHeader, head.size);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${head.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    if (range !== null) {
      const object = await env.BLOBS.get(sha256, {
        range: { offset: range.start, length: range.length },
      });
      if (!object) {
        return errorResponse(404, "blob not found");
      }
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${head.size}`,
      );
      headers.set("Content-Length", String(range.length));
      return new Response(object.body, { status: 206, headers });
    }
  }

  const object = await env.BLOBS.get(sha256);
  if (!object) {
    return errorResponse(404, "blob not found");
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

interface ByteRange {
  start: number;
  end: number;
  length: number;
}

function parseRange(value: string, size: number): ByteRange | "invalid" | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("bytes=") || trimmed.includes(",")) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") {
    return "invalid";
  }
  if (size === 0) {
    return "invalid";
  }

  let start: number;
  let end: number;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= size ||
      start > end
    ) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }

  return { start, end, length: end - start + 1 };
}

function blobHeaders(
  sha256: string,
  type: string,
  size: number,
  etag: string,
): Headers {
  const headers = new Headers({
    "Content-Type": type,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    ETag: etag || `"${sha256}"`,
    "Content-Disposition": `${isInlineSafe(type) ? "inline" : "attachment"}; filename="${sha256}${extensionFor(type)}"`,
  });
  return headers;
}

export async function handleUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "PUT") {
    return methodNotAllowed("PUT, OPTIONS");
  }

  const url = new URL(request.url);
  const headerHash = request.headers.get("x-sha-256");
  if (headerHash !== null && !isSha256(headerHash.toLowerCase())) {
    return errorResponse(400, "invalid X-SHA-256 header");
  }

  const token = await verifyBlossomAuth(request, {
    action: "upload",
    hostname: url.hostname,
    ...(headerHash !== null ? { sha256: headerHash.toLowerCase() } : {}),
  });

  if (!(await canUpload(env, token.pubkey))) {
    return errorResponse(403, "uploader not allowed");
  }

  const maxBytes = getMaxUploadBytes(env);
  const body = await readBodyWithLimit(request, maxBytes);
  const actualHash = await sha256Hex(body);

  if (headerHash !== null && headerHash.toLowerCase() !== actualHash) {
    return errorResponse(409, "X-SHA-256 does not match request body");
  }

  const xTags = token.tags
    .filter((tag) => tag[0] === "x" && typeof tag[1] === "string")
    .map((tag) => (tag[1] as string).toLowerCase());
  if (!xTags.includes(actualHash)) {
    return errorResponse(401, "authorization blob hash does not match");
  }

  const type = sanitizeContentType(request.headers.get("content-type"));
  const stored = await getBlobCoordinator(env, actualHash).store(
    body,
    actualHash,
    type,
    token.pubkey,
  );
  const descriptor = toDescriptor(url.origin, stored.meta);

  return jsonResponse(descriptor, stored.created ? 201 : 200);
}

export async function handleHeadUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "HEAD") {
    return methodNotAllowed("HEAD, OPTIONS");
  }

  const url = new URL(request.url);
  const sha256 = request.headers.get("x-sha-256")?.toLowerCase() ?? null;
  if (sha256 === null || !isSha256(sha256)) {
    return errorResponse(400, "invalid or missing X-SHA-256 header", {}, true);
  }

  const token = await verifyBlossomAuth(request, {
    action: "upload",
    hostname: url.hostname,
    sha256,
  });
  if (!(await canUpload(env, token.pubkey))) {
    return errorResponse(403, "uploader not allowed", {}, true);
  }

  const rawLength = request.headers.get("x-content-length");
  if (rawLength === null) {
    return errorResponse(411, "X-Content-Length header is required", {}, true);
  }
  const length = Number(rawLength);
  if (!Number.isInteger(length) || length < 0) {
    return errorResponse(400, "invalid X-Content-Length header", {}, true);
  }
  if (length > getMaxUploadBytes(env)) {
    return errorResponse(413, "blob is too large", {}, true);
  }

  return new Response(null, { status: 200 });
}

export async function handleDelete(
  request: Request,
  env: Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "DELETE") {
    return methodNotAllowed("DELETE, OPTIONS");
  }

  const url = new URL(request.url);
  const token = await verifyBlossomAuth(request, {
    action: "delete",
    hostname: url.hostname,
    sha256,
  });

  const meta = await getBlobMeta(env, sha256);
  if (!meta) {
    return errorResponse(404, "blob not found");
  }

  const adminPubkey = getAdminPubkey(env);
  if (token.pubkey !== meta.pubkey && token.pubkey !== adminPubkey) {
    return errorResponse(403, "not allowed to delete this blob");
  }

  const expirations = getTagValues(token, "expiration")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  const expires = expirations.length > 0
    ? Math.max(...expirations)
    : Math.floor(Date.now() / 1000) + 60;
  if (!(await consumeAuthEvent(env, token.id, expires))) {
    return errorResponse(401, "authorization token already used");
  }

  if (meta.uploadId === undefined) {
    return errorResponse(409, "blob changed during deletion");
  }

  const result = await getBlobCoordinator(env, sha256).remove(
    sha256,
    meta.uploadId,
  );
  if (result.conflict) {
    return errorResponse(409, "blob changed during deletion");
  }
  return new Response(null, { status: 204 });
}

export async function handleList(
  request: Request,
  env: Env,
  pubkey: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed("GET, OPTIONS");
  }
  if (!isPubkey(pubkey)) {
    return errorResponse(400, "invalid pubkey");
  }

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !isSha256(cursor)) {
    return errorResponse(400, "invalid cursor");
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  const { blobs, nextCursor } = await listBlobs(env, pubkey, cursor, limit);

  return jsonResponse(
    blobs.map((meta) => toDescriptor(url.origin, meta)),
    200,
    nextCursor === null ? {} : { "X-Next-Cursor": nextCursor },
  );
}

export function handleMedia(request: Request): Response {
  if (request.method !== "HEAD" && request.method !== "PUT") {
    return methodNotAllowed("HEAD, PUT, OPTIONS");
  }
  return errorResponse(
    501,
    "media optimization is not supported",
    {},
    request.method === "HEAD",
  );
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 100);
}
