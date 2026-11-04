import { beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { finalizeEvent } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import {
  adminFetch,
  adminLogin,
  adminPubkey,
  adminSecret,
  ADMIN_URL,
  allowUploader,
  newUser,
  nip98Auth,
  pngBytes,
  resetDb,
  sessionFetch,
  testEnv,
  uploadAs,
} from "./helpers";
import { sha256Hex } from "../src/worker/crypto";

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
      maxUploadBytes: number;
    };
    expect(body.adminPubkey).toBe(adminPubkey());
    expect(body.uploadPolicy).toBe("allowlist");
    expect(body.maxUploadBytes).toBe(1024 * 1024);
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

  it("rejects a replayed NIP-98 token", async () => {
    const url = `${ADMIN_URL}/api/admin/settings`;
    const authorization = await nip98Auth(adminSecret(), "GET", url);

    const first = await SELF.fetch(url, {
      headers: { Authorization: authorization },
    });
    expect(first.status).toBe(200);

    const replay = await SELF.fetch(url, {
      headers: { Authorization: authorization },
    });
    expect(replay.status).toBe(401);
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

  it("rejects an unsafe uploader cursor", async () => {
    const response = await adminFetch(
      `/api/admin/uploaders?cursor=${"9".repeat(40)}:${"ab".repeat(32)}`,
    );
    expect(response.status).toBe(400);
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
    const windowStart = Math.floor(now / 3600);

    await testEnv.DB.prepare(
      `INSERT INTO report_rate_limits (pubkey, window_start, count)
       VALUES (?, ?, ?)`,
    )
      .bind(user.pubkey, windowStart, 20)
      .run();

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

  it("enforces the global report rate limit", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 3600);

    await testEnv.DB.prepare(
      `INSERT INTO report_rate_limits (pubkey, window_start, count)
       VALUES ('*', ?, ?)`,
    )
      .bind(windowStart, 100)
      .run();

    const report = finalizeEvent(
      {
        kind: 1984,
        created_at: now,
        tags: [["x", uploaded.sha256, "malware"]],
        content: "Global limit",
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

  it("enforces the report rate limit atomically under concurrency", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    const uploaded = await uploadAs(user.secret, pngBytes);
    const now = Math.floor(Date.now() / 1000);

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) => {
        const report = finalizeEvent(
          {
            kind: 1984,
            created_at: now + index,
            tags: [["x", uploaded.sha256, "malware"]],
            content: `Concurrent report ${index}`,
          },
          user.secret,
        );
        return SELF.fetch(`${ADMIN_URL}/report`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
        });
      }),
    );

    const accepted = responses.filter((response) => response.status === 200);
    const limited = responses.filter((response) => response.status === 429);
    expect(accepted).toHaveLength(20);
    expect(limited).toHaveLength(10);

    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM reports WHERE pubkey = ?",
    )
      .bind(user.pubkey)
      .first<{ count: number }>();
    expect(count?.count).toBe(20);
  });
});

describe("admin sessions", () => {
  it("creates a cookie session and restores settings without NIP-98", async () => {
    const { cookie, csrfToken } = await adminLogin();
    expect(cookie).toMatch(/^blossomflare_admin=[0-9a-f]{64}$/);
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);

    const response = await sessionFetch(cookie, "/api/admin/settings");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      adminPubkey: string;
      uploadPolicy: string;
      maxUploadBytes: number;
      csrfToken: string;
    };
    expect(body.adminPubkey).toBe(adminPubkey());
    expect(body.uploadPolicy).toBe("allowlist");
    expect(body.maxUploadBytes).toBe(1024 * 1024);
    expect(body.csrfToken).toBe(csrfToken);
  });

  it("sets an HttpOnly, SameSite=Strict, Secure cookie", async () => {
    const url = `${ADMIN_URL}/api/admin/session`;
    const authorization = await nip98Auth(adminSecret(), "POST", url);
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(201);

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
  });

  it("requires a matching CSRF token for state-changing requests", async () => {
    const { cookie, csrfToken } = await adminLogin();
    const body = { uploadPolicy: "open" };

    const missing = await sessionFetch(cookie, "/api/admin/settings", {
      method: "PUT",
      body,
    });
    expect(missing.status).toBe(403);

    const wrong = await sessionFetch(cookie, "/api/admin/settings", {
      method: "PUT",
      body,
      csrfToken: "00".repeat(32),
    });
    expect(wrong.status).toBe(403);

    const accepted = await sessionFetch(cookie, "/api/admin/settings", {
      method: "PUT",
      body,
      csrfToken,
    });
    expect(accepted.status).toBe(200);

    const settings = await sessionFetch(cookie, "/api/admin/settings");
    const settingsBody = (await settings.json()) as { uploadPolicy: string };
    expect(settingsBody.uploadPolicy).toBe("open");
  });

  it("rejects a CSRF token from another session", async () => {
    const first = await adminLogin();
    const second = await adminLogin();

    const response = await sessionFetch(second.cookie, "/api/admin/settings", {
      method: "PUT",
      body: { uploadPolicy: "open" },
      csrfToken: first.csrfToken,
    });
    expect(response.status).toBe(403);
  });

  it("does not require a CSRF token for reads", async () => {
    const { cookie } = await adminLogin();
    const response = await sessionFetch(cookie, "/api/admin/stats");
    expect(response.status).toBe(200);
  });

  it("deletes the session on logout and clears the cookie", async () => {
    const { cookie, csrfToken } = await adminLogin();
    const response = await sessionFetch(cookie, "/api/admin/session", {
      method: "DELETE",
      csrfToken,
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    const after = await sessionFetch(cookie, "/api/admin/settings");
    expect(after.status).toBe(401);
  });

  it("rejects logout without a CSRF token", async () => {
    const { cookie } = await adminLogin();
    const response = await sessionFetch(cookie, "/api/admin/session", {
      method: "DELETE",
    });
    expect(response.status).toBe(403);

    const stillSignedIn = await sessionFetch(cookie, "/api/admin/settings");
    expect(stillSignedIn.status).toBe(200);
  });

  it("rejects expired sessions", async () => {
    const { cookie } = await adminLogin();
    const token = cookie.slice("blossomflare_admin=".length);
    const hash = await sha256Hex(new TextEncoder().encode(token));

    await testEnv.DB.prepare(
      "UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?",
    )
      .bind(Math.floor(Date.now() / 1000) - 1, hash)
      .run();

    const response = await sessionFetch(cookie, "/api/admin/settings");
    expect(response.status).toBe(401);
  });

  it("rejects sessions bound to another admin pubkey", async () => {
    const { cookie } = await adminLogin();
    const token = cookie.slice("blossomflare_admin=".length);
    const hash = await sha256Hex(new TextEncoder().encode(token));

    await testEnv.DB.prepare(
      "UPDATE admin_sessions SET admin_pubkey = ? WHERE token_hash = ?",
    )
      .bind("ab".repeat(32), hash)
      .run();

    const response = await sessionFetch(cookie, "/api/admin/settings");
    expect(response.status).toBe(401);
  });

  it("rejects a replayed NIP-98 login token", async () => {
    const url = `${ADMIN_URL}/api/admin/session`;
    const authorization = await nip98Auth(adminSecret(), "POST", url);

    const first = await SELF.fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(first.status).toBe(201);

    const replay = await SELF.fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(replay.status).toBe(401);
  });

  it("does not create a session for a non-admin signature", async () => {
    const user = newUser();
    const url = `${ADMIN_URL}/api/admin/session`;
    const authorization = await nip98Auth(user.secret, "POST", url);
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
