import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { getMaxUploadBytes } from "../src/worker/blobs";
import { getBlobMeta, tombstoneBlob } from "../src/worker/db";
import { sha256Hex } from "../src/worker/crypto";
import type { Env } from "../src/worker/types";
import {
  ADMIN_URL,
  adminSecret,
  allowUploader,
  blossomAuth,
  deleteAs,
  newUser,
  pngBytes,
  resetDb,
  testEnv,
  uploadAs,
} from "./helpers";

beforeEach(async () => {
  await resetDb();
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("blob retrieval", () => {
  it("stores and serves a blob with the correct content type", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("hello blossom");
    const { response, sha256 } = await uploadAs(user.secret, data, {
      contentType: "text/plain",
    });
    expect(response.status).toBe(201);

    const fetched = await SELF.fetch(`${ADMIN_URL}/${sha256}.txt`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("text/plain");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(data);
  });

  it("supports HEAD", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(pngBytes.byteLength));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("supports range requests", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("0123456789");
    const { sha256 } = await uploadAs(user.secret, data, {
      contentType: "text/plain",
    });

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 2-5/${data.byteLength}`,
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("2345");
  });

  it("rejects an invalid range", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      headers: { Range: "bytes=9999-10000" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(
      `bytes */${pngBytes.byteLength}`,
    );
    expect(response.headers.get("content-length")).toBe("0");
  });

  it("honors Range when If-Range matches", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("0123456789");
    const { sha256 } = await uploadAs(user.secret, data, {
      contentType: "text/plain",
    });

    const head = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      method: "HEAD",
    });
    const etag = head.headers.get("etag");
    expect(etag).not.toBeNull();

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      headers: {
        Range: "bytes=2-5",
        "If-Range": etag as string,
      },
    });
    expect(response.status).toBe(206);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("2345");
  });

  it("ignores Range when If-Range does not match", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("0123456789");
    const { sha256 } = await uploadAs(user.secret, data, {
      contentType: "text/plain",
    });

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      headers: {
        Range: "bytes=2-5",
        "If-Range": '"not-the-current-etag"',
      },
    });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "0123456789",
    );
  });

  it("ignores unsupported multiple ranges", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("0123456789");
    const { sha256 } = await uploadAs(user.secret, data, {
      contentType: "text/plain",
    });

    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      headers: { Range: "bytes=0-1,4-5" },
    });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      "0123456789",
    );
  });

  it("accepts a long file extension", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);
    const response = await SELF.fetch(`${ADMIN_URL}/${sha256}.webmanifest`);
    expect(response.status).toBe(200);
  });

  it("returns 404 for an unknown blob", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/${"ab".repeat(32)}`);
    expect(response.status).toBe(404);
  });

  it("does not serve orphaned R2 objects without metadata", async () => {
    const sha256 = await sha256Hex(pngBytes);
    await testEnv.BLOBS.put(sha256, pngBytes, {
      httpMetadata: { contentType: "image/png" },
    });

    const orphan = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(orphan.status).toBe(404);

    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    expect(uploaded.response.status).toBe(201);

    const repaired = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(repaired.status).toBe(200);
  });
});

describe("blob upload", () => {
  it("returns 200 when the blob already exists", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);

    const first = await uploadAs(user.secret, pngBytes);
    expect(first.response.status).toBe(201);

    const second = await uploadAs(user.secret, pngBytes);
    expect(second.response.status).toBe(200);
  });

  it("serializes concurrent uploads of the same blob", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => uploadAs(user.secret, pngBytes)),
    );
    const statuses = results.map((result) => result.response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(4);

    const row = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM blobs WHERE sha256 = ?",
    )
      .bind(await sha256Hex(pngBytes))
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("returns 409 when X-SHA-256 does not match the body", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { response } = await uploadAs(user.secret, pngBytes, {
      hash: "00".repeat(32),
    });
    expect(response.status).toBe(409);
  });

  it("returns 413 when the body exceeds the limit", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const large = new Uint8Array(1024 * 1024 + 1);
    const { response } = await uploadAs(user.secret, large);
    expect(response.status).toBe(413);
  });

  it("accepts an upload without X-SHA-256", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const data = bytes("no header");
    const sha256 = await sha256Hex(data);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: sha256,
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "text/plain",
      },
      body: data,
    });
    expect(response.status).toBe(201);
  });
});

