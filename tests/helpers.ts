import { env, SELF } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools/pure";
import { fromHex, sha256Hex } from "../src/worker/crypto";
import type { Env } from "../src/worker/types";

export interface TestEnv extends Env {
  TEST_ADMIN_SECRET: string;
  TEST_MIGRATIONS: D1Migration[];
}

export const testEnv = env as unknown as TestEnv;
export const ADMIN_URL = "https://example.com";

export function adminSecret(): Uint8Array {
  return fromHex(testEnv.TEST_ADMIN_SECRET);
}

export function adminPubkey(): string {
  return getPublicKey(adminSecret());
}

export function newUser(): { secret: Uint8Array; pubkey: string } {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function authHeader(event: Event): string {
  return `Nostr ${encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))}`;
}

interface BlossomTokenOptions {
  action?: "upload" | "delete";
  hash?: string;
  hostname?: string;
  content?: string;
  expirationOffset?: number;
  createdAtOffset?: number;
}

export function blossomAuth(
  secret: Uint8Array,
  options: BlossomTokenOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", options.action ?? "upload"],
    ["expiration", String(now + (options.expirationOffset ?? 300))],
  ];
  if (options.hash !== undefined) {
    tags.push(["x", options.hash]);
  }
  tags.push(["server", options.hostname ?? "example.com"]);

  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now + (options.createdAtOffset ?? 0),
      tags,
      content: options.content ?? "Upload Blob",
    },
    secret,
  );
  return authHeader(event);
}

interface Nip98Options {
  includeExpiration?: boolean;
  standardBase64?: boolean;
}

export async function nip98Auth(
  secret: Uint8Array,
  method: string,
  url: string,
  body?: string | Uint8Array,
  options: Nip98Options = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (options.includeExpiration !== false) {
    tags.push(["expiration", String(now + 60)]);
  }

  if (body !== undefined) {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body;
    tags.push(["payload", await sha256Hex(bytes)]);
  }

  const event = finalizeEvent(
    { kind: 27235, created_at: now, tags, content: "" },
    secret,
  );
  const encoded = new TextEncoder().encode(JSON.stringify(event));
  return `Nostr ${
    options.standardBase64 === true
      ? encodeBase64(encoded)
      : encodeBase64Url(encoded)
  }`;
}

export async function adminFetch(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const url = `${ADMIN_URL}${path}`;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const authorization = await nip98Auth(adminSecret(), method, url, text);
  return SELF.fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(text === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(text === undefined ? {} : { body: text }),
  });
}

export async function resetDb(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM blobs"),
    testEnv.DB.prepare("DELETE FROM blob_tombstones"),
    testEnv.DB.prepare("DELETE FROM reports"),
    testEnv.DB.prepare("DELETE FROM upload_allowlist"),
    testEnv.DB.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('upload_policy', 'allowlist', ?)",
    ).bind(Math.floor(Date.now() / 1000)),
  ]);

  const objects = await testEnv.BLOBS.list();
  await Promise.all(objects.objects.map((object) => testEnv.BLOBS.delete(object.key)));
}

export async function allowUploader(pubkey: string): Promise<void> {
  await testEnv.DB.prepare(
    "INSERT OR REPLACE INTO upload_allowlist (pubkey, added_at, added_by) VALUES (?, ?, ?)",
  )
    .bind(pubkey, Math.floor(Date.now() / 1000), adminPubkey())
    .run();
}

export async function setPolicy(
  policy: "open" | "allowlist",
): Promise<void> {
  await testEnv.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('upload_policy', ?, ?)",
  )
    .bind(policy, Math.floor(Date.now() / 1000))
    .run();
}

export async function uploadAs(
  secret: Uint8Array,
  data: Uint8Array,
  options: {
    contentType?: string;
    hash?: string;
    hostname?: string;
  } = {},
): Promise<{ response: Response; sha256: string }> {
  const sha256 = options.hash ?? await sha256Hex(data);
  const authorization = blossomAuth(secret, {
    action: "upload",
    hash: sha256,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
  });

  const response = await SELF.fetch(`${ADMIN_URL}/upload`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": options.contentType ?? "image/png",
      "X-SHA-256": sha256,
    },
    body: data,
  });

  return { response, sha256 };
}

export async function deleteAs(
  secret: Uint8Array,
  sha256: string,
): Promise<Response> {
  const authorization = blossomAuth(secret, { action: "delete", hash: sha256 });
  return SELF.fetch(`${ADMIN_URL}/${sha256}`, {
    method: "DELETE",
    headers: { Authorization: authorization },
  });
}

export const pngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
