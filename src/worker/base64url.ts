const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBinary(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (value.length === 0 || value.length > 64 * 1024) {
    throw new Error("invalid base64url length");
  }
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error("invalid base64url characters");
  }

  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return decodeBinary(padded);
}

export function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length > 64 * 1024) {
    throw new Error("invalid base64 length");
  }
  if (!BASE64_PATTERN.test(value)) {
    throw new Error("invalid base64 characters");
  }
  return decodeBinary(value);
}