describe("blob deletion", () => {
  it("allows the owner to delete a blob", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);

    const deleted = await deleteAs(user.secret, sha256);
    expect(deleted.status).toBe(204);

    const fetched = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(fetched.status).toBe(404);
  });

  it("rejects deletion by a different user", async () => {
    const owner = newUser();
    const other = newUser();
    await allowUploader(owner.pubkey);
    const { sha256 } = await uploadAs(owner.secret, pngBytes);

    const deleted = await deleteAs(other.secret, sha256);
    expect(deleted.status).toBe(403);
  });

  it("allows the admin to delete any blob", async () => {
    const owner = newUser();
    await allowUploader(owner.pubkey);
    const { sha256 } = await uploadAs(owner.secret, pngBytes);

    const deleted = await deleteAs(adminSecret(), sha256);
    expect(deleted.status).toBe(204);
  });

  it("serializes concurrent deletes of the same blob", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);

    const tokens = [
      blossomAuth(user.secret, {
        action: "delete",
        hash: sha256,
        createdAtOffset: -1,
      }),
      blossomAuth(user.secret, {
        action: "delete",
        hash: sha256,
      }),
    ];

    const responses = await Promise.all(
      tokens.map((authorization) =>
        SELF.fetch(`${ADMIN_URL}/${sha256}`, {
          method: "DELETE",
          headers: { Authorization: authorization },
        })
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 204)).toHaveLength(1);
    expect(
      statuses.filter((status) => status === 404 || status === 409),
    ).toHaveLength(1);

    const fetched = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(fetched.status).toBe(404);
  });

  it("returns 404 when deleting a missing blob", async () => {
    const user = newUser();
    const deleted = await deleteAs(user.secret, "ab".repeat(32));
    expect(deleted.status).toBe(404);
  });

  it("rejects a delete token replayed against a re-uploaded blob", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);
    const replayToken = blossomAuth(user.secret, {
      action: "delete",
      hash: sha256,
    });

    const firstDelete = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: replayToken },
    });
    expect(firstDelete.status).toBe(204);

    const reuploaded = await uploadAs(user.secret, pngBytes);
    expect(reuploaded.response.status).toBe(201);

    const replay = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: replayToken },
    });
    expect(replay.status).toBe(401);

    const stillThere = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(stillThere.status).toBe(200);
  });

  it("accepts a delete token with a past created_at within the lifetime", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "delete",
      hash: sha256,
      createdAtOffset: -31,
    });

    const deleted = await SELF.fetch(`${ADMIN_URL}/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: authorization },
    });
    expect(deleted.status).toBe(204);
  });

  it("does not delete a newer upload with stale metadata", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { sha256 } = await uploadAs(user.secret, pngBytes);
    const stale = await getBlobMeta(testEnv, sha256);
    expect(stale).not.toBeNull();

    expect((await deleteAs(user.secret, sha256)).status).toBe(204);
    expect((await uploadAs(user.secret, pngBytes)).response.status).toBe(201);

    expect(await tombstoneBlob(testEnv, stale as NonNullable<typeof stale>)).toBe(
      false,
    );
    const stillThere = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(stillThere.status).toBe(200);
  });
});

describe("upload limits", () => {
  it("handles fractional and out-of-range configuration", () => {
    const envWith = (value: string) =>
      ({ MAX_UPLOAD_BYTES: value }) as unknown as Env;

    expect(getMaxUploadBytes(envWith("0.5"))).toBe(10 * 1024 * 1024);
    expect(getMaxUploadBytes(envWith("0"))).toBe(10 * 1024 * 1024);
    expect(getMaxUploadBytes(envWith("-1"))).toBe(10 * 1024 * 1024);
    expect(getMaxUploadBytes(envWith("1"))).toBe(1);
    expect(getMaxUploadBytes(envWith("999999999"))).toBe(25 * 1024 * 1024);
  });
});

describe("blob listing", () => {
  it("paginates blobs by pubkey", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const hashes: string[] = [];
    for (const value of ["one", "two", "three"]) {
      const { sha256 } = await uploadAs(user.secret, bytes(value));
      hashes.push(sha256);
    }

    const first = await SELF.fetch(
      `${ADMIN_URL}/list/${user.pubkey}?limit=2`,
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as Array<{ sha256: string }>;
    expect(firstPage).toHaveLength(2);
    expect(first.headers.get("x-next-cursor")).toBe(firstPage[1]?.sha256);

    const cursor = first.headers.get("x-next-cursor");
    const second = await SELF.fetch(
      `${ADMIN_URL}/list/${user.pubkey}?limit=2&cursor=${cursor}`,
    );
    const secondPage = (await second.json()) as Array<{ sha256: string }>;
    expect(secondPage).toHaveLength(1);
    expect(
      new Set([...firstPage, ...secondPage].map((item) => item.sha256)),
    ).toEqual(new Set(hashes));
  });

  it("keeps pagination working when the cursor blob is deleted", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    for (const value of ["one", "two", "three"]) {
      await uploadAs(user.secret, bytes(value));
    }

    const first = await SELF.fetch(
      `${ADMIN_URL}/list/${user.pubkey}?limit=2`,
    );
    expect(first.status).toBe(200);
    const cursor = first.headers.get("x-next-cursor");
    expect(cursor).not.toBeNull();

    const deleted = await deleteAs(user.secret, cursor as string);
    expect(deleted.status).toBe(204);

    const second = await SELF.fetch(
      `${ADMIN_URL}/list/${user.pubkey}?limit=2&cursor=${cursor}`,
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as Array<{ sha256: string }>;
    expect(secondPage).toHaveLength(1);
  });

  it("paginates after a blob is re-uploaded by another pubkey", async () => {
    const firstUser = newUser();
    const secondUser = newUser();
    await allowUploader(firstUser.pubkey);
    await allowUploader(secondUser.pubkey);

    const reuploaded = await uploadAs(firstUser.secret, pngBytes);
    expect(reuploaded.response.status).toBe(201);
    expect((await deleteAs(firstUser.secret, reuploaded.sha256)).status).toBe(
      204,
    );

    const older = await uploadAs(secondUser.secret, bytes("older blob"));
    expect(older.response.status).toBe(201);
    const again = await uploadAs(secondUser.secret, pngBytes);
    expect(again.response.status).toBe(201);

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "UPDATE blobs SET uploaded = 100 WHERE sha256 = ?",
      ).bind(older.sha256),
      testEnv.DB.prepare(
        "UPDATE blobs SET uploaded = 200 WHERE sha256 = ?",
      ).bind(reuploaded.sha256),
    ]);

    const firstPage = await SELF.fetch(
      `${ADMIN_URL}/list/${secondUser.pubkey}?limit=1`,
    );
    const firstItems = (await firstPage.json()) as Array<{ sha256: string }>;
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]?.sha256).toBe(reuploaded.sha256);

    const cursor = firstPage.headers.get("x-next-cursor");
    const secondPage = await SELF.fetch(
      `${ADMIN_URL}/list/${secondUser.pubkey}?limit=1&cursor=${cursor}`,
    );
    const secondItems = (await secondPage.json()) as Array<{ sha256: string }>;
    expect(secondItems).toHaveLength(1);
    expect(secondItems[0]?.sha256).toBe(older.sha256);
  });

  it("rejects a cursor belonging to another pubkey", async () => {
    const owner = newUser();
    const other = newUser();
    await allowUploader(owner.pubkey);
    await allowUploader(other.pubkey);
    const ownerBlob = await uploadAs(owner.secret, bytes("owner"));
    await uploadAs(other.secret, bytes("other"));

    const response = await SELF.fetch(
      `${ADMIN_URL}/list/${other.pubkey}?cursor=${ownerBlob.sha256}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("rejects an invalid pubkey", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/list/not-a-pubkey`);
    expect(response.status).toBe(400);
  });
});

describe("unsupported media endpoint", () => {
  it("returns 501 for BUD-05", async () => {
    const head = await SELF.fetch(`${ADMIN_URL}/media`, { method: "HEAD" });
    expect(head.status).toBe(501);
    expect(head.headers.get("x-reason")).toContain("not supported");

    const put = await SELF.fetch(`${ADMIN_URL}/media`, { method: "PUT" });
    expect(put.status).toBe(501);
  });
});
