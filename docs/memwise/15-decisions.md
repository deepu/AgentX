# 15 · Decision log

Decisions made with the project owner (Sandeep) during the October 2026 design discussions. Each one links to where it's applied. Changing a decision means updating this log and the docs it points to.

## Product

| # | Decision | Why | Docs |
|---|---|---|---|
| D1 | The product is **MemWise**. This repo is a fork of Craft Agents; earlier notes called it MemBase. | One name for the product | all |
| D2 | **Open source core, paid hosted version.** Local desktop must stay possible. | Adoption through the open core; hosting sells operations | [12](12-state-and-packaging.md) |
| D3 | **Build on the Craft Agents UI**: keep the shell, chat and components; reorganise navigation around workflows, cases and the inbox. | It's mature; rebuilding wastes months | [10](10-experience.md) |
| D4 | **Rename everything to MemWise now** (packages, apps, binaries, branding). | Owner's call; Craft names are trademarked anyway | [13](13-from-craft-agents.md) |
| D5 | **Upstream sync ends with the rename**; upstream fixes are cherry-picked by hand. | Follows from D4: every sync would conflict | [13](13-from-craft-agents.md) |
| D6 | **The first workflow is client intake, internal users only.** | Exercises steps, cases, approvals and the inbox | [14](14-scenarios.md) |

## Architecture

| # | Decision | Why | Docs |
|---|---|---|---|
| D7 | Four planes (work, agent runtime, state) plus a control rail; the **agent runtime is the centre**. | Agents aren't apps; designed from first principles, not by copying a backend product | [03](03-architecture.md) |
| D8 | **The run is the centre, not the session.** | Workflows, cases and approvals hang off runs | [01](01-principles.md) |
| D9 | Small trusted core; everything else is a plugin. | A plugin can't police itself | [03](03-architecture.md) |
| D10 | Each domain owns its entity model; plugins map into it once; only value types are global. | Usable by any business; swapping tools touches only mappings | [04](04-domain-and-data.md) |

## State

| # | Decision | Why | Docs |
|---|---|---|---|
| D11 | **Postgres, opinionated**: use RLS, `LISTEN/NOTIFY`, queues and the rest directly; no database-agnostic wrapper. | Its features are the platform | [12](12-state-and-packaging.md) |
| D12 | **No Supabase dependency**; our own Supabase-style packaging. | Control over the platform, open core | [12](12-state-and-packaging.md) |
| D13 | **Definitions are files in the project folder, indexed into Postgres; cases and runs live in Postgres.** | Chat, app and CLI write the same files; every change has a diff | [04](04-domain-and-data.md) |
| D14 | **Chat transcripts stay on files for now**; the new runtime uses Postgres from day one. | Moving chat early is risk with no payoff | [09](09-chat.md) |
| D15 | One binary, three modes (standalone, server, worker); desktop bundles Postgres. | Same product on a laptop, a server or hosted | [12](12-state-and-packaging.md) |

## Agent runtime

| # | Decision | Why | Docs |
|---|---|---|---|
| D16 | **DBOS for durable execution**, not Temporal. | Postgres-native, no extra cluster | [07](07-agent-runtime.md) |
| D17 | **Two engines**: SDK backends for chat and open work, our own loop on `pi-ai` for workflow steps. | Only a loop we own can journal every model call | [07](07-agent-runtime.md) |
| D18 | **Journal every model and tool call** in workflow steps. | Retrying whole steps repeats side effects | [07](07-agent-runtime.md) |
| D19 | **No separate memory primitive for workflows.** Context is pushed (declared) plus pulled (journaled recall tools that can be required). Chat keeps its own continuity. | Memory decomposes into step records, the domain, instructions and example cases | [07](07-agent-runtime.md) |
| D20 | **One model gateway for every model call**, plugins included. | Budgets, data handling, replay and billing need one meter | [07](07-agent-runtime.md) |
| D21 | **Taint tracking on by default.** | Authors won't remember; the failure is a data leak | [07](07-agent-runtime.md) |

## Workflows

