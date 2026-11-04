export interface StoreResult {
  created: boolean;
  meta: BlobMeta;
}

export interface DeleteResult {
  deleted: boolean;
  conflict: boolean;
}

export interface BlobCoordinatorRpc {
  store(
    data: ArrayBuffer,
    sha256: string,
    type: string,
    pubkey: string,
  ): Promise<StoreResult>;
  remove(sha256: string, uploadId: string): Promise<DeleteResult>;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  BLOB_COORDINATOR: DurableObjectNamespace;
  ADMIN_NPUB: string;
  MAX_UPLOAD_BYTES: string;
  ENABLE_MIRROR: string;
  [key: string]: unknown;
}

export type UploadPolicy = "open" | "allowlist";

export interface BlobMeta {
  uploadId?: string;
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
