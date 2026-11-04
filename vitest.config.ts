import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { defineConfig } from "vitest/config";

const adminSecret = generateSecretKey();
const adminPubkey = getPublicKey(adminSecret);
const migrations = await readD1Migrations("./migrations");

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_NPUB: adminPubkey,
          TEST_ADMIN_SECRET: toHex(adminSecret),
          TEST_MIGRATIONS: migrations,
          MAX_UPLOAD_BYTES: "1048576",
          ENABLE_MIRROR: "true",
          TEST_COORDINATOR_DELAY_MS: "10",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
