# 12 · State and packaging

Supabase showed that packaging the right things together around Postgres makes a platform easy to adopt. MemWise takes that lesson for the state plane and the packaging, not for the architecture as a whole: the centre is the agent runtime ([03](03-architecture.md)).

## 1. Postgres, used opinionatedly *(Decided)*

Postgres is the one required service, and we lean into its features instead of hiding it behind a database-agnostic wrapper. There is no dependency on Supabase; we build our own packaging.

| Postgres holds | Using |
|---|---|
| Domain rows (generated tables per entity type), cases, runs, step records | Plain tables with typed references |
| The definitions index (name, version, references) | Tables rebuilt from the project folder |
| The DBOS journal, queues and timers | DBOS's own schema |
| Policies as enforcement | Row-level security and column policies, compiled from policy files |
| Identity: people, roles, participants, sessions | Our tables; step tokens checked by RLS |
| The event log | Append-only table; `LISTEN/NOTIFY` for live updates to the UI |
| Traces and metering | Tables, partitioned by time |

Search over cases and step records (for recall tools) starts with Postgres full-text search; `pgvector` is an option where similarity is needed (open, see [16](16-open-questions.md)).

## 2. Object store

Files, workspaces, chat transcripts and large artifacts. One interface: **local disk on desktop, S3-compatible** on servers. Rows reference objects; objects never hold the system of record.

## 3. One binary, three modes *(Decided)*

```
memwise standalone   # desktop: app + host + bundled Postgres + local object store
memwise server       # self-hosted: host and API, external Postgres and S3-compatible storage
memwise worker       # runs steps and sandboxes from the DBOS queues, scaled out
```

- **Desktop stays possible.** The desktop app bundles a real Postgres binary, the way the server bundle already ships Bun and uv (`scripts/build-server.ts`). No cloud account needed.
- The host process grows from today's `server-core` (session manager, WebSocket RPC, headless mode).
- Plugins and definitions are identical across modes; only the backends change.

## 4. The project folder and CLI

A domain's definitions live in a folder, usually in git:

```
my-practice/
  memwise.yaml            # project settings: name, domain, plugins in use
  domain/entities/*.yaml
  workflows/<name>/…      # see 05
  plugins/                # local plugins and bindings
  policies/*.yaml
  pages/
```

- **Chat, the app and the CLI all write these files.** The app shows diffs; the CLI can run the same checks in CI.
- The CLI grows from today's terminal client (`apps/cli`) into the project CLI: `memwise init`, `start`, `check`, `test` (example cases), `diff`, `push` (publish through change control).

## 5. The relay

Public interactive forms for external participants, incoming webhooks and shared pages need a public endpoint even when the core runs on a laptop. Today's public sharing uses a Cloudflare worker that isn't in the open-source code, so MemWise needs its **own relay**: a small service that forwards scoped, expiring requests to the core. Where it runs is open ([16](16-open-questions.md)).

## 6. Open core, paid hosting *(Decided)*

- **Open source core.** The upstream code is Apache-2.0, which allows this. The Craft names and logos are trademarked, so they're removed (see [13](13-from-craft-agents.md)).
- **Paid hosted version:** the same binary on managed Postgres, storage, sandboxes and the relay, billed from the model gateway's meter and compute use.
