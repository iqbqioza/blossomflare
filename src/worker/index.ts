import { handleAdmin } from "./admin";
import { handleDelete, handleGetBlob, handleHeadUpload, handleList, handleMedia, handleUpload } from "./blobs";
import {
  addAdminHeaders,
  corsPreflight,
  errorResponse,
  HttpError,
  methodNotAllowed,
  withCors,
} from "./http";
import { handleMirror } from "./mirror";
import { handleReport } from "./report";
import type { Env } from "./types";

const BLOB_PATH = /^\/([0-9a-f]{64})(?:\.[A-Za-z0-9]{1,32})?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isAdmin = url.pathname === "/api/admin" ||
      url.pathname.startsWith("/api/admin/");

    try {
      if (isAdmin) {
        return await handleAdmin(request, env);
      }

      if (request.method === "OPTIONS") {
        return corsPreflight();
      }

      return withCors(await route(request, url, env));
    } catch (error) {
      if (error instanceof HttpError) {
        const response = errorResponse(
          error.status,
          error.reason,
          error.headers ?? {},
        );
        return isAdmin ? response : withCors(response);
      }

      console.error(
        "Unhandled worker error",
        request.method,
        url.pathname,
        error instanceof Error ? error.message : "unknown error",
      );
      const response = errorResponse(500, "internal server error");
      return isAdmin ? response : withCors(response);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const path = url.pathname;

  if (path === "/upload") {
    if (request.method === "PUT") {
      return handleUpload(request, env);
    }
    if (request.method === "HEAD") {
      return handleHeadUpload(request, env);
    }
    return methodNotAllowed("PUT, HEAD, OPTIONS");
  }

  if (path === "/mirror") {
    return handleMirror(request, env);
  }

  if (path === "/report") {
    return handleReport(request, env);
  }

  if (path === "/media") {
    return handleMedia(request);
  }

  if (path.startsWith("/list/")) {
    return handleList(request, env, path.slice("/list/".length));
  }

  if (path === "/" || path === "/admin" || path === "/admin/" ||
    path.startsWith("/admin/")) {
    return serveIndex(request, url, env);
  }

  if (path === "/index.html") {
    return serveIndex(request, url, env);
  }

  if (
    path.startsWith("/assets/") ||
    path === "/favicon.svg" ||
    path === "/favicon.ico" ||
    path === "/robots.txt" ||
    path === "/site.webmanifest"
  ) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD, OPTIONS");
    }
    const response = await env.ASSETS.fetch(request);
    return response.status === 404 ? errorResponse(404, "not found") : response;
  }

  const blobMatch = BLOB_PATH.exec(path);
  if (blobMatch?.[1]) {
    const sha256 = blobMatch[1];
    if (request.method === "GET" || request.method === "HEAD") {
      return handleGetBlob(request, env, sha256);
    }
    if (request.method === "DELETE") {
      return handleDelete(request, env, sha256);
    }
    return methodNotAllowed("GET, HEAD, DELETE, OPTIONS");
  }

  return errorResponse(404, "not found");
}

async function serveIndex(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed("GET, HEAD, OPTIONS");
  }

  const response = await env.ASSETS.fetch(new URL("/index.html", url));
  if (response.status === 404) {
    return errorResponse(404, "admin UI is not built");
  }

  const result = addAdminHeaders(response);
  if (request.method === "HEAD") {
    return new Response(null, {
      status: result.status,
      headers: result.headers,
    });
  }
  return result;
}
