import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { sha256Hex } from "../src/worker/crypto";
import {
  ADMIN_URL,
  adminSecret,
  allowUploader,
  blossomAuth,
  newUser,
  pngBytes,
  resetDb,
} from "./helpers";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = handler as typeof fetch;
}

function mirrorRequest(
  secret: Uint8Array,
  url: string,
  hash: string,
): Promise<Response> {
  return SELF.fetch(`${ADMIN_URL}/mirror`, {
    method: "PUT",
    headers: {
      Authorization: blossomAuth(secret, { action: "upload", hash }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
}

describe("mirror", () => {
  it("mirrors a blob and verifies its hash", async () => {
    stubFetch(async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );

    const hash = await sha256Hex(pngBytes);
    const response = await mirrorRequest(
      adminSecret(),
      "https://cdn.example.com/image.png",
      hash,
    );

    expect(response.status).toBe(201);
    const descriptor = (await response.json()) as { sha256: string };
    expect(descriptor.sha256).toBe(hash);

    const fetched = await SELF.fetch(`${ADMIN_URL}/${hash}`);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(pngBytes);
  });

  it("rejects a hash mismatch", async () => {
    stubFetch(async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );

    const response = await mirrorRequest(
      adminSecret(),
      "https://cdn.example.com/image.png",
      "00".repeat(32),
    );
    expect(response.status).toBe(409);
  });

  it("rejects unlisted uploaders", async () => {
    const user = newUser();
    const hash = await sha256Hex(pngBytes);
    const response = await mirrorRequest(
      user.secret,
      "https://cdn.example.com/image.png",
      hash,
    );
    expect(response.status).toBe(403);
  });

  it("requires an x tag before making an outbound request", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return new Response(pngBytes, { status: 200 });
    });

    const response = await SELF.fetch(`${ADMIN_URL}/mirror`, {
      method: "PUT",
      headers: {
        Authorization: blossomAuth(adminSecret(), { action: "upload" }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://cdn.example.com/image.png" }),
    });

    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("rejects a null mirror body with 400", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return new Response(pngBytes, { status: 200 });
    });

    const response = await SELF.fetch(`${ADMIN_URL}/mirror`, {
      method: "PUT",
      headers: {
        Authorization: blossomAuth(adminSecret(), {
          action: "upload",
          hash: await sha256Hex(pngBytes),
        }),
        "Content-Type": "application/json",
      },
      body: "null",
    });

    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("allows an allowlisted uploader", async () => {
    const user = newUser();
    await allowUploader(user.pubkey);
    stubFetch(async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      })
    );

    const hash = await sha256Hex(pngBytes);
    const response = await mirrorRequest(
      user.secret,
      "https://cdn.example.com/image.png",
      hash,
    );
    expect(response.status).toBe(201);
  });

  it.each([
    "http://example.com/image.png",
    "https://localhost/image.png",
    "https://localhost./image.png",
    "https://127.0.0.1/image.png",
    "https://127.0.0.1./image.png",
    "https://0177.0.0.1/image.png",
    "https://2130706433/image.png",
    "https://[::1]/image.png",
    "https://[::7f00:1]/image.png",
    "https://[64:ff9b::7f00:1]/image.png",
    "https://[2002:7f00:1::]/image.png",
    "https://[fec0::1]/image.png",
    "https://[ff02::1]/image.png",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal./latest/meta-data",
    "https://user:pass@example.com/image.png",
  ])("blocks unsafe mirror URL %s", async (url) => {
    stubFetch(async () => {
      throw new Error("outbound fetch must not happen");
    });

    const response = await mirrorRequest(
      adminSecret(),
      url,
      await sha256Hex(pngBytes),
    );
    expect(response.status).toBe(400);
  });

  it("blocks a redirect to a private address", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/secret" },
      });
    });

    const response = await mirrorRequest(
      adminSecret(),
      "https://cdn.example.com/image.png",
      await sha256Hex(pngBytes),
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it("returns 502 when the origin fails", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));

    const response = await mirrorRequest(
      adminSecret(),
      "https://cdn.example.com/image.png",
      await sha256Hex(pngBytes),
    );
    expect(response.status).toBe(502);
  });

  it("rejects a blob larger than the server limit", async () => {
    const large = new Uint8Array(1024 * 1024 + 1);
    stubFetch(async () =>
      new Response(large, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      })
    );

    const response = await mirrorRequest(
      adminSecret(),
      "https://cdn.example.com/large.bin",
      await sha256Hex(large),
    );
    expect(response.status).toBe(413);
  });
});
