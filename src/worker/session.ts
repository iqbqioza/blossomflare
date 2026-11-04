import { sha256Hex } from "./crypto";
import type { Env } from "./types";

export const ADMIN_SESSION_COOKIE = "blossomflare_admin";
export const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface CreatedAdminSession {
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export interface ActiveAdminSession {
  csrfToken: string;
}

function randomHex(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) === name) {
      return trimmed.slice(separator + 1);
    }
  }
  return null;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export async function createAdminSession(
  env: Env,
  adminPubkey: string,
): Promise<CreatedAdminSession> {
  const token = randomHex();
  const csrfToken = randomHex();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ADMIN_SESSION_TTL_SECONDS;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      `INSERT INTO admin_sessions
         (token_hash, admin_pubkey, csrf_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(await tokenHash(token), adminPubkey, csrfToken, now, expiresAt),
  ]);

  return { token, csrfToken, expiresAt };
}

export async function getAdminSession(
  env: Env,
  request: Request,
  adminPubkey: string,
): Promise<ActiveAdminSession | null> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT csrf_token FROM admin_sessions
     WHERE token_hash = ? AND admin_pubkey = ? AND expires_at > ?`,
  )
    .bind(await tokenHash(token), adminPubkey, Math.floor(Date.now() / 1000))
    .first<{ csrf_token: string }>();

  return row ? { csrfToken: row.csrf_token } : null;
}

export async function deleteAdminSession(
  env: Env,
  request: Request,
): Promise<void> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token || !TOKEN_PATTERN.test(token)) {
    return;
  }

  await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
    .bind(await tokenHash(token))
    .run();
}

export function csrfMatches(provided: string, expected: string): boolean {
  if (provided.length === 0 || provided.length !== expected.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < provided.length; index++) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export function adminSessionCookie(
  request: Request,
  session: CreatedAdminSession,
): string {
  const secure = isSecure(request) ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_SECONDS}${secure}`;
}

export function clearAdminSessionCookie(request: Request): string {
  const secure = isSecure(request) ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}
