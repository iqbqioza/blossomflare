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

async function adminRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, location.origin).toString();
  const text = body === undefined ? null : JSON.stringify(body);
  const authorization = await nip98Header(method, url, text);

  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: {
      Authorization: authorization,
      ...(text === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(text === null ? {} : { body: text }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function getSettings(): Promise<AdminSettings> {
  return adminRequest<AdminSettings>("GET", "/api/admin/settings");
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
