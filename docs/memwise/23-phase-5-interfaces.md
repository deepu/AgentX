# 23 · Phase 5 interfaces

The boundaries Phase 5 ([17](17-build-plan.md), "External participants") is built against, in the same spirit as [18](18-kernel-interfaces.md) to [22](22-phase-4-interfaces.md): agreed first, built in parallel, joined at the end. Earlier contracts still hold and change only additively.

| Contract | File |
|---|---|
| Relay tunnel protocol, identity, client | `packages/relay/src/protocol.ts`, `packages/relay/src/client.ts` |
| External links, the public form and inbox-link shapes | `packages/defs/src/external-types.ts` (`@memwise/defs/external`) |
| Definition additions (`StepDef.extract`, provenance) | `packages/defs/src/types.ts`, `contracts.ts` |
| Kernel additions (`kernel.external`, `kernel.channels`) | `packages/runtime/src/types.ts` |
| App API shapes and channels | `packages/shared/src/protocol/memwise.ts`, `channels.ts` |
| Tables | `packages/db/migrations/0005_external.sql` |
| Playbook | `examples/intake/workflows/client-intake/` (version 2) |
| Channel plugins | `examples/plugins/email-smtp/`, `examples/plugins/whatsapp-cloud/` |

**Vocabulary.** People read "link", "form", "client", "send", "relay" ("public address" in the app). Code says external link, participant, channel.

## 1. What changes, in one paragraph

A client is not a user. Staff say who the client is and how to reach them; a **system step sends a single-use, expiring link** to the form by email or WhatsApp (an `outbound` effect, so staff approve the message first). The link opens a **phone-friendly form** that shows only that step's fields, the comments sent back to it, and nothing else of the case. Files dropped in are **read by quarantined extraction**, and fields it is confident about (and whose value is found in the document's text) are pre-filled with a "from pan-card.pdf" badge. The client can leave and come back (a saved draft), and submits once. Because the core usually runs on a laptop, public requests reach it through **our relay**: the core dials out over a WebSocket, the relay forwards scoped requests to it and stores nothing. The same relay carries incoming webhooks, the OAuth callback and shared pages. People can also get their inbox items by email or WhatsApp, with a link that decides that one item.

## 2. The relay (D66)

```
 client's phone ──https──▶ relay (Cloudflare Worker + one Durable Object per install, or `bun relay`)
                              │  WebSocket the core opened (hibernates when idle)
                              ▼
                      core (desktop or server) ── public handler ── kernel.external
```

- **Identity without accounts.** Each install has an Ed25519 key pair (kept by server-core at `~/.memwise/relay/identity.json`, mode 0600). Its **install id** is the lowercase base32 of the first 10 bytes of `sha256(publicKey)`: 16 characters, a valid DNS label. The relay holds no secrets: it checks a signature over its own challenge and that the key hashes to the id.
- **Public addresses.** Subdomain mode `https://<installId>.<relay-domain>/…` (hosted; one origin per install) or path mode `https://<relay>/x/<installId>/…` (self-hosted and local). The relay tells the core its public base URL in `welcome`.
- **Routes the relay forwards** (everything else is refused with 404 before it reaches a core): `GET|POST /f/<token>[/api/…]` forms, `GET|POST /i/<token>[/api/…]` inbox links, `GET|POST /h/<hookId>` webhooks, `GET /assets/…` the form app's files. The relay answers itself: `/connect/<installId>` (the tunnel), `/auth/callback` (OAuth, §8), `/p/api`, `/p/<id>` (shared pages, §8), `/health`.
- **Tunnel protocol** (`packages/relay/src/protocol.ts`, JSON text frames, version 1):
  - relay → core `challenge { nonce }`; core → relay `hello { v: 1, publicKey, sig, client }` where `sig = Ed25519(nonce + ':memwise-relay-v1:' + installId)`; relay → core `welcome { installId, publicUrl }` or `refused { reason }`.
  - relay → core `req { id, method, path, query, headers, body?, more? }` then `req.body { id, chunk, end? }`; core → relay `res { id, status, headers, body?, more? }` then `res.body { id, chunk, end? }`; either side `cancel { id }`. Bodies are base64 in chunks of at most 256 KiB, so frames stay under Cloudflare's 1 MiB.
  - `ping`/`pong` every 30 s (an auto-response on Cloudflare, so a hibernated object answers without waking).
  - A newer connection for the same install replaces the older one (closed with code 4000).
