import { verifyBlossomAuth } from "./auth";
import { toDescriptor, getMaxUploadBytes } from "./blobs";
import { getBlobCoordinator } from "./coordinator-client";
import { canUpload } from "./db";
import { sha256Hex } from "./crypto";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  methodNotAllowed,
  readBodyWithLimit,
  readStreamWithLimit,
} from "./http";
import { isSha256, sanitizeContentType } from "./mime";
import type { Env } from "./types";

const MAX_MIRROR_BODY_BYTES = 8 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

interface MirrorRequest {
  url?: unknown;
}

export async function handleMirror(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "PUT") {
    return methodNotAllowed("PUT, OPTIONS");
  }
  if ((env.ENABLE_MIRROR ?? "true").toLowerCase() === "false") {
    return errorResponse(403, "mirror is disabled");
  }

  const requestUrl = new URL(request.url);
  const token = await verifyBlossomAuth(request, {
    action: "upload",
    hostname: requestUrl.hostname,
  });

  if (!(await canUpload(env, token.pubkey))) {
    return errorResponse(403, "uploader not allowed");
  }

  const expectedHashes = token.tags
    .filter((tag) => tag[0] === "x" && typeof tag[1] === "string")
    .map((tag) => (tag[1] as string).toLowerCase())
    .filter(isSha256);
  if (expectedHashes.length === 0) {
    return errorResponse(401, "authorization is missing a blob hash");
  }

  let payload: unknown;
  try {
    const body = await readBodyWithLimit(request, MAX_MIRROR_BODY_BYTES);
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return errorResponse(400, "invalid mirror request body");
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof (payload as MirrorRequest).url !== "string"
  ) {
    return errorResponse(400, "mirror url is required");
  }

  const sourceUrl = validateMirrorUrl(
    (payload as MirrorRequest).url as string,
    requestUrl.hostname,
  );
  const maxBytes = getMaxUploadBytes(env);

  const fetched = await fetchWithRedirects(
    sourceUrl,
    requestUrl.hostname,
    maxBytes,
  );
  const actualHash = await sha256Hex(fetched.body);

  if (!expectedHashes.includes(actualHash)) {
    return errorResponse(
      409,
      "mirrored blob hash does not match authorization",
    );
  }

  const stored = await getBlobCoordinator(env, actualHash).store(
    fetched.body,
    actualHash,
    fetched.type,
    token.pubkey,
  );
  return jsonResponse(
    toDescriptor(requestUrl.origin, stored.meta),
    stored.created ? 201 : 200,
  );
}

function validateMirrorUrl(input: string, ownHostname: string): URL {
  if (input.length > 2048) {
    throw new HttpError(400, "mirror url is too long");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(400, "invalid mirror url");
  }

  if (url.protocol !== "https:") {
    throw new HttpError(400, "mirror url must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpError(400, "mirror url must not contain credentials");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const own = ownHostname.toLowerCase().replace(/\.+$/, "");
  if (hostname === own) {
    throw new HttpError(400, "cannot mirror from this server");
  }
  if (isBlockedHostname(hostname)) {
    throw new HttpError(400, "mirror host is not allowed");
  }

  return url;
}

function isBlockedHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal"
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    const [a = 0, b = 0] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    return (
      // Includes ::, ::1, IPv4-mapped, and IPv4-compatible addresses.
      ipv6.startsWith("::") ||
      ipv6.startsWith("fc") ||
      ipv6.startsWith("fd") ||
      ipv6.startsWith("fe8") ||
      ipv6.startsWith("fe9") ||
      ipv6.startsWith("fea") ||
      ipv6.startsWith("feb") ||
      // NAT64 and 6to4 can embed private IPv4 addresses.
      ipv6.startsWith("64:ff9b:") ||
      ipv6.startsWith("2002:") ||
      ipv6.startsWith("2001:0:")
    );
  }

  return false;
}

interface FetchedBlob {
  body: ArrayBuffer;
  type: string;
}

async function fetchWithRedirects(
  initial: URL,
  ownHostname: string,
  maxBytes: number,
): Promise<FetchedBlob> {
  let current = initial;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "*/*", "User-Agent": "Blossomflare/0.1" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, "could not fetch mirror url");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(502, "mirror redirect is missing location");
      }
      let next: URL;
      try {
        next = validateMirrorUrl(
          new URL(location, current).toString(),
          ownHostname,
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, "invalid mirror redirect");
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      throw new HttpError(502, `mirror origin returned ${response.status}`);
    }

    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength === null ? undefined : Number(rawLength);
    if (
      contentLength !== undefined &&
      Number.isSafeInteger(contentLength) &&
      contentLength >= 0 &&
      contentLength > maxBytes
    ) {
      throw new HttpError(413, "mirrored blob is too large");
    }

    let body: ArrayBuffer;
    try {
      body = await readStreamWithLimit(
        response.body,
        maxBytes,
        contentLength !== undefined && Number.isSafeInteger(contentLength) &&
          contentLength >= 0
          ? contentLength
          : undefined,
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "could not read mirror response");
    }

    return {
      body,
      type: sanitizeContentType(response.headers.get("content-type")),
    };
  }

  throw new HttpError(502, "too many mirror redirects");
}
