export function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(
  data: ArrayBuffer | Uint8Array,
): Promise<string> {
  const source = data instanceof Uint8Array
    ? new Uint8Array(data).buffer
    : data;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return toHex(new Uint8Array(digest));
}