- **Limits at the relay:** request body 25 MiB, response 25 MiB, 60 s per request, 120 requests a minute per client IP per install, 20 concurrent requests per install. Hop-by-hop headers, `cookie` and `cf-*` are not forwarded; `x-memwise-client-ip`, `x-forwarded-host` and `x-forwarded-proto` are set. On the way back `set-cookie` is dropped and `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `x-robots-tag: noindex` are added.
- **Offline.** With no tunnel for the install the relay answers a plain, friendly page (503): "This form isn't available right now. The business's MemWise app is offline; please try again later." Storing submissions while the core is offline is later (open point).
- **Two hosts, one hub.** `packages/relay/src/hub.ts` is runtime-free (it sees sockets and requests through small interfaces). `src/cloudflare/worker.ts` (+ `wrangler.toml`) runs it as a Worker with an `InstallTunnel` Durable Object per install using WebSocket hibernation, R2 for shared pages; `src/bun/serve.ts` runs it self-hosted (`bun packages/relay/src/bun/serve.ts --port 8788 --public-url http://localhost:8788`), pages on disk. Tests run the Bun host, and the Worker under Miniflare.
- **The core side** (`packages/relay/src/client.ts`): `startRelayTunnel({ relayUrl, identity, handle, log }) → RelayTunnel` dials `wss://<relay>/connect/<installId>`, answers the challenge, turns each `req` into a web `Request` for `handle(req) → Response`, streams the answer back, reconnects with backoff (1 s doubling to 60 s), and reports `status(): { state: 'off' | 'connecting' | 'connected' | 'error'; publicUrl?; installId; error? }` with `onStatus`.

## 3. External links (D67)

```yaml
# steps/invite.md: a system step that sends the link
performer: system
tools: { allowed: [external.invite], required: [external.invite] }
map:
  external.invite:
    step: fill                      # literal: the external step the link opens
    name:  case.client_name
    email: case.client_email
    phone: case.client_phone
    via:   case.contact_by          # email | whatsapp
    note:  case.client_message      # optional: what the client is asked to fix
outcomes: [sent]
```

