import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { finalizeEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import {
  adminFetch,
  adminPubkey,
  adminSecret,
  ADMIN_URL,
  allowUploader,
  newUser,
  nip98Auth,
  pngBytes,
  resetDb,
  testEnv,
  uploadAs,
} from "./helpers";

beforeEach(async () => {
  await resetDb();
});

describe("admin authorization", () => {
  it("rejects requests without authorization", async () => {
    const response = await SELF.fetch(`${ADMIN_URL}/api/admin/settings`);
    expect(response.status).toBe(401);
  });

  it("rejects non-admin signatures", async () => {
    const user = newUser();
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(user.secret, "GET", url);
    const response = await SELF.fetch(url, {
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(403);
  });

  it("returns the admin session", async () => {
    const response = await adminFetch("/api/admin/settings");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adminPubkey: string;
      uploadPolicy: string;
    };
    expect(body.adminPubkey).toBe(adminPubkey());
    expect(body.uploadPolicy).toBe("allowlist");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a mismatched NIP-98 payload", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(
      adminSecret(),
      "PUT",
      url,
      JSON.stringify({ uploadPolicy: "open" }),
    );
    const response = await SELF.fetch(url, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadPolicy: "allowlist" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a mismatched NIP-98 URL", async () => {
    const authorization = await nip98Auth(
      adminSecret(),
      "GET",
      `${ADMIN_URL}/api/admin/stats`,
    );
    const response = await SELF.fetch(`${ADMIN_URL}/api/admin/settings`, {
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a mismatched NIP-98 method", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(adminSecret(), "GET", url);
    const response = await SELF.fetch(url, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadPolicy: "open" }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts standard base64 NIP-98 tokens", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(
      adminSecret(),
      "GET",
      url,
      undefined,
      { standardBase64: true },
    );
    const response = await SELF.fetch(url, {
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(200);
  });

  it("accepts NIP-98 tokens without an expiration tag", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(
      adminSecret(),
      "GET",
      url,
      undefined,
      { includeExpiration: false },
    );
    const response = await SELF.fetch(url, {
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(200);
  });

  it("rejects a null settings body with 400", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(adminSecret(), "PUT", url, "null");
    const response = await SELF.fetch(url, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: "null",
    });
    expect(response.status).toBe(400);
  });
});

describe("upload policy", () => {
  it("switches to open and allows an unlisted uploader", async () => {
    const update = await adminFetch("/api/admin/settings", "PUT", {
      uploadPolicy: "open",
    });
    expect(update.status).toBe(200);

    const settings = await adminFetch("/api/admin/settings");
    const body = (await settings.json()) as { uploadPolicy: string };
    expect(body.uploadPolicy).toBe("open");

    const user = newUser();
    const { response } = await uploadAs(user.secret, pngBytes);
    expect(response.status).toBe(201);
  });

  it("rejects an invalid policy", async () => {
    const response = await adminFetch("/api/admin/settings", "PUT", {
      uploadPolicy: "everyone",
    });
    expect(response.status).toBe(400);
  });
});

describe("upload allowlist management", () => {
  it("adds, lists, and removes an uploader", async () => {
    const user = newUser();
    const npub = npubEncode(user.pubkey);

    const added = await adminFetch(
      `/api/admin/uploaders/${npub}`,
      "PUT",
    );
    expect(added.status).toBe(201);

    const duplicate = await adminFetch(
      `/api/admin/uploaders/${npub}`,
      "PUT",
    );
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { created: boolean }).created).toBe(
      false,
    );

    const list = await adminFetch("/api/admin/uploaders?limit=10");
    const body = (await list.json()) as {
      uploaders: Array<{ pubkey: string }>;
      nextCursor: string | null;
    };
    expect(body.uploaders.some((entry) => entry.pubkey === user.pubkey)).toBe(
      true,
    );

    const { response } = await uploadAs(user.secret, pngBytes);
    expect(response.status).toBe(201);

    const removed = await adminFetch(
      `/api/admin/uploaders/${npub}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);

    const denied = await uploadAs(user.secret, new Uint8Array([1, 2, 3]));
    expect(denied.response.status).toBe(403);
  });

  it("keeps existing blobs after an uploader is removed", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const { response, sha256 } = await uploadAs(user.secret, pngBytes);
    expect(response.status).toBe(201);

    await adminFetch(
      `/api/admin/uploaders/${npubEncode(user.pubkey)}`,
      "DELETE",
    );

    const fetched = await SELF.fetch(`${ADMIN_URL}/${sha256}`);
    expect(fetched.status).toBe(200);
  });

  it("rejects invalid npub values and nsec", async () => {
    const invalid = await adminFetch("/api/admin/uploaders/not-an-npub", "PUT");
    expect(invalid.status).toBe(400);

    const nsec = await adminFetch(
      `/api/admin/uploaders/${encodeURIComponent("nsec1invalid")}`,
      "PUT",
    );
    expect(nsec.status).toBe(400);
  });

  it("treats removing a missing uploader as success", async () => {
    const removed = await adminFetch(
      `/api/admin/uploaders/${"ab".repeat(32)}`,
      "DELETE",
    );
    expect(removed.status).toBe(204);
  });

  it("paginates the allowlist", async () => {
    const users = Array.from({ length: 3 }, () => newUser());
    for (const user of users) {
      const response = await adminFetch(
        `/api/admin/uploaders/${npubEncode(user.pubkey)}`,
        "PUT",
      );
      expect(response.status).toBe(201);
    }

    const first = await adminFetch("/api/admin/uploaders?limit=2");
    const firstBody = (await first.json()) as {
      uploaders: Array<{ pubkey: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.uploaders).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await adminFetch(
      `/api/admin/uploaders?limit=2&cursor=${firstBody.nextCursor}`,
    );
    const secondBody = (await second.json()) as {
      uploaders: Array<{ pubkey: string }>;
    };
    expect(secondBody.uploaders).toHaveLength(1);
  });
});

describe("admin data endpoints", () => {
  it("lists blobs and stats", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    await uploadAs(user.secret, pngBytes);

    const blobs = await adminFetch("/api/admin/blobs?limit=10");
    expect(blobs.status).toBe(200);
    const blobBody = (await blobs.json()) as {
      blobs: Array<{ url: string; type: string }>;
    };
    expect(blobBody.blobs).toHaveLength(1);
    expect(blobBody.blobs[0]?.url).toContain("example.com");
    expect(blobBody.blobs[0]?.type).toBe("image/png");

    const stats = await adminFetch("/api/admin/stats");
    const statsBody = (await stats.json()) as {
      blobCount: number;
      totalBytes: number;
    };
    expect(statsBody.blobCount).toBe(1);
    expect(statsBody.totalBytes).toBe(pngBytes.byteLength);
  });

  it("stores and lists blob reports", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    const now = Math.floor(Date.now() / 1000);
    const report = finalizeEvent(
      {
        kind: 1984,
        created_at: now,
        tags: [
          ["x", uploaded.sha256, "malware"],
          ["p", user.pubkey],
        ],
        content: "This is a test report",
      },
      user.secret,
    );

    const posted = await SELF.fetch(`${ADMIN_URL}/report`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(posted.status).toBe(200);

    const reports = await adminFetch("/api/admin/reports?limit=10");
    const body = (await reports.json()) as {
      reports: Array<{ id: string; event: { content: string } | null }>;
    };
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]?.id).toBe(report.id);
    expect(body.reports[0]?.event?.content).toBe("This is a test report");
  });

  it("rejects reports for unknown blobs", async () => {
    const user = newUser();
    const report = finalizeEvent(
      {
        kind: 1984,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["x", "ab".repeat(32), "malware"]],
        content: "Unknown blob",
      },
      user.secret,
    );

    const posted = await SELF.fetch(`${ADMIN_URL}/report`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(posted.status).toBe(400);
  });

  it("rejects reports that mix existing and unknown blobs", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    const report = finalizeEvent(
      {
        kind: 1984,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["x", uploaded.sha256, "malware"],
          ["x", "ab".repeat(32), "malware"],
        ],
        content: "Mixed hashes",
      },
      user.secret,
    );

    const posted = await SELF.fetch(`${ADMIN_URL}/report`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(posted.status).toBe(400);
  });

  it("rate-limits reports per pubkey", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    const now = Math.floor(Date.now() / 1000);

    for (let index = 0; index < 20; index++) {
      await testEnv.DB.prepare(
        `INSERT INTO reports (id, pubkey, created_at, received_at, event_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          `${index.toString(16).padStart(64, "0")}`,
          user.pubkey,
          now,
          now,
          "{}",
        )
        .run();
    }

    const report = finalizeEvent(
      {
        kind: 1984,
        created_at: now,
        tags: [["x", uploaded.sha256, "malware"]],
        content: "One too many",
      },
      user.secret,
    );
    const posted = await SELF.fetch(`${ADMIN_URL}/report`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(posted.status).toBe(429);
  });
});
