# 10 · AgentX gap analysis and roadmap

AgentX (the mirror of Craft Agents, at v0.15.3) already has many of the building blocks. This doc maps what exists to the MemBase design, lists the gaps, and proposes a phased plan.

## 1. What AgentX already has

| MemBase concept | AgentX today | Where |
|---|---|---|
| Workflow runtime | **Conductor**: a DAG runner for `task.yaml`. Parallel dispatch, `${nodes.x.output}` and `${params.x}` references, run logs, resume across restarts, retries per node that include the last failure, verify/repair against acceptance criteria (`VERDICT: PASS/FAIL`), token and iteration budgets | `packages/server-core/src/tasks/TaskRunner.ts`, `packages/shared/src/tasks/` |
| Workflow spec, future kinds | The schema already parses `route`, `loop`, `approval`, `when`, `for_each`, `aggregate`, `retry`, `timeout`, `outputs` (typed), but **doesn't run them yet** ("P4") | `packages/shared/src/tasks/schema.ts` |
| Generating workflows by chat | Generate mode: the orchestrator writes `task.yaml`, which is validated and auto-repaired | `generator-prompt.ts`, `rpc/tasks.ts` |
| Agent runtime | Claude Agent SDK and Pi SDK backends, background tasks, mid-turn steering | `packages/shared/src/agent/` |
| Connectors and meta authoring | Sources (MCP, API, local), the `sources.md` playbook, `source_test`, OAuth triggers, credential prompts, the API tool factory | `packages/shared/src/sources/`, `apps/electron/resources/docs/sources.md` |
| Policy | Permission modes (Explore, Ask, Guarded, Execute), `permissions.json` per source, `source-policy.ts`, risk badges, guarded checks | `packages/shared/src/agent/` |
| Credential vault | AES-256-GCM credential store, token refresh, renew endpoints | `packages/shared/src/credentials/` |
| Sandbox | Script actions: argv spawn with bun, node or python3, a CRAFT_*-only environment, workspace containment, timeouts | `packages/shared/src/automations/script-executor.ts` |
| UI host and pages | Sandboxed pages (static, interactive, live), a data store per page, scheduled refresh, action grants tied to content digest, public sharing, publish as Claude artifact | `packages/shared/src/pages/`, `apps/electron/resources/docs/pages.md` |
| Triggers | Automations: cron, label and status changes, tool events, `semanticCondition`, prompt, webhook and script actions | `packages/shared/src/automations/` |
| Decision service | Opt-in decision model (Jev): `decide` tool, verdict reading, turn-outcome classification, repair scoping, semantic labels, with outcomes logged for tuning | `packages/shared/src/decisions/`, `server-core/src/decisions/` |
| Project memory | `projects/{slug}/MEMORY.md`, appended to by agents | `packages/shared/src/projects/` |
| Channels | Telegram, WhatsApp, Lark gateway | `packages/messaging-gateway/` |
| Headless and multi-surface | Server, web UI, CLI, thin desktop client | `packages/server/`, `apps/webui/`, `apps/cli/` |

## 2. Gaps

### Must build (core)
1. **Domain store:** typed definitions and instances, references, change log, queries, field-level access. Nothing comparable exists today.
2. **Statechart workflow runtime:** cycles, waits, timers, guards, parallel regions, sub-workflows. The Conductor's DAG becomes a special case.
3. **Human and external steps:** approvals, input forms, reviews, deadlines, escalation, the inbox. Today an unattended subtask that asks a question counts as failed.
4. **Cases with typed data and provenance**, replacing free-text node outputs.
5. **Step records** with rationale captured at decision time, plus chat with a step (explain, correct, what-if).
6. **Policy engine:** a single place combining plugin defaults with domain and workspace policies, step-scoped tool allowlists, required tools and approval routing.
7. **Managed environments:** build per-plugin environments from lockfiles. Today scripts use whatever is installed.

### Must build (plugin system)
8. **Plugin manifest, loader and bindings:** in-process, subprocess or remote; dependencies by capability; trust levels.
9. **Mapping and plugin binding:** agent-drafted, frozen, deterministic field and entity mappings; identity resolution.
10. **Versioning, freeze and proposals:** impact analysis, migrations, forks with links back to the original.

### Must extend (existing features)
11. **Pages:**
    - domain queries as a data source,
    - workflow components (MCP Apps pattern),
    - permissions scoped to the step, and
    - public **interactive** forms for external participants. Public pages are view-only today.
12. **Automations:** a "start workflow" action that passes parameters. Today an automation can't start a saved task.
13. **Task authoring:** sources, skills and tools per step, typed outputs, and acceptance criteria per step. Today these are only set for the whole task.

## 3. Phased roadmap *(Proposed)*

Each phase delivers something usable and keeps the upstream AgentX sync workable. The new pieces are separate packages, and changes to upstream code are kept small, at integration points.

### Phase 0: Foundations
- Lock the **definition formats**: workflow statechart, case type, step, entity type, value types (see open questions 1, 2, 7).
- Build a **domain store package** (SQLite first): definitions, instances, references and the change log.
- Pick the workflow engine with a spike: XState persisted snapshots versus a custom engine.

### Phase 1: One workflow, end to end
- **Statechart runtime** with agent, mechanical and person steps, timers and durable resume. Port the Conductor's verify/repair and budgets.
- **Cases with provenance** and **step records**.
- An **inbox** plus an **approval card** and a **schema-generated form** (internal users only).
- **Run monitor** with an auto-laid-out diagram, and **chat with a step** (explain mode).
- Reference workflow: a simplified **client intake** for internal users only.

### Phase 2: Plugins and bindings
- Plugin manifest and loader. Repackage **Connectors** (sources) and **Pages** as the first first-party plugins, to prove the contract.
- **Bind a plugin** meta workflow: entity binding, data mapping, freeze.
- Dependencies by capability.
- Managed **environments** for Python tools. Reference: the technical analysis plugin.

### Phase 3: External participants and full intake
- Public, scoped, interactive form links, and channel delivery (email, WhatsApp).
- `extract_fields` with provenance and confidence, inside a form.
- Send-back loops, deadlines and escalation.
- Reference: the **full client intake** scenario.

### Phase 4: Authoring and learning
- **Create a workflow** meta workflow, including converting existing guides.
- Example cases as workflow tests, and validation gates for freezing.
- Improvement workflows that turn corrections into proposals.
- Proposals, impact analysis, forks and plugin upgrades.

### Phase 5: Ecosystem
- Expose plugin tools and components over MCP (MCP Apps) to other hosts.
- Plugin registry, trust levels and signing.
- Optional canvas authoring and diagram editing.

## 4. Upstream strategy

AgentX is synced from upstream Craft Agents through automated version commits. To keep that sync viable:
- New capabilities live in **new packages** (for example `packages/domain`, `packages/workflow-runtime`, `packages/policy`, `packages/plugins`).
- Upstream code changes only at a few **integration points**: registering session tools, wiring in RPC handlers, and UI routes in the shell.
- Upstream features MemBase builds on (Conductor, pages, automations, decision layer) are wrapped through adapters, not modified in place, wherever practical.
- Where an upstream change is unavoidable, keep it small and well-isolated so it rebases cleanly.