| # | Decision | Why | Docs |
|---|---|---|---|
| D22 | Workflows are **statecharts**; steps are **domain checkpoints**; people are first-class performers. | Real processes loop, wait and escalate | [05](05-workflows.md) |
| D23 | **Shape in `workflow.yaml`, each step its own Markdown file.** | Shape stays checkable; experts edit prose | [05](05-workflows.md) |
| D24 | **XState v5 behind our own format**, each step executed as a DBOS workflow. | Mature and checkable; stays swappable | [05](05-workflows.md) |
| D25 | **The map is view only at first**; shape changes through chat or the editor. | Drag-and-drop editing is a large build for later | [05](05-workflows.md) |
| D26 | **The playbook is the default view** for domain experts; the map is one tab away. | Experts think in procedures | [05](05-workflows.md) |
| D27 | **Chat is kept**: one always-on chat, chats anchored to anything, chats can create and change workflows. | Chat is how people build and ask | [09](09-chat.md) |

## Plugins and control

| # | Decision | Why | Docs |
|---|---|---|---|
| D28 | **A separate MemWise plugin format**; Claude plugins (skills, MCP servers) are imported. | Owner's call; MemWise plugins carry workflows, types, effects and policies | [06](06-plugins-and-tools.md) |
| D29 | **Every tool declares its effect class** (read, draft, write, outbound, irreversible); unclassified tools count as irreversible. | Approvals, previews and earned autonomy depend on it | [06](06-plugins-and-tools.md) |
| D30 | **Policy only tightens**: plugin → domain → workflow → step. Loosening means changing that layer. | Predictable and auditable | [08](08-policy-and-control.md) |
| D31 | Policies are **compiled** to gateway rules and Postgres RLS, never hand-written; step tokens let RLS govern agents. | Rules can't drift; nothing depends on the agent behaving | [08](08-policy-and-control.md) |
| D32 | **Minimal people and roles in the first phase**; outside participants later. | Approvals mean little without two roles | [08](08-policy-and-control.md) |
| D33 | Live definitions change only through **proposals with impact analysis**; running cases keep their version. | No silent changes | [08](08-policy-and-control.md) |
| D34 | The design docs are this **`docs/memwise`** set, replacing `docs/membase` (kept in git history). | One clean source of truth | [README](README.md) |

## Settled in Phase 0

Answers from the five spikes ([spikes/](../../spikes/README.md)) and choices made during the rename.

| # | Decision | Why | Docs |
|---|---|---|---|
| D35 | **DBOS runs under Bun**; no separate Node workers. Its system database is Postgres (there is no SQLite option); `DBOS.migrate()` runs once before workers start. | S1 passed on Bun and Node alike; parallel first launches collide on DBOS's own migrations | [S1](../../spikes/s1-s2-dbos/RESULT.md) |
| D36 | **Definition versions are workflow inputs, not DBOS versions.** A run carries its definition version and loads that snapshot in its first journaled step. DBOS's `applicationVersion` is an explicit engine label, bumped only when the engine's call sequence changes. Desktop startup moves runs left on an old engine label (fork or cancel and re-run the step, shown in the inbox); the server gets stable executor IDs and a small supervisor. | S2: DBOS pins a workflow to the version it started on and the patch API does not; the default version is a source hash that strands runs on any edit | [S2](../../spikes/s1-s2-dbos/RESULT.md), [07](07-agent-runtime.md) |
| D37 | **Desktop ships a real Postgres 18** from the per-platform `embedded-postgres` binaries, run by our own small `pg_ctl` supervisor, C.UTF-8 locale, data in `~/.memwise/postgres/data`. PGlite is the fallback only. Versions are pinned and the binaries mirrored. | S3: warm start ~140 ms on Linux, ~165 ms on macOS, ~320 ms on Windows; crash recovery and upgrades pass on all three under Node and Bun; PGlite shares one session across connections, which breaks RLS by session setting. On Windows the supervisor must poll for a real connection after `pg_ctl start` | [S3](../../spikes/s3-bundled-postgres/RESULT.md), [12](12-state-and-packaging.md) |
| D38 | **The step engine is our own loop on `pi-ai`**: every model call, policy decision and tool call is a DBOS step; pi-ai's own retries are off; idempotency keys are `workflowID:stepID`; each model attempt is recorded before it is sent; streamed text is tagged by step and attempt. | S4: a killed loop never repeated a finished call and resumed requests were byte-identical, so prompt caching holds | [S4](../../spikes/s4-pi-ai-step-loop/RESULT.md), [07](07-agent-runtime.md) |
| D39 | **One DBOS driver workflow per run**: XState's pure `transition()` over a snapshot in our tables, each step its own DBOS workflow, the transition committed in a DBOS data-source transaction guarded by a sequence number. Timers are rows with an absolute `fire_at`; outside answers go through an inbox table and name the state entry they answer. | S5 passed every crash point, including a 3-day timer across restarts | [S5](../../spikes/s5-xstate-dbos/RESULT.md), [05](05-workflows.md) |
| D40 | **Rename details:** the config folder moves once from `~/.craft-agent` to `~/.memwise` (a link is left at the old path); update checks, page sharing and session sharing are off until MemWise has its own services (opt-in env flags remain); the Craft-hosted OAuth relay and docs links stay for now and are replaced by our relay in Phase 5. Stable internal identifiers (the credentials key salts, the `craft-pages/v1` page protocol, `craft-` localStorage keys) are kept so existing data keeps working, and the old Electron profile is copied once. | Keep existing installs working without sending anything to Craft's release or sharing services | [17](17-build-plan.md) |

