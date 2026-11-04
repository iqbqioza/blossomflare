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
    "X-Reason, X-Next-Cursor, X-SHA-256, Content-Length, Content-Range, Accept-Ranges",
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
        "Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length, Range",
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
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isInteger(length) || length < 0) {
      throw new HttpError(400, "invalid content-length");
    }
    if (length > maxBytes) {
      throw new HttpError(413, "request body is too large");
    }
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new HttpError(413, "request body is too large");
  }
  return body;
}
