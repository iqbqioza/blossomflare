import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { finalizeEvent } from "nostr-tools/pure";
import { sha256Hex } from "../src/worker/crypto";
import {
  adminPubkey,
  adminSecret,
  ADMIN_URL,
  allowUploader,
  authHeader,
  blossomAuth,
  newUser,
  pngBytes,
  resetDb,
  setPolicy,
  uploadAs,
} from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("BUD-11 authorization", () => {
  it("accepts a valid upload token from an allowed pubkey", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);

    const { response, sha256 } = await uploadAs(user.secret, pngBytes);

    expect(response.status).toBe(201);
    const descriptor = await response.json<{
      sha256: string;
      url: string;
      type: string;
    }>();
    expect(descriptor.sha256).toBe(sha256);
    expect(descriptor.url).toBe(`${ADMIN_URL}/${sha256}.png`);
    expect(descriptor.type).toBe("image/png");
  });

  it("rejects a missing authorization header", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: sha256,
      expirationOffset: -10,
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token with the wrong action", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "delete",
      hash: sha256,
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token with the wrong blob hash", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: "00".repeat(32),
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token scoped to another server", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: sha256,
      hostname: "other.example",
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token with an invalid signature", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: 24242,
        created_at: now,
        tags: [
          ["t", "upload"],
          ["x", sha256],
          ["server", "example.com"],
          ["expiration", String(now + 300)],
        ],
        content: "Upload Blob",
      },
      user.secret,
    );
    const tampered = {
      ...event,
      sig: `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}`,
    };

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authHeader(tampered),
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token with a future created_at", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: sha256,
      createdAtOffset: 100,
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token with an excessive lifetime", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const authorization = blossomAuth(user.secret, {
      action: "upload",
      hash: sha256,
      expirationOffset: 7200,
    });

    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "X-SHA-256": sha256,
      },
      body: pngBytes,
    });
    expect(response.status).toBe(401);
  });
});

describe("upload allowlist", () => {
  it("rejects an unlisted pubkey by default", async () => {
    const user = newUser();
    const { response } = await uploadAs(user.secret, pngBytes);
    expect(response.status).toBe(403);
  });

  it("allows any pubkey when policy is open", async () => {
    await setPolicy("open");
    const user = newUser();
    const { response } = await uploadAs(user.secret, pngBytes);
    expect(response.status).toBe(201);
  });

  it("always allows the admin", async () => {
    const { response } = await uploadAs(adminSecret(), pngBytes);
    expect(response.status).toBe(201);
    expect(adminPubkey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks HEAD /upload against the allowlist", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);

    const allowed = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "HEAD",
      headers: {
        Authorization: blossomAuth(user.secret, {
          action: "upload",
          hash: sha256,
        }),
        "X-SHA-256": sha256,
        "X-Content-Length": String(pngBytes.byteLength),
        "X-Content-Type": "image/png",
      },
    });
    expect(allowed.status).toBe(200);

    const other = newUser();
    const denied = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "HEAD",
      headers: {
        Authorization: blossomAuth(other.secret, {
          action: "upload",
          hash: sha256,
        }),
        "X-SHA-256": sha256,
        "X-Content-Length": String(pngBytes.byteLength),
        "X-Content-Type": "image/png",
      },
    });
    expect(denied.status).toBe(403);
  });

  it("returns 400 for a missing X-SHA-256 on HEAD /upload", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "HEAD",
      headers: { "X-Content-Length": "12" },
    });
    expect(response.status).toBe(400);
  });

  it("returns 413 when the declared size is too large", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const sha256 = await sha256Hex(pngBytes);
    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "HEAD",
      headers: {
        Authorization: blossomAuth(user.secret, {
          action: "upload",
          hash: sha256,
        }),
        "X-SHA-256": sha256,
        "X-Content-Length": "99999999",
        "X-Content-Type": "image/png",
      },
    });
    expect(response.status).toBe(413);
  });
});

describe("CORS", () => {
  it("answers preflight requests", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Authorization",
    );
  });
});