## Settled in Phase 1

Choices made while building the kernel ([18](18-kernel-interfaces.md)).

| # | Decision | Why | Docs |
|---|---|---|---|
| D41 | **An agent ends a step by calling a built-in `step.finish` tool** with an outcome, typed writes and a rationale; its schema is generated from the step's writes. Prose checkpoint rules are judged by a separate `verifier` model role that answers through a `checkpoint.verdict` tool; failures go back to the agent as repair rounds, then to a person. | Typed outputs instead of parsing text; the verifier can't be talked round by the agent's own transcript | [05](05-workflows.md), [07](07-agent-runtime.md) |
| D42 | **A lost effect result is retried only when the tool honours idempotency keys.** The ledger claims each key before the effect runs; a key left `pending` by a crash is re-run with the same key for such tools, and otherwise the call returns "unknown" and the step stops for a person. | Never repeat an effect blindly (07 §2) | [07](07-agent-runtime.md) |
| D43 | **Approval waits live inside the step**: an `approve` verdict records an approval request and the step hibernates on a DBOS message until a person decides. Platform defaults: read, draft and write allowed; outbound and irreversible need approval. | The step resumes mid-thought after the answer, even across restarts | [08](08-policy-and-control.md) |
| D44 | **Tool names are dotted** (`gst.validate_gstin`) everywhere in MemWise and mapped to `gst__validate_gstin` only at the model boundary. | Providers reject dots in tool names | [06](06-plugins-and-tools.md) |

## Settled in Phase 2

Choices made while building client intake for internal users ([19](19-phase-2-interfaces.md)).

| # | Decision | Why | Docs |
|---|---|---|---|
| D45 | **Roles are files, people are rows.** Roles live in `domain/roles.yaml` and are synced to Postgres at index; people, passwords and personal tokens live only in Postgres. Person and external steps name an `assignee` role; a workflow names an `owner` for attention items. | Roles are part of the definition and are checked with it (05 §8); people are instance data | [19 §1–2](19-phase-2-interfaces.md) |
| D46 | **RLS through one database role.** Every query made for someone runs inside `withActor`, which switches to the `memwise_app` role and sets the actor (person and roles, or step token) as transaction settings; compiled row rules and `domain_read` views read them. Restricted fields are cut off from the role by column grants and returned as null with their names listed. | The database enforces access for agents and people alike, and nothing depends on the app filtering rows (D31) | [19 §2–3](19-phase-2-interfaces.md) |
| D47 | **Entity tables are generated, additive only** (`domain.<entity>`), with `domain.<entity>.create` and `.get` bound as tools for every entity type. Onboard writes `Customer` through `domain.customer.create`. | Domain data lives in the domain, not in a connector's sandbox; columns are never dropped by a sync | [19 §3](19-phase-2-interfaces.md) |
| D48 | **Mechanical steps call their required tools in order with a declared `map`** from case fields to arguments, through the same gateway, ledger and approval path as agent steps. A person's answer travels beside the outcome event, not inside it, so the driver's replay guard is unchanged. | No model where none is needed (05 §3), with the same guarantees | [19 §4](19-phase-2-interfaces.md) |
| D49 | **Uploaded documents are read only through quarantined reading**: one model call with no tools, the text fenced as data, and only the requested fields kept and checked against their schema. Values from it, and judgements made after it, are marked tainted on the case. | Client documents are untrusted input (D21) | [19 §5](19-phase-2-interfaces.md) |
| D50 | **The map is SVG with our own layered layout while it is view only**; React Flow and ELK come with editing. | A small statechart needs no new dependencies, and the layout is a tested pure function | [05 §9](05-workflows.md) |
| D51 | **One domain per install for now**: the desktop keeps its project folder at `~/.memwise/project`, seeded from the intake example, and one kernel per process. The owner can act as another person on desktop, so one machine can play staff and manager; a server signs people in with email and password or a personal token. | Multi-domain workspaces are deliberately later (17). *Replaced by D70 in Phase 6.* | [19 §9](19-phase-2-interfaces.md) |
| D52 | **"Why was this flagged?" is answered from the step record only**, through a typed `explain.answer` call that must cite journal entries or outputs; citations that aren't in the record are dropped and an answer left without any is "not recorded". | Explanations must be grounded, not plausible (05 §11) | [19 §6](19-phase-2-interfaces.md) |

