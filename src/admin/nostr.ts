import { decode, npubEncode } from "nostr-tools/nip19";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent>;
}

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export function hasNip07(): boolean {
  return typeof window !== "undefined" && window.nostr !== undefined;
}

export async function signWithNip07(
  kind: number,
  tags: string[][],
  content: string,
): Promise<NostrEvent> {
  const provider = window.nostr;
  if (!provider) {
    throw new Error("NIP-07 対応のブラウザ拡張が見つかりません");
  }
  return provider.signEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });
}

export async function nip98Header(
  method: string,
  url: string,
  body?: string | Uint8Array | null,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["expiration", String(now + 60)],
  ];

  if (body !== undefined && body !== null) {
    const bytes = typeof body === "string"
      ? new TextEncoder().encode(body)
      : body;
    tags.push(["payload", await sha256Hex(bytes)]);
  }

  const event = await signWithNip07(27235, tags, "");
  return `Nostr ${base64Url(new TextEncoder().encode(JSON.stringify(event)))}`;
}

export async function blossomAuthHeader(
  action: "upload" | "delete",
  sha256: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const content = action === "upload" ? "Upload Blob" : "Delete Blob";
  const event = await signWithNip07(
    24242,
    [
      ["t", action],
      ["x", sha256],
      ["server", location.hostname],
      ["expiration", String(now + 300)],
    ],
    content,
  );
  return `Nostr ${base64Url(new TextEncoder().encode(JSON.stringify(event)))}`;
}

export async function sha256Hex(
  data: ArrayBuffer | Uint8Array,
): Promise<string> {
  const source = data instanceof Uint8Array
    ? new Uint8Array(data).buffer
    : data;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parsePubkeyInput(
  input: string,
): { hex: string } | { error: string } {
  const value = input.trim();
  if (value.length === 0) {
    return { error: "npub または hex を入力してください" };
  }
  if (value.startsWith("nsec1")) {
    return { error: "秘密鍵（nsec）は入力しないでください" };
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return { hex: value.toLowerCase() };
  }
  if (!value.startsWith("npub1")) {
    return { error: "npub1... または64桁の hex を入力してください" };
  }

  try {
    const decoded = decode(value);
    if (decoded.type === "npub" && /^[0-9a-f]{64}$/.test(decoded.data)) {
      return { hex: decoded.data };
    }
  } catch {
    // fall through
  }

  return { error: "npub の形式が正しくありません" };
}

export function encodeNpub(hex: string): string {
  try {
    return npubEncode(hex);
  } catch {
    return hex;
  }
}

export function shortHex(value: string, length = 12): string {
  return value.length <= length * 2
    ? value
    : `${value.slice(0, length)}…${value.slice(-length)}`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("ja-JP");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
