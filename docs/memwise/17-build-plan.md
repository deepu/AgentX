# 17 · Build plan

How MemWise gets built, in phases. Each phase ends in something usable and a concrete exit test. The order follows one rule from [13](13-from-craft-agents.md): **build the spine first, then attach the body to it piece by piece.** No durations are given; each phase is sized by its exit test, not a date.

```
Phase 0  Rename, skeleton, spikes                  the app runs as MemWise; the risky bets are tested
Phase 1  The kernel: one durable step               a real agent step runs from files, survives a crash, sends once
Phase 2  Client intake, internal users              staff run intake end to end in the app; a manager approves in the inbox
Phase 3  Build and change by chat                   a second workflow is built by chat; changes go through drafts
Phase 4  Plugins and bindings                       intake installs into a fresh domain as a plugin
Phase 5  External participants                      a real client fills the form through a link
Phase 6  Server, hosting and learning               multi-user server, workers, metering; corrections improve workflows
```

## What runs in sequence and what runs in parallel

Phases are milestones in order; work inside a phase runs in parallel, and some later work starts early on side tracks.

- **In sequence (the critical path): 0 → 1 → 2 → 3.** The rename comes first so nothing is renamed twice. Intake (Phase 2) is built on the kernel's runs, journal and gateway. Building by chat (Phase 3) needs a live workflow and change control to edit.
- **In parallel inside a phase.** Phase 0: the five spikes alongside the rename. Phase 1: formats and checks, Postgres, the step engine on DBOS, the gateways and the policy compiler, built against agreed package boundaries and joined at the end.
- **Side tracks that start early, beside Phase 1:** the Phase 2 UI (navigation, inbox, approval card, case view) against sample data; the Phase 5 relay; the Phase 4 plugin format and loader.
- **About three tracks at once.** With agents building, the limit is integration and review, not hands.

## Phase 0 · Rename, skeleton and spikes

**Rename everything to MemWise** (D4) before any new code, so nothing is renamed twice.
- Packages `@craft-agent/*` → `@memwise/*` (15 packages and apps), the root package, binaries and the Electron app ID.
- Config folder `~/.craft-agent` → `~/.memwise` (referenced from about 46 files in `packages/shared` alone), with a one-time move of an existing folder.
- `CRAFT_*` environment variables → `MEMWISE_*`; the pages bridge protocol name; UI text, icons and branding.
- Drop the references to the private pages worker (`workers/pages`, not in the open-source export).
- Keep the Apache-2.0 licence and notices. Stop the automated upstream sync (D5).
- **Done when:** `bun test`, the typecheck scripts and both CI workflows (`validate.yml`, `validate-server.yml`) pass, and the desktop app and server start and work as before under the new name.

**Skeleton:** add empty packages with their boundaries agreed, so later phases fill them in:

| Package | Owns |
|---|---|
| `@memwise/defs` | File formats, JSON Schemas, checks, the definitions indexer |
| `@memwise/db` | Postgres connection, migrations, generated entity tables, RLS compilation target |
| `@memwise/runtime` | Runs: statecharts on XState, DBOS workflows per step, timers, events |
| `@memwise/step-engine` | The agent loop on `@earendil-works/pi-ai`, with every call as a DBOS step |
| `@memwise/gateway` | Tool and effect gateway, model gateway |
| `@memwise/policy` | Policy layers, the compiler, effective policy |

**Spikes** ([16](16-open-questions.md) items 1–5). Each is a throwaway prototype with a yes/no answer and a fallback. Results go into the decision log.

| Spike | Passes when | Fallback if it fails |
|---|---|---|
| S1 · DBOS under Bun | A DBOS workflow with steps, a durable sleep and an event runs under Bun and recovers after the process is killed | Run workers on Node; the host stays on Bun |
| S2 · DBOS versioning | A session started on version A resumes on A after version B is deployed | Pin workers per version and drain old ones |
| S3 · Bundled Postgres | The desktop app starts a bundled Postgres on macOS, Windows and Linux, with acceptable size and start-up time, and survives an app upgrade | Embedded Postgres (PGlite) for desktop only, with the same schema |
| S4 · Step loop on `pi-ai` | A loop with tool use, every model and tool call journaled; killing it mid-step resumes without repeating calls; prompt caching still works | Wrap the Pi backend and journal at the pool only, with strict steps restricted until fixed |
| S5 · XState with DBOS | A three-step statechart with a loop and a 3-day timer runs with state in our tables and survives restarts | A small custom statechart runner behind the same format |

## Phase 1 · The kernel: one durable step

The smallest kernel that runs one trustworthy agent step ([07 §10](07-agent-runtime.md)). Headless: driven from the CLI and tests, no new UI yet.

