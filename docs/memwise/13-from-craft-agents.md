# 13 · From Craft Agents to MemWise

This repo is our fork of the open-source Craft Agents app (v0.15.3). MemWise **keeps the body and replaces the spine**: the mature parts that don't care what sits at the centre are borrowed; the centre moves from a chat session saved as files to a run stored in Postgres.

## 1. Three findings that shape the plan

1. **The two chokepoints already exist.** Every tool call from both agent backends passes through the PreToolUse pipeline (`packages/shared/src/agent/core/pre-tool-use.ts`), and every source tool call through the MCP client pool (`packages/shared/src/mcp/mcp-pool.ts`). They become the effect gateway and the journal point without touching the backends ([07 §4](07-agent-runtime.md)).
2. **The agent loop isn't ours.** The Claude backend calls the SDK's `query()`, which runs the loop in a subprocess; Pi also runs in a subprocess. Hence two engines: keep these for open work, build a small loop on `pi-ai` for workflow steps ([07 §1](07-agent-runtime.md)).
3. **All state is files today.** Sessions are JSONL under each workspace (`sessions/{id}/session.jsonl`); config, task runs, automation history and decision logs are JSON and JSONL under `~/.craft-agent`; each page has its own SQLite file. There are no users. The new runtime uses Postgres from its first line; chat stays on files for now ([09 §4](09-chat.md)).

## 2. The full map

**Borrow** = used with small changes. **Wrap** = stays, behind a new MemWise interface. **Grow** = a real seed, but most of the target is still to build. **New** = nothing comparable today.

### Agent runtime

| Block | Today | MemWise | Verdict |
|---|---|---|---|
| Durable sessions | Session JSONL and SDK resume; the Conductor's run log and per-node retry | DBOS on Postgres; the step engine journals every call, the open engine journals effects at the pool | New |
| Context and recall | `prompt-builder.ts`, skills as required reading, guides that must be read first, large-result saving | A recorded context assembler; recall tools over cases and step records | Grow |
| Tool and effect gateway | MCP client pool, API tool factory, PreToolUse pipeline, permission manager, source policy | Both chokepoints kept; add effect classes, idempotency keys, previews, journaling | Wrap |
| Model gateway | LLM connections (Claude SDK, Pi with 20+ providers), Cloudflare AI Gateway option, usage tracker | A runtime service with roles, budgets, metering and recording | Grow |
| Trust boundary | Guarded mode's risk check; guide-read gate | Taint tracking and quarantined reading; the decision model as risk classifier | New |
| Workspaces and sandboxes | Session folders, script executor, browser tools, bundled Bun and uv, document tools | Used as is; managed environments and snapshots later | Borrow |
| Checkpoints | Verify/repair with `VERDICT: PASS/FAIL`, outcome classification, repair scoping | Moved into the step checkpoint | Borrow |
| Evals and learning | Decision outcomes logged to `decisions.jsonl` | Example cases, corrections as tests, shadow runs | Grow |
| Interaction | Mid-turn steering, `spawn_session` sub-agents, background work | Used as is; interrupts become inbox items | Borrow |

### Work plane

| Block | Today | MemWise | Verdict |
|---|---|---|---|
| Domain | Nothing; workspace config is JSON files | Entity definitions as files; generated Postgres tables | New |
| Workflows and cases | Conductor DAG runner (`TaskRunner.ts`) with budgets, retries, verify/repair; schema that parses loops and approvals but doesn't run them; generate mode | Statecharts on XState and DBOS; port the Conductor's logic and validation style; old `task.yaml` converts | Grow |
| Inbox | None | New shell surface | New |
| Channels | Messaging gateway (Telegram, WhatsApp, Lark) | Channel plugins delivering inbox items | Borrow |
| Pages and components | Sandboxed renderer, `craft-pages/v1` bridge, action broker, share bundles | Renderer and bridge kept; domain queries; grants become policies; components follow MCP Apps | Wrap |
| Plugins | Each workspace writes a Claude plugin manifest; skills and sources are folders | **A separate MemWise plugin format**; Claude plugins imported | Grow |
| Connectors | MCP, API and local sources; `sources.md`; `source_test` | Used as is, packaged as the first plugin | Borrow |
| Chat | Mature chat UI and sessions | Kept; anchored to anything | Borrow |

### Control rail

| Block | Today | MemWise | Verdict |
|---|---|---|---|
| Identity and delegation | One shared server token, no users | People, roles, participants, step tokens | New |
| Policy | Permission modes, `permissions.json`, source policy, page grants | Inputs to the policy compiler | Wrap |
| Change control | Configs edited live; `config_validate` | Draft → checked → tested → approved → live; reuse the validators | New |
| Credential vault | AES-256-GCM store, token refresh, OAuth flows | Used as is; Postgres-backed on servers | Borrow |
| Metering and budgets | Tokens per session; task-level token budget | Per step, run, workspace and org, from the model gateway | Grow |
| Traces | Session JSONL, run logs, automation history, event logger | Postgres traces; existing event shapes as vocabulary | Wrap |

### State plane and shipping

| Block | Today | MemWise | Verdict |
|---|---|---|---|
| Postgres | None; one SQLite file per page | The system of record, bundled on desktop | New |
| Object store | The workspace folder on disk | Local disk or S3-compatible behind one interface | Wrap |
| Events and triggers | In-memory event bus per workspace, cron, semantic conditions, webhook actions | Bus API kept; events persisted; "start a workflow" action | Wrap |
| App shell and UI kit | Electron app, web UI, `packages/ui` | Kept; navigation reorganised around workflows, cases and the inbox | Borrow |
| Server host | `server-core`: session manager, WebSocket RPC, headless mode | The host process of the `memwise` binary | Borrow |
| CLI | Terminal client for the server | The project CLI | Grow |
| Build and distribution | Server bundle with Bun and uv; electron-builder | Add a bundled Postgres | Borrow |
| Relay | Cloudflare worker for public sharing, not in the open-source code | Our own relay | New |

Roughly three quarters of the blocks have something real to start from. The quarter that's new is what everything else hangs off, so the spine is built first and the body attached to it piece by piece.

## 3. Rename and upstream *(Decided)*

- **Everything is renamed to MemWise now**: packages (`@memwise/*`), apps, binaries, config folders, the bridge protocol, UI text and branding. The Craft names and logos are trademarked and must go before any public release anyway.
- **The automatic upstream sync ends with the rename.** After a full rename every upstream version would conflict, so from here we **cherry-pick upstream fixes by hand** when they're worth it.
- The licence (Apache-2.0) and its notices are kept, as the licence requires.

## 4. Terms, then and now

| Craft Agents today | MemWise |
|---|---|
| Workspace | Workspace, which now attaches a domain |
| Source (MCP, API, local) | Connector in a plugin |
| Skill | Skill in a plugin, often used as step instructions |
| Task and `task.yaml` DAG | Workflow folder, a statechart |
| Subtask / node | Step |
| Run log and node outputs | Journal, step records and the case |
| Session | A chat (anchored), or how one step gets done |
| Page | Standalone page; components are new |
| Automation | Trigger that starts a workflow or step |
| Project and `MEMORY.md` | Superseded for workflows by the domain, step records and recall tools; chat keeps its own continuity |
| Permission modes, Guarded mode | Inputs to the policy compiler |
| Decision model (`decide`) | Core decision service |
