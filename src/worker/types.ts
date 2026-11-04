export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_NPUB: string;
  MAX_UPLOAD_BYTES: string;
  ENABLE_MIRROR: string;
  [key: string]: unknown;
}

export type UploadPolicy = "open" | "allowlist";

export interface BlobMeta {
  sha256: string;
  pubkey: string;
  size: number;
  type: string;
  filename: string | null;
  uploaded: number;
}

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

export interface UploaderEntry {
  pubkey: string;
  addedAt: number;
  addedBy: string;
}

export interface ReportEntry {
  id: string;
  pubkey: string;
  createdAt: number;
  receivedAt: number;
  eventJson: string;
}

export interface Stats {
  blobCount: number;
  totalBytes: number;
  reportCount: number;
  uploaderCount: number;
}
