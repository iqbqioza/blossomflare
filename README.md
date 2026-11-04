# Blossomflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iqbqioza/blossomflare)

A [Blossom](https://github.com/hzrd149/blossom) server for Nostr, running on Cloudflare Workers, R2, and D1. The admin panel lets you upload and delete blobs, review reports, and manage which npubs are allowed to upload.

## One-click deployment

Click the **Deploy to Cloudflare** button above. Cloudflare will:

1. Clone this repository into your GitHub account
2. Configure the Worker name and the D1 / R2 resource names
3. Create and bind a D1 database and an R2 bucket automatically
4. Set up Workers Builds and run the build, D1 migrations, and deployment

During deployment you will be asked for the **admin npub** (or a 64-character hex pubkey). This corresponds to the `ADMIN_NPUB` secret defined in `.dev.vars.example`.

> **R2 must be enabled.** If you have not enabled R2 in your Cloudflare account yet, enable it from the dashboard first. The free tier may still require billing information.

### After deployment

1. Open the deployed URL (`https://<worker-name>.<subdomain>.workers.dev/`)
2. Sign in with a NIP-07 browser extension such as Alby
3. Open the **Upload permissions** tab and review the policy
   - The initial policy is **allowlist only**
   - The administrator can always upload, regardless of policy
4. Add npubs to the allowlist, or switch to **All Nostr users**

## Architecture

```text
Workers (Static Assets + API)
├─ /<sha256>(.ext)   Blob retrieval (R2)
├─ /upload           BUD-02 upload
├─ /mirror           BUD-04 mirror
├─ /report           BUD-09 report
├─ /list/<pubkey>    BUD-12 listing
├─ /media            BUD-05 (not supported: 501)
├─ /api/admin/*      Admin API (NIP-98)
└─ /                 Admin SPA
```

- **D1**: blob metadata, reports, upload allowlist, and settings
- **R2**: blob contents, keyed by SHA-256
- **Admin panel**: React + TailwindCSS. Requests are signed with NIP-07; private keys never leave the browser extension.

## Local development

Requirements:

- Node.js 22 or later
- pnpm 12
- A NIP-07 browser extension (for the admin panel)

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Set ADMIN_NPUB in .dev.vars to your npub
pnpm db:migrate:local
pnpm build
pnpm dev
```

`pnpm dev` starts the Worker at `http://localhost:8787`. D1 and R2 use local Miniflare storage.

Tests:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm exec wrangler deploy --dry-run
```

## Configuration

### Secrets

| Name | Required | Description |
|---|---|---|
| `ADMIN_NPUB` | Yes | npub or 64-character hex pubkey of the administrator allowed to sign in to the admin panel |

For production, set it with `wrangler secret put ADMIN_NPUB`. Do not put it directly in `wrangler.jsonc`.

### Environment variables

| Name | Default | Description |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `10485760` (10 MiB) | Maximum size of a single upload |
| `ENABLE_MIRROR` | `true` | Whether to enable BUD-04 `/mirror` |

## Upload permissions

By default, **only the administrator configured in `ADMIN_NPUB`** can upload.

The **Upload permissions** tab in the admin panel lets you:

- Switch between **Allowlisted npubs only** and **All Nostr users**
- Add or remove npubs (or hex pubkeys) from the allowlist

The policy applies to:

- `PUT /upload`
- `HEAD /upload`
- `PUT /mirror`

Removing an npub from the allowlist does not delete blobs that user has already uploaded. Delete them individually from the Blob list if needed.

## Supported BUDs

| BUD | Feature | Status |
|---|---|---|
| BUD-01 | Blob retrieval, HEAD, Range, CORS | Supported |
| BUD-02 | `PUT /upload` | Supported |
| BUD-03 | User server list | Client-side convention (no server endpoint) |
| BUD-04 | `PUT /mirror` | Supported |
| BUD-05 | Media optimization | **Not supported (501)** |
| BUD-06 | `HEAD /upload` | Supported |
| BUD-07 | Payment required | **Not supported** |
| BUD-08 | Nostr file metadata tags | Client-side convention (no server endpoint) |
| BUD-09 | `PUT /report` | Supported |
| BUD-10 | Blossom URI schema | Client-side convention (no server endpoint) |
| BUD-11 | Kind 24242 authorization | Supported |
| BUD-12 | Listing and deletion | Supported |

## Security

- Upload, delete, and mirror requests are authenticated with BUD-11 kind 24242 tokens
- Every admin API request is verified with NIP-98 (kind 27235)
- The admin panel uses no cookies; it relies entirely on signed requests
- Blob responses include `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
- HTML, SVG, and other non-media files are served as attachments to reduce same-origin XSS risk in the admin panel
- `/mirror` only accepts HTTPS and rejects localhost, private IPs, metadata IPs, and unsafe redirects
- All D1 access uses prepared statements

### Limitations

- BUD-05 (media optimization) and BUD-07 (payments) are not implemented
- There is no per-user storage quota
- The maximum upload size is capped at 25 MiB to stay within Worker memory limits
- BUD-11 authorization tokens have a maximum lifetime of one hour; delete tokens are single-use
- Reports are limited to 20 per pubkey per hour and must reference existing blobs
- BUD-12 cursors that point to a deleted blob remain usable for seven days
- Preview deployments intentionally have no production D1/R2 bindings; configure separate preview resources to use the API
- `/list/<pubkey>` is implemented for administrative use, although BUD-12 marks it as unrecommended
- The admin panel is intended for desktop browsers with a NIP-07 extension

## Manual deployment

To deploy without the Deploy button:

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 create blossomflare-db
pnpm exec wrangler r2 bucket create blossomflare-blobs
# Set the displayed database_id in wrangler.jsonc
pnpm exec wrangler secret put ADMIN_NPUB
pnpm build
pnpm run deploy
```

`pnpm run deploy` applies migrations to the remote D1 database before running `wrangler deploy`.

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this work by you, as defined in the Apache-2.0 license, shall
be dual licensed as above, without any additional terms or conditions.
