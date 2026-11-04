export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(reason);
    this.name = "HttpError";
  }
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "X-Reason, X-Next-Cursor, X-SHA-256, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length, Range, If-Range",
      "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  reason: string,
  headers: Record<string, string> = {},
  head = false,
): Response {
  const safeReason = reason.replace(/[\r\n]+/g, " ").slice(0, 200);
  const responseHeaders = {
    "X-Reason": safeReason,
    ...headers,
  };

  if (head) {
    return new Response(null, { status, headers: responseHeaders });
  }

  return jsonResponse({ error: safeReason }, status, responseHeaders);
}

export function methodNotAllowed(allowed: string): Response {
  return errorResponse(405, "method not allowed", { Allow: allowed });
}

export function addAdminHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = request.headers.get("content-length");
  let expectedLength: number | undefined;

  if (contentLength !== null) {
    expectedLength = Number(contentLength);
    if (!Number.isInteger(expectedLength) || expectedLength < 0) {
      throw new HttpError(400, "invalid content-length");
    }
    if (expectedLength > maxBytes) {
      throw new HttpError(413, "request body is too large");
    }
  }

  return readStreamWithLimit(request.body, maxBytes, expectedLength);
}

export async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  expectedLength?: number,
): Promise<ArrayBuffer> {
  const reader = stream?.getReader();
  if (!reader) {
    return new ArrayBuffer(0);
  }

  const preallocated = expectedLength !== undefined &&
      Number.isSafeInteger(expectedLength) &&
      expectedLength >= 0 &&
      expectedLength <= maxBytes &&
      expectedLength <= 1024 * 1024
    ? new Uint8Array(expectedLength)
    : null;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (
        total + value.byteLength > maxBytes ||
        (preallocated !== null && total + value.byteLength > preallocated.length)
      ) {
        try {
          await reader.cancel();
        } catch {
          // The limit error below is the meaningful failure.
        }
        throw new HttpError(413, "request body is too large");
      }

      if (preallocated !== null) {
        preallocated.set(value, total);
      } else {
        chunks.push(value);
      }
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (preallocated !== null) {
    return total === preallocated.length
      ? preallocated.buffer
      : preallocated.buffer.slice(0, total);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}
