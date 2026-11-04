import { verifyEvent, type Event } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import { decodeBase64Url } from "./base64url";
import { sha256Hex } from "./crypto";
import { HttpError } from "./http";
import type { Env } from "./types";

export class AuthError extends HttpError {
  constructor(status: number, reason: string) {
    super(status, reason);
    this.name = "AuthError";
  }
}

const CLOCK_SKEW_SECONDS = 300;
const MAX_AUTH_TOKEN_CHARS = 64 * 1024;

export function getTagValues(event: Event, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

export function isEventShape(value: unknown): value is Event {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    /^[0-9a-f]{64}$/.test(event.id) &&
    typeof event.pubkey === "string" &&
    /^[0-9a-f]{64}$/.test(event.pubkey) &&
    typeof event.sig === "string" &&
    /^[0-9a-f]{128}$/.test(event.sig) &&
    typeof event.created_at === "number" &&
    Number.isInteger(event.created_at) &&
    typeof event.kind === "number" &&
    Number.isInteger(event.kind) &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.every((item) => typeof item === "string"),
    )
  );
}

export async function readAuthEvent(request: Request): Promise<Event> {
  const header = request.headers.get("authorization");
  if (!header) {
    throw new AuthError(401, "missing authorization");
  }

  const match = /^Nostr\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw new AuthError(401, "unsupported authorization scheme");
  }

  let event: unknown;
  try {
    const token = match[1];
    if (token.length > MAX_AUTH_TOKEN_CHARS) {
      throw new Error("token too large");
    }
    const text = new TextDecoder().decode(decodeBase64Url(token));
    event = JSON.parse(text);
  } catch {
    throw new AuthError(401, "invalid authorization token");
  }

  if (!isEventShape(event)) {
    throw new AuthError(401, "invalid authorization event");
  }

  let valid = false;
  try {
    valid = verifyEvent(event);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new AuthError(401, "invalid event signature");
  }

  return event;
}

interface BlossomAuthOptions {
  action: "get" | "upload" | "list" | "delete" | "media";
  hostname: string;
  sha256?: string;
}

export async function verifyBlossomAuth(
  request: Request,
  options: BlossomAuthOptions,
): Promise<Event> {
  const event = await readAuthEvent(request);
  const now = Math.floor(Date.now() / 1000);

  if (event.kind !== 24242) {
    throw new AuthError(401, "authorization event must be kind 24242");
  }
  if (event.created_at > now + CLOCK_SKEW_SECONDS) {
    throw new AuthError(401, "authorization event is from the future");
  }

  const expirations = getTagValues(event, "expiration")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  if (expirations.length === 0 || !expirations.some((value) => value > now)) {
    throw new AuthError(401, "authorization event is expired");
  }

  if (!getTagValues(event, "t").includes(options.action)) {
    throw new AuthError(401, "authorization action does not match");
  }

  const servers = getTagValues(event, "server");
  if (
    servers.length > 0 &&
    !servers.some((server) => server.toLowerCase() === options.hostname.toLowerCase())
  ) {
    throw new AuthError(401, "authorization server does not match");
  }

  if (options.sha256 !== undefined) {
    if (!getTagValues(event, "x").includes(options.sha256.toLowerCase())) {
      throw new AuthError(401, "authorization blob hash does not match");
    }
  }

  return event;
}

export async function verifyAdminRequest(
  request: Request,
  adminPubkey: string,
  body: ArrayBuffer | undefined,
): Promise<Event> {
  const event = await readAuthEvent(request);
  const now = Math.floor(Date.now() / 1000);

  if (event.kind !== 27235) {
    throw new AuthError(401, "admin authorization must be kind 27235");
  }
  if (event.pubkey !== adminPubkey) {
    throw new AuthError(403, "not an administrator");
  }
  if (Math.abs(event.created_at - now) > CLOCK_SKEW_SECONDS) {
    throw new AuthError(401, "admin authorization timestamp is invalid");
  }

  const expirations = getTagValues(event, "expiration")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  if (expirations.length === 0 || !expirations.some((value) => value > now)) {
    throw new AuthError(401, "admin authorization is expired");
  }

  if (!getTagValues(event, "u").includes(request.url)) {
    throw new AuthError(401, "admin authorization URL does not match");
  }

  if (
    !getTagValues(event, "method").some(
      (method) => method.toUpperCase() === request.method.toUpperCase(),
    )
  ) {
    throw new AuthError(401, "admin authorization method does not match");
  }

  if (body !== undefined && body.byteLength > 0) {
    const expected = await sha256Hex(body);
    if (!getTagValues(event, "payload").includes(expected)) {
      throw new AuthError(401, "admin authorization payload does not match");
    }
  }

  return event;
}

export function parseNostrPubkey(input: string): string | null {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }

  if (value.startsWith("npub1")) {
    try {
      const decoded = decode(value);
      if (decoded.type === "npub" && /^[0-9a-f]{64}$/.test(decoded.data)) {
        return decoded.data;
      }
    } catch {
      return null;
    }
  }

  return null;
}

let cachedAdmin: { raw: string; pubkey: string | null } | null = null;

export function getAdminPubkey(env: Env): string | null {
  const raw = (env.ADMIN_NPUB ?? "").trim();
  if (cachedAdmin?.raw === raw) {
    return cachedAdmin.pubkey;
  }

  const pubkey = raw.length > 0 ? parseNostrPubkey(raw) : null;
  cachedAdmin = { raw, pubkey };
  return pubkey;
}
