import {
  blossomAuthHeader,
  nip98Header,
  sha256Hex,
  type NostrEvent,
} from "./nostr";

export type UploadPolicy = "open" | "allowlist";

export interface AdminSettings {
  adminPubkey: string;
  uploadPolicy: UploadPolicy;
  maxUploadBytes: number;
  csrfToken?: string;
  expiresAt?: number;
}

export interface UploaderEntry {
  pubkey: string;
  addedAt: number;
  addedBy: string;
}

export interface BlobRecord {
  sha256: string;
  pubkey: string;
  size: number;
  type: string;
  filename: string | null;
  uploaded: number;
  url: string;
}

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

export interface ReportRecord {
  id: string;
  pubkey: string;
  createdAt: number;
  receivedAt: number;
  eventJson: string;
  event: NostrEvent | null;
}

export interface Stats {
  blobCount: number;
  totalBytes: number;
  reportCount: number;
  uploaderCount: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;

function isCsrfToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function clearSessionToken(): void {
  csrfToken = null;
}

async function adminRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, location.origin).toString();
  const text = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};

  if (text !== null) {
    headers["Content-Type"] = "application/json";
  }

  if (csrfToken === null) {
    headers.Authorization = await nip98Header(method, url, text);
  } else if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const response = await fetch(url, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers,
    ...(text === null ? {} : { body: text }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      csrfToken = null;
    }
    throw new ApiError(response.status, await errorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function restoreSession(): Promise<AdminSettings | null> {
  const response = await fetch("/api/admin/settings", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });

  if (response.status === 401) {
    csrfToken = null;
    return null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }

  const settings = (await response.json()) as AdminSettings;
  if (!isCsrfToken(settings.csrfToken)) {
    csrfToken = null;
    return null;
  }

  csrfToken = settings.csrfToken;
  return settings;
}

export async function createSession(): Promise<AdminSettings> {
  const url = new URL("/api/admin/session", location.origin).toString();
  const authorization = await nip98Header("POST", url, null);
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Authorization: authorization },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }

  const settings = (await response.json()) as AdminSettings;
  if (!isCsrfToken(settings.csrfToken)) {
    throw new Error("The server did not return a CSRF token");
  }

  csrfToken = settings.csrfToken;
  return settings;
}

export async function logout(): Promise<void> {
  try {
    let token = csrfToken;

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch("/api/admin/session", {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: token === null ? {} : { "X-CSRF-Token": token },
      });

      if (response.ok || response.status === 401) {
        return;
      }

      if (response.status === 403 && attempt === 0) {
        const settings = await restoreSession();
        if (settings === null || !isCsrfToken(settings.csrfToken)) {
          return;
        }
        token = settings.csrfToken;
        continue;
      }

      throw new ApiError(response.status, await errorMessage(response));
    }
  } finally {
    csrfToken = null;
  }
}

export async function updateSettings(
  uploadPolicy: UploadPolicy,
): Promise<{ ok: boolean; uploadPolicy: UploadPolicy }> {
  return adminRequest("PUT", "/api/admin/settings", { uploadPolicy });
}

export async function listUploaders(
  cursor: string | null,
): Promise<{ uploaders: UploaderEntry[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor !== null) params.set("cursor", cursor);
  return adminRequest(
    "GET",
    `/api/admin/uploaders?${params.toString()}`,
  );
}

export async function addUploader(
  pubkey: string,
): Promise<{ pubkey: string; created: boolean }> {
  return adminRequest(
    "PUT",
    `/api/admin/uploaders/${encodeURIComponent(pubkey)}`,
  );
}

export async function removeUploader(pubkey: string): Promise<void> {
  await adminRequest(
    "DELETE",
    `/api/admin/uploaders/${encodeURIComponent(pubkey)}`,
  );
}

export async function listBlobs(options: {
  cursor: string | null;
  pubkey?: string;
}): Promise<{ blobs: BlobRecord[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "50" });
  if (options.cursor !== null) params.set("cursor", options.cursor);
  if (options.pubkey) params.set("pubkey", options.pubkey);
  return adminRequest("GET", `/api/admin/blobs?${params.toString()}`);
}

export async function getStats(): Promise<Stats> {
  return adminRequest<Stats>("GET", "/api/admin/stats");
}

export async function listReports(
  cursor: string | null,
): Promise<{ reports: ReportRecord[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor !== null) params.set("cursor", cursor);
  return adminRequest("GET", `/api/admin/reports?${params.toString()}`);
}

export async function uploadBlob(file: File): Promise<BlobDescriptor> {
  const data = await file.arrayBuffer();
  const sha256 = await sha256Hex(data);
  const authorization = await blossomAuthHeader("upload", sha256);

  const response = await fetch("/upload", {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": file.type || "application/octet-stream",
      "X-SHA-256": sha256,
    },
    body: data,
  });

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }
  return (await response.json()) as BlobDescriptor;
}

export async function deleteBlob(sha256: string): Promise<void> {
  const authorization = await blossomAuthHeader("delete", sha256);
  const response = await fetch(`/${sha256}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
  });

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }
}

async function errorMessage(response: Response): Promise<string> {
  const reason = response.headers.get("x-reason");
  if (reason) return reason;

  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // ignore
  }

  return `HTTP ${response.status}`;
}
