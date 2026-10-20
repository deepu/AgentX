# MemWise relay

The relay gives a MemWise core that runs on a laptop a public address. The core dials out
to the relay over a WebSocket; the relay forwards only the public routes (client forms
`/f/`, inbox links `/i/`, webhooks `/h/` and the form's files `/assets/`) and answers the
OAuth callback (`/auth/callback`) and shared pages (`/p/`) itself. It stores nothing for
forwarded requests and needs no accounts: an install is named by its own key. When the core
is offline, people see a plain "this form isn't available right now" page.

See `docs/memwise/23-phase-5-interfaces.md` §2 and §8 for the design.

| File | What it is |
|---|---|
| `src/protocol.ts` | The tunnel protocol (the contract) |
| `src/protocol-impl.ts` | Install identity, signatures, base64 and chunking |
| `src/hub.ts` | The relay's logic, shared by both hosts (runtime-free) |
| `src/oauth.ts`, `src/pages.ts` | The OAuth callback and shared pages |
| `src/client.ts` | The core's side: `startRelayTunnel` |
| `src/identity-file.ts` | `loadOrCreateIdentity(file)` (Node fs) |
| `src/bun/serve.ts` | The self-hosted relay on Bun |
| `src/cloudflare/worker.ts` | The Worker and the `InstallTunnel` Durable Object |

## Run it yourself (Bun)

```bash
bun packages/relay/src/bun/serve.ts --port 8788 --public-url http://localhost:8788 --pages-dir ./relay-pages
```

Installs are then at `http://localhost:8788/x/<installId>/…` (path mode). With a wildcard
DNS name in front, `--base-domain relay.example.com --public-url https://relay.example.com`
puts each install on its own origin, `https://<installId>.relay.example.com`. Behind a
reverse proxy that sets `x-forwarded-for`, add `--trust-forwarded-for` so rate limits see the
real client. `--help` lists the options.

## Deploy to Cloudflare

1. Pick the domain. Subdomain mode needs a wildcard: a proxied DNS record for
   `relay.example.com` and one for `*.relay.example.com` (any target; the Worker answers).
2. Edit `wrangler.toml`: `PUBLIC_URL`, `BASE_DOMAIN`, the two `routes` and `zone_name`, and
   the R2 bucket name. Leave `BASE_DOMAIN` empty for path mode on a single host name.
3. Create the bucket for shared pages: `npx wrangler r2 bucket create memwise-relay-pages`
   (or remove the `[[r2_buckets]]` block to turn shared pages off).
4. From `packages/relay`: `npx wrangler deploy`. The first deploy creates the
   `InstallTunnel` Durable Object class (migration `v1`).
5. Check it: `curl https://relay.example.com/health` answers `{"ok":true,…}`.

Point the app at it with `MEMWISE_RELAY_URL=https://relay.example.com` (the tunnel),
`MEMWISE_OAUTH_RELAY_URL=https://relay.example.com/auth/callback` (OAuth, once the OAuth
apps list that redirect address) and `MEMWISE_PAGES_SHARE_API_URL=https://relay.example.com/p/api`
(shared pages).

Notes:

- A WebSocket message on Cloudflare is at most 1 MiB. Bodies travel in base64 chunks of
  256 KiB, so frames stay well under it.
- The Durable Object uses WebSocket hibernation: an idle tunnel costs nothing, and the
  core's pings are answered by the runtime (`setWebSocketAutoResponse`) without waking it.
  Requests in flight are held in memory while it is awake.
- Rate limits (120 requests a minute per client address per install) are counted in the
  Durable Object's memory, so they start over when it hibernates.

## Tests

```bash
cd packages/relay && bun test
```

The tests run the Bun host with a real tunnel client, and the Worker under Miniflare
(`tests/worker.miniflare.test.ts`; it skips with the reason when workerd can't run).
