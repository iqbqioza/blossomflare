import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { sha256Hex } from "../src/worker/crypto";
import {
  ADMIN_URL,
  adminSecret,
  allowUploader,
  blossomAuth,
  deleteAs,
  newUser,
  pngBytes,
  resetDb,
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
  });

  it("returns 404 for an unknown blob", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/${"ab".repeat(32)}`);
    expect(response.status).toBe(404);
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

  it("returns 404 when deleting a missing blob", async () => {
    const user = newUser();
    const deleted = await deleteAs(user.secret, "ab".repeat(32));
    expect(deleted.status).toBe(404);
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
