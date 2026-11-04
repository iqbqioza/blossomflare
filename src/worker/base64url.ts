const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function decodeBase64Url(value: string): Uint8Array {
  if (value.length === 0 || value.length > 64 * 1024) {
    throw new Error("invalid base64url length");
  }
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error("invalid base64url characters");
  }

  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
