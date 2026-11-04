const EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "application/octet-stream": ".bin",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".weba",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "text/css": ".css",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/ogg": ".ogv",
  "video/webm": ".webm",
};

const MIME_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export function sanitizeContentType(value: string | null): string {
  if (value === null) {
    return "application/octet-stream";
  }

  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!normalized || !MIME_PATTERN.test(normalized)) {
    return "application/octet-stream";
  }
  return normalized;
}

export function extensionFor(type: string): string {
  return EXTENSIONS[type.toLowerCase()] ?? ".bin";
}

export function isInlineSafe(type: string): boolean {
  return (
    /^image\/(avif|gif|jpeg|png|webp)$/.test(type) ||
    /^video\/(mp4|ogg|webm)$/.test(type) ||
    /^audio\/(mpeg|ogg|wav|webm)$/.test(type)
  );
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function isPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