## Agreed for Phase 6

Agreed on 20 October 2026 from the eTMF trial of the model, and built in Phase 6 ([21](21-domains-and-records.md)). Numbers D53–D69 are left for decisions settled in Phases 3–5.

| # | Decision | Why | Docs |
|---|---|---|---|
| D70 | **A workspace is the organisation; a domain is an area of work, and a workspace holds several.** Roles are defined in the workspace and granted per domain, optionally scoped to some records. Plugins are installed once in the workspace and bound per domain or workflow. Policy layers become workspace → plugin → domain → workflow → step, still tighten only. Replaces D51. | Real organisations run several areas of work with the same people, plugins and records | [21 §1](21-domains-and-records.md) |
| D71 | **Entities in different domains are linked, not merged.** A `links:` entry names a match key and the fields it follows; each shared field has one source, is read through the link and is read-only on the other side. Matching reuses Phase 4 identity resolution, with uncertain matches going to a person. | Each domain keeps its own model (D10) without copies drifting apart | [21 §2](21-domains-and-records.md) |
| D72 | **Typed tables named by domain** (`domain.<domain>__<entity>`) in one schema: no schema per domain and no generic JSON table. The table count on hosted is handled by hosting. | Indexes, constraints, fast rollups and per-field grants need typed columns | [21 §3](21-domains-and-records.md) |
| D73 | **Record pages are generated, never stored.** An entity's `page:` section picks a layout (single, split or sidebar) and places blocks from a fixed set into named areas; without it a default is used. The details block always shows every field the viewer may see. Shared views and layouts are files; notes and personal views are rows. Row formulas and rollups compile to SQL. | Fewer hand-built pages: a well-defined entity gives its own page, and pages can't drift from the model | [21 §4](21-domains-and-records.md) |
| D74 | **Entity lifecycles are statecharts with named transitions** that say who may make them, their guards and the event they announce. Status changes only through a transition, via the gateway. Workflows declare what starts them; entities never name workflows. Invariants only flag; states can have timers. | Business events must be governed and auditable like any other write | [21 §5](21-domains-and-records.md) |
| D75 | **Four handoffs between workflows:** start, call, for each and wait until (the preferred one). A child keeps its own policy and the version it started on; checks verify inputs, outputs and call loops. | Long processes are made of smaller ones, and waiting on a condition beats polling | [21 §6](21-domains-and-records.md) |
| D76 | **`starts_on:` triggers:** entity events, dates on records, schedules and incoming messages (one address per domain, with a router workflow). Each start happens exactly once, missed runs are caught up once, bulk starts above a limit wait for approval, and triggered cases run as the workflow's owner role. | Most work starts from something happening, not a button | [21 §7](21-domains-and-records.md) |
| D77 | **Regulated mode per domain** (21 CFR Part 11, Annex 11): signed person steps with re-authentication and a hash of what was signed, and agents never sign. Record versions are hash-chained, with a reason, and can't be changed. Timestamps come from the server only. Also audit export, retention, no "act as another person", and a validation pack. Version history and server timestamps apply to every domain. | Regulated customers can't adopt the product without it, and other domains shouldn't pay for it | [21 §8](21-domains-and-records.md) |
| D78 | **Review screens are chosen by what a step writes:** document review (the Document's page in review mode, with highlights located from quoted text, not model coordinates), table review, diff review and an inbox queue mode. | Reviewing a document or a table in a form is slow and error-prone | [21 §9](21-domains-and-records.md) |