- **Postgres in every mode**, bundled on desktop (from S3). Migrations.
- **Definition formats** in `@memwise/defs`: `workflow.yaml`, `steps/*.md`, `case.yaml`, entity types, `policy.yaml`. JSON Schemas, the checks from [05 §8](05-workflows.md), and the indexer into Postgres.
- **Runs and cases:** statechart runs on XState and DBOS (from S5), cases with provenance, step records.
- **Step engine** with DBOS journaling and idempotency keys (from S4).
- **Effect gateway** at the two chokepoints: effect classes on tools, unclassified counted as `irreversible`, idempotency, secret injection, previews for `outbound`. The open engine gets effect journaling at the pool.
- **Thin model gateway:** roles, step and run budgets, recording every call.
- **Context assembly** that is recorded, and the first recall tools (`recall.step_record`, `recall.similar_cases`).
- **Output checkpoints**, with today's verify/repair logic moved in.
- **CLI:** `memwise check` and `memwise test` (run example cases).
- **Exit test:** the intake "Check answers" step runs from its files against a sample case. Killed mid-step, it resumes without repeating any model call, and a test `outbound` effect happens exactly once. Its step record and the context it saw are queryable.

## Phase 2 · Client intake, internal users

The first usable workflow (D6), in the app.

- **People and roles** (D32): sign-in, roles, step tokens, and Postgres RLS reading them, replacing the single server token.
- **Policy layers** compiled to gateway rules and RLS, tighten only (D30, D31), and the effective-policy view.
- **Domain:** entity types → generated tables; `Customer` and `Engagement`; mappings for the onboard step.
- **Human steps:** inbox, approval card, schema-generated form, case view. Sessions hibernate on human waits and resume on the answer.
- **Trust boundary:** taint on by default (D21) and quarantined reading for uploaded documents, because Check reads client files.
- **Navigation** reorganised around workflows, cases and the inbox; chat anchored to a case and a step, explain mode (D3, D27).
- **Views:** the playbook (default) and the map in design and live modes, view only (D25, D26).
- **Example cases** for intake.
- **Exit test:** staff start an intake in the desktop app, fill the form on the client's behalf, the agent checks it, the manager approves or sends back from the inbox, Onboard writes `Customer`. The map shows live cases, and "why was this flagged?" is answered from the step record.

## Phase 3 · Build and change by chat

- **Step editor** with chat beside it; every edit is a draft; chat changes show highlighted with check and example-case results; keep or discard.
- **Change control:** draft → checked → tested → approved → live, version index, running cases pinned to their version, impact analysis.
- **Map "proposed change" mode** showing the diff.
- **"Create a workflow" meta workflow**, with the interview as an open step; conversion of old `task.yaml` files.
- **Corrections become example cases.**
- **Project folder and CLI:** `memwise init`, `diff`, `push`.
- **Exit test:** a second workflow is built entirely by chat and published as v1; intake gets a new required tool through chat, reviewed as a diff, while running cases stay on the old version.

## Phase 4 · Plugins and bindings

- **The MemWise plugin format** and loader (D28); **Claude plugin import** for skills and MCP servers.
- **Connectors** repackaged as the first plugin; **client intake** packaged as a plugin.
- **"Bind a plugin" meta workflow:** tool classification, entity binding, data mappings, identity resolution, policy review, dry run, freeze.
- **Dependencies by capability.**
- **Exit test:** the intake plugin is installed into a fresh domain through the guided binding, and a CRM connector is mapped to `Customer` with identity resolution.

## Phase 5 · External participants

- **Our own relay** for public forms, webhooks and shared pages.
- **External links:** single-use, expiring, scoped to one step's component; drafts.
- **Channel delivery** of links and inbox items (email, WhatsApp) through the existing messaging gateway as plugins.
- **Extraction in the form** with confidence and provenance badges.
- **Exit test:** the full intake scenario ([14](14-scenarios.md)) with a real client filling the form from their phone.

## Phase 6 · Server, hosting and learning

- **Server and worker modes** on external Postgres and S3-compatible storage; workers scaled from DBOS queues.
- **Metering** per workspace and organisation; billing for the hosted version.
- **Learning:** shadow runs, improvement proposals, earned autonomy per effect class.
- **Managed environments** for Python tools (Scenario 3).
- **Plugin trust levels**, with signing and a registry after that.

## Running through every phase

- **Tests first for the spine:** every runtime package ships with crash-and-resume tests, not just unit tests.
- **Example cases are the acceptance tests** from Phase 1 onwards.
- **Upstream fixes** are cherry-picked by hand when worth it (D5).
- **The docs move with the code:** a phase that changes a decision updates [15](15-decisions.md).

## Deliberately later

Drag-and-drop map editing, canvas authoring, moving chat transcripts to Postgres, a public plugin registry, multi-domain workspaces, and `pgvector` recall. Each waits until something earlier needs it.

## Biggest risks

| Risk | Where it's tested | If it goes wrong |
|---|---|---|
| DBOS doesn't fit Bun or our versioning | S1, S2 | Node workers; version-pinned workers |
| The desktop Postgres is too heavy | S3 | PGlite on desktop only |
| Our step loop loses quality against the SDK's | S4, Phase 1 exit test | Keep more step kinds on the open engine; journal at the pool |
| The rename destabilises the app | Phase 0 exit test | Rename in slices, package by package, with CI green after each |
| Navigation rework breaks the mature chat experience | Phase 2 | Keep the chat screen untouched; change only how it's opened |