- **`external.invite`** (kernel tool, effect `outbound`, idempotent on its key) issues a link for the named external step of this run and delivers it through the channel `via` names (§6); its preview is the exact message. It needs approval by default; the playbook's policy names who approves (client intake: `staff` or `manager`). Without a public address (no relay and no `MEMWISE_PUBLIC_URL`) it fails with "connect a public address in Settings", and the step goes to a person. Its result: `{ link_id, sent: true, via, expires_at }`.
- **A link** is 32 random bytes, base64url, prefixed `mwl_`; only its sha256 is stored (`mw.external_links`). It belongs to one run and one external step (`run_id`, `step_id`) and opens the step's **current waiting step run**: a link issued before the step is entered (the invite step runs first) works once the run gets there, and one issued for an earlier entry is closed when that entry was answered.
- **Single use.** The first accepted submission consumes it, in the same transaction that queues the outcome; every other open link of that step run is closed (`answered`). Leaving the state any other way (timeout, stop) closes them too (`closed`). Opening the page never consumes it, so mail scanners that fetch links do no harm.
- **Expiry.** `expires_in` argument, else the state's `timeout`, else 7 days; at most 30 days.
- **Revocable** by staff (`revoked`); **re-sendable** (`kernel.external.resend`), which delivers the same link again after the person confirms the preview (recorded as their approval).
- **Scope.** The page shows only: the step's title and instructions, its writes (as fields, with current case values as defaults), the comments returned to this step (`returnedComments`) and the link's `note`, and the business's display name (`domain/roles.yaml` has none; `MEMWISE_BUSINESS_NAME`, else the owner's name). Never other case fields, the case id, people's names other than the comment author's first name, or other files.
- **Drafts.** `PUT …/api/draft` stores the values typed so far on the link (`draft jsonb`, `draft_saved_at`); reopening restores them. Staff see "the client saved a draft at 10:42" on the case.
- **Who answered.** A submission through a link is recorded as `decided_by = 'external:<linkId>'`; its values get the new provenance `{ kind: 'external', at, by: <participant label>, linkId, stepRunId, tainted: true }`. **External input is untrusted**: every value from it is tainted (D21), so a later agent step reading it is a tainted session and its outbound effects need approval.
- **Staff can still fill it in** for the client (`assignee: staff`), as before. The inbox lists an external step for its assignee only while it has **no open link**; while one is open the case says "waiting on Asha (link sent 10:42, opened 10:50)".
- **Inbox links** (§6) use the same table with `kind = 'inbox'`, a person and one inbox item.
- **Rate limits in the core** (beside the relay's): per link 60 requests a minute, 20 uploads, 10 extraction calls an hour, 20 submission attempts an hour. Uploads: at most 15 MiB each, of type PDF, JPEG, PNG, HEIC/HEIF, WebP or plain text (checked by content, not name).

## 4. The public form (D67)

Served by the core's **public handler** (`packages/server-core/src/memwise/public/`), a fetch-style `(Request) → Response` used by the relay tunnel, by a direct listener in server mode (`MEMWISE_PUBLIC_PORT`, with `MEMWISE_PUBLIC_URL`), and by tests. The page is a small separate app (`apps/external-form/`, Vite, React, no app shell), built to `apps/external-form/dist` and served at `<base>/assets/form/`. Shapes are in `@memwise/defs/external`.

| Request | Answer |
|---|---|
| `GET /f/<token>` | The app's HTML shell (no data in it), `cache-control: no-store`, strict CSP (`default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'`) |
| `GET /f/<token>/api/form` | `ExternalForm` (status `open`, or why not: `expired`, `used`, `closed`, `revoked`, `unknown`, with a plain message) |
| `PUT /f/<token>/api/draft` | `{ values }` → `{ savedAt }` |
| `POST /f/<token>/api/files?name=<name>` | raw bytes (`content-type` the file's) → `{ document: ExternalDocument }` |
| `POST /f/<token>/api/extract` | `{ documents: string[] }` (file ids) → `ExtractResult` |
| `POST /f/<token>/api/submit` | `{ outcome?, values, sources? }` → `ExternalSubmitResult` |
| `GET /i/<token>` and `/i/<token>/api/item`, `POST /i/<token>/api/decide` | inbox links (§6) |
| `POST /h/<hookId>` (and `GET` for verification handshakes) | webhooks (§7) |

Fields are described by the core (`ExternalFormField`: `kind` text, longtext, email, phone, identifier, number, money, date, boolean, enum, document, documents; `label`, `required`, `pattern`, `placeholder`, `options`, `currency`, `value`, `source`), so the page never parses value types. The form is mobile first: one column, large targets, the native file picker with the camera allowed, progress on uploads, autosave of drafts, and plain messages for every refusal. It must work at 360 px wide, in light and dark.

## 5. Extraction in the form (D68)

```yaml
# steps/fill.md
performer: external
assignee: staff
extract:
  tool: intake.extract_fields       # a read (quarantined) tool the form may call while the step waits
  documents: documents              # the List<Document> write whose files it reads
  fields: [pan, gstin, client_name] # writes it may fill; a result `legal_name` maps with `as:` (below)
  min_confidence: 0.8               # default 0.8
```

- **A component action.** While an external or person step waits, its form may call only the tool its `extract:` names, and only if that tool is `read` in the step's effective policy (checked: `extract-tool-not-read`). It runs through the tool gateway under a **component token** for the waiting step run (`agentRole: <workflow>.<step>.form`, `onBehalfOf: external:<linkId>` or the person), with its own rate limit, and each call is journaled on the step run (`kind: 'tool'`, journal key `form.extract:<n>`), so the step record shows what the client's files said.
- **Results with confidence.** `intake.extract_fields` now returns `{ fields: [{ name, value, document, confidence?, quote? }] }`; the quarantined reader asks for `{ value, confidence, quote }` per field. Stub results without `confidence` count as 0.5.
- **Grounding.** The kernel checks each value against the document's text (normalised: case, spaces and punctuation ignored for identifiers); a value not found there has its confidence capped at 0.5 and `found: false`. So a model that invents a value can't get it pre-filled.
- **Prefill.** A suggestion at or above `min_confidence` (and found) is pre-filled, shown with a badge "from pan-card.pdf"; one below is offered as "Found in pan-card.pdf: AAACA1234A · Use". The client may change any of them.
- **Provenance on submit.** The form sends `sources: { <field>: <suggestionId> }` for values taken from a suggestion. The kernel keeps the source only when the submitted value deep-equals the recorded suggestion: then provenance is `{ kind: 'tool', tool, callId, stepRunId, tainted: true, document, confidence, confirmedBy }`; a changed value is the participant's (`external` or `person`).
- **Inside the app** the same extraction is offered when staff fill the form (`memwise:external:extract`), with the same badges, and the case view shows the confidence and document on a tool value.

## 6. Channels (D69)

- **Channel tools are plugin tools with fixed names**: `email.send { to, subject, body, html? }` and `whatsapp.send { to, body?, template?: { name, language, params } }`, both `outbound` and idempotent on the key. `external.invite`, reminders and notifications call whichever is bound, through the gateway (ledger, idempotency, secrets). Phase 4's sample email (a sandbox outbox) still provides `email.send`; Phase 5 adds two real ones:
  - `examples/plugins/email-smtp/`: SMTP with STARTTLS/TLS and auth from secrets (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`), the idempotency key as the `Message-ID` seed and `X-MemWise-Idempotency-Key`. Tested against a local SMTP sink.
  - `examples/plugins/whatsapp-cloud/`: the WhatsApp Business Cloud API (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_BASE` for tests). Business-initiated messages need an approved template; the invite uses template `memwise_form_link` (params: name, business, link) when `WHATSAPP_INVITE_TEMPLATE` is set, else plain text (valid only inside the 24-hour window). Tested against a local fake of the Graph API.
- **Messages are templates, not prose from a model**, in plain words: who is asking, what for, the link, when it expires, and the note. `external.invite` builds them; its preview shows the exact text.
- **Inbox items by channel.** A person may turn on notifications (`mw.people.notify`: `{ email?: boolean, whatsapp?: string /* E.164 */ }`; off by default). When a new input, decision, approval or attention item appears for one of their roles, the kernel sends them one message per item (`mw.deliveries`, unique per item, person and channel), with an **inbox link** (`kind = 'inbox'`, that person, that item, single use, 72 h). The link page shows the item's title, the fields its step reads (as the person may see them) and, for decision items and effect approvals, the buttons (approve, send back with a comment; approve or reject an email, with its preview). Deciding takes a confirming POST and is recorded as that person, "via email link". Items that need typed values open "Open in MemWise" instead. These notifications are the kernel's own fixed templates to signed-up people who opted in, so they are not step effects and need no approval.
- **Reminders.** A `remind` timer on an external step still reminds the assignee role in the inbox, with "Send a reminder" (`kernel.external.resend`).

## 7. Webhooks

`mw.webhooks` (id, purpose, plugin, secret sha256, verify scheme) and `mw.inbound_events` (hook, received_at, verified, headers kept, body). `POST /h/<hookId>` verifies the request by the hook's scheme (`hmac-sha256` over the body in `x-memwise-signature: sha256=<hex>`, or `meta` for WhatsApp's `x-hub-signature-256` plus the `hub.challenge` handshake on GET), stores it, answers 200 quickly, and notifies in-process handlers (`kernel.channels.onInbound`). WhatsApp delivery statuses update `mw.deliveries`. Starting cases from incoming messages is Phase 6 (D76); Phase 5 only receives, verifies and records.

## 8. OAuth callback and shared pages at the relay

- **OAuth.** `GET /auth/callback?code&state` accepts the existing `ca1.` state envelope (`packages/shared/src/auth/oauth-relay.ts`), checks `returnTo` is a loopback address (`http://localhost:<port>/…`, `http://127.0.0.1:<port>/…`) or the app's own scheme, and redirects there with `code`, the inner `state`, and any `error`. Nothing is stored. `MEMWISE_OAUTH_RELAY_URL` points the app at it; the default stays Craft's until our relay is deployed and OAuth apps are registered with its address (open point).
- **Shared pages.** `/p/api` implements the page-share API `packages/shared/src/pages/publisher.ts` speaks (publish, republish, password, unpublish, with the admin token minted by the relay and stored only as sha256), and `/p/<id>` serves the published bundle. `MEMWISE_PAGES_SHARE_API_URL=<relay>/p/api` turns it on (page sharing stays opt-in, D40).

## 9. Kernel API additions (`@memwise/runtime`)

```ts
interface KernelPhase5 {
  readonly external: ExternalService;   // links, the public form, inbox links
  readonly channels: ChannelService;    // deliveries, people's notification settings, webhooks
}
```

The types are in `packages/runtime/src/types.ts` and `@memwise/defs/external`. The kernel takes two new options: `publicUrl: () => string | undefined` (the relay's public base, or the server's own) and `businessName?: string`.

## 10. Playbook: client intake, version 2

```yaml
start: prepare
steps:
  prepare:                      # staff say who the client is and how to reach them
    on: { send_link: invite, fill_for_client: fill }
  invite:                       # the client gets a link to the form
    on: { sent: fill }
  fill:                         # the client fills in the form (or staff do, for them)
    on: { submitted: check }
    wait: { remind: 3d, timeout: 7d → needs_person }
  check:
    on: { checked: verify, needs_info: invite, failed: needs_person, needs_person: needs_person }
  verify:
    on: { approved: onboard, sent_back: invite }
    wait: { remind: 1d, timeout: 3d → needs_person }
  onboard: { on: { done: end } }
  needs_person:
    on: { resolved: check, resend: invite }
    assignee: manager
    wait: { timeout: 7d → end }
```

New case fields `client_phone: Phone`, `contact_by: Enum[email, whatsapp]`, `client_message: Text`. The check step no longer emails the client: it writes `client_message` and finishes `needs_info`, and the invite sends a new link with that note. A send-back sends a new link with the manager's comment shown on the form. The plugin copy in `examples/plugins/client-intake/` stays at its Phase 4 shape (open point).

## 11. App screens

- **Case view:** a "Client link" panel on an external step: sent by which channel and when, opened, draft saved, submitted, expired; Copy link, Send again, Revoke. Tool values from documents show their confidence and document.
- **Fill form (staff):** a "Read the documents" action after upload, with the same badges and suggestions.
- **Inbox:** an effect approval for an invite shows the message preview with the recipient; external steps waiting on a client are not inbox items.
- **Settings → Public address:** the relay URL (default `MEMWISE_RELAY_URL`, else off), on/off, state, the public address and install id; people's notification settings.

## 12. Exit test

`packages/server-core/src/memwise/__tests__/phase5-exit.test.ts`, against a real Postgres with scripted models, a Bun relay on a local port, the core connected to it through the tunnel, a local SMTP sink and the email-smtp plugin bound: staff prepare an intake for Asha Rao, approve the invite email, and the email arrives in the sink with a link through the relay. A browser at phone size (Playwright, 390×844) opens the link, uploads a PAN card and a GST certificate, sees the PAN and GSTIN pre-filled "from pan-card.pdf", saves a draft, comes back, and submits. The check runs on tainted input; the manager sends it back with a comment; a second link arrives, the old one says "already used"; the client sees the comment, fixes and submits; the manager approves (from an inbox link in an email), onboard writes `Customer`. A link that expired, a revoked link and the relay with the core offline each give their plain page. Screenshots of the phone screens go to the walkthrough.

## 13. As built: where the code differs from this contract

- **Tokens.** A link's token is an HMAC of its idempotency key under a kernel key (`mw.kernel_keys`), so a retried `external.invite` issues the same link; only the token's sha256 is stored.
- **Invite.** When the participant has no address for the chosen channel, `external.invite` stops for a person (`needs_person`) rather than failing the step; `prepare` keeps its timeout.
- **Forwarding.** The relay also forwards `PUT` (drafts) and `HEAD`; the OAuth callback only returns to origins listed in `oauthReturnOrigins`.
- **Values sent back unchanged.** A value the client sends exactly as the case already has it (the form shows it to them) keeps its provenance; only what the client changed or added is `external`. A saved draft value that still matches a suggestion keeps that suggestion as its source.
- **Form app build.** `apps/external-form` writes its files under `dist/assets/form/` and points at `../assets/form/<file>`; the core serves `/assets/form/<file>` from there.
- **Scripted mode.** The stand-in `intake.extract_fields` reads documents by name or file id and returns what the scripted example's tool stub says, so the form's extraction works in demos.

