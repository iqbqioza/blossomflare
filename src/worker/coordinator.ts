import { DurableObject } from "cloudflare:workers";
import { getBlobMeta, insertBlob, tombstoneBlob } from "./db";
import type {
  BlobMeta,
  DeleteResult,
  Env,
  StoreResult,
} from "./types";

export class BlobCoordinator extends DurableObject<Env> {
  async store(
    data: ArrayBuffer,
    sha256: string,
    type: string,
    pubkey: string,
  ): Promise<StoreResult> {
    const existing = await getBlobMeta(this.env, sha256);

    if (existing) {
      if (await this.env.BLOBS.head(sha256)) {
        return { created: false, meta: existing };
      }

      await this.env.BLOBS.put(sha256, data, {
        httpMetadata: { contentType: type },
        customMetadata: { pubkey },
      });
      return { created: false, meta: existing };
    }

    const meta: BlobMeta = {
      uploadId: crypto.randomUUID(),
      sha256,
      pubkey,
      size: data.byteLength,
      type,
      filename: null,
      uploaded: Math.floor(Date.now() / 1000),
    };

    await this.env.BLOBS.put(sha256, data, {
      httpMetadata: { contentType: type },
      customMetadata: { pubkey },
    });

    try {
      if (await insertBlob(this.env, meta)) {
        return { created: true, meta };
      }

      const row = await getBlobMeta(this.env, sha256);
      if (row) {
        return { created: false, meta: row };
      }

      if (await insertBlob(this.env, meta)) {
        return { created: true, meta };
      }

      throw new Error("failed to persist blob metadata");
    } catch (error) {
      try {
        await this.env.BLOBS.delete(sha256);
      } catch {
        // The original error is more useful than cleanup failure.
      }
      throw error;
    }
  }

  async remove(sha256: string, uploadId: string): Promise<DeleteResult> {
    const meta = await getBlobMeta(this.env, sha256);
    if (!meta || meta.uploadId !== uploadId) {
      return { deleted: false, conflict: true };
    }

    const deleted = await tombstoneBlob(this.env, meta);
    if (!deleted) {
      return { deleted: false, conflict: true };
    }

    try {
      await this.env.BLOBS.delete(sha256);
    } catch (error) {
      console.error(
        "Failed to delete R2 object after metadata deletion",
        sha256,
        error instanceof Error ? error.message : "unknown error",
      );
    }

    return { deleted: true, conflict: false };
  }
}
