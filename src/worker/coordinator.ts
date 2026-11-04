import { DurableObject } from "cloudflare:workers";
import { getBlobMeta, insertBlob, tombstoneBlob } from "./db";
import type {
  BlobMeta,
  DeleteResult,
  Env,
  StoreResult,
} from "./types";

export class BlobCoordinator extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();

  // Durable Objects are single-threaded, but awaiting external R2/D1 I/O
  // allows another event to interleave. Queue the whole critical section.
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  store(
    data: ArrayBuffer,
    sha256: string,
    type: string,
    pubkey: string,
  ): Promise<StoreResult> {
    return this.serialize(() =>
      this.storeInternal(data, sha256, type, pubkey)
    );
  }

  private async maybeTestDelay(): Promise<void> {
    const raw = this.env.TEST_COORDINATOR_DELAY_MS;
    const delay = typeof raw === "string" ? Number(raw) : 0;
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async storeInternal(
    data: ArrayBuffer,
    sha256: string,
    type: string,
    pubkey: string,
  ): Promise<StoreResult> {
    const existing = await getBlobMeta(this.env, sha256);
    await this.maybeTestDelay();

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

  remove(sha256: string, uploadId: string): Promise<DeleteResult> {
    return this.serialize(() => this.removeInternal(sha256, uploadId));
  }

  private async removeInternal(
    sha256: string,
    uploadId: string,
  ): Promise<DeleteResult> {
    const meta = await getBlobMeta(this.env, sha256);
    await this.maybeTestDelay();
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
        "Failed to delete R2 object; rolling back metadata",
        sha256,
        error instanceof Error ? error.message : "unknown error",
      );
      try {
        await insertBlob(this.env, meta);
      } catch (rollbackError) {
        console.error(
          "Failed to roll back blob metadata",
          sha256,
          rollbackError instanceof Error ? rollbackError.message : "unknown error",
        );
      }
      return { deleted: false, conflict: false };
    }

    return { deleted: true, conflict: false };
  }
}
