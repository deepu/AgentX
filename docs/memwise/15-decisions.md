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
