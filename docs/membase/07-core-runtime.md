# 07 · Core runtime

The core is a **microkernel** *(Agreed)*. It does what must be trusted and shared, and nothing else. The rule for deciding what goes in the core: **anything that enforces trust stays in the core, because a plugin can't police itself.**

## 1. Core services

| Service | Responsibility |
|---|---|
| **Workflow runtime** | Runs statecharts durably: states, transitions, timers, waits, parallel regions, sub-workflows. Resumes after restarts. Dispatches steps to agents, people or mechanical execution. |
| **Agent runtime** | Runs agent loops for agent-performed steps and chat sessions. Enforces the step's allowed tools, required tools, budgets and strictness. Collects rationale at decision points. |
| **Domain store** | Holds definitions and instances, typed references, the change log, queries and field-level access (see [03](03-domain-and-data.md)). |
| **Policy engine** | Evaluates policies on every tool call, data access, step transition and component action. Merges plugin defaults with domain and workspace policies (they can only get tighter). Routes approvals. |
| **Credential vault** | Stores secrets and runs auth flows (OAuth, API keys, token refresh). Plugins describe what auth they need, and only the vault holds the secrets. |
| **Sandbox runtime** | Builds environments from plugin declarations (runtime, lockfile, resources, network), chooses where they run, and enforces limits. Records environment hashes. |
| **Plugin loader and bindings** | Installs, verifies and versions plugins. Wires each tool through the right binding (in-process, subprocess or remote). Manages plugin bindings into domains. |
| **UI host** | Renders the shell and hosts pages and components in sandboxed frames. Carries the bridge, applies step policies to component actions, and serves external participant links. |
| **Event bus and scheduler** | Cron schedules, domain events (entity state changes), external events from connectors, triggers with semantic conditions. |
| **Decision service** | A small, fast classifier model that returns probabilities. It's used for semantic triggers, routing, outcome classification and risk checks. It never grants authority. |
| **Records and observability** | Step records, run timelines, costs, and logs with sensitive values hidden. |

## 2. What is *not* core

Everything below is a plugin, including first-party features:
- **Connectors**, and the "create a connector" meta workflow
- **Pages tooling and page templates** (rendering stays in the UI host)
- **Domain packs:** workflows, type suggestions, components
- **Channels:** Telegram, WhatsApp, Lark, email delivery of inbox items
- **Boards and other alternative views** over cases
- **Meta workflows** for authoring (see [08](08-authoring.md))
- **The `decide` tool** as an agent-facing wrapper (the service itself is core)

## 3. Execution of a step

```
Workflow runtime: run enters state S
  │
  ├─ policy engine: is S allowed? assignee? budget?
  │
  ├─ performer = system ──▶ mechanical executor: call tools in sequence ──┐
  ├─ performer = agent  ──▶ agent runtime: instructions + allowed tools ──┤
  │                           (sandbox for code; vault for auth;          │
  │                            policy check on every tool call)           │
  └─ performer = person/external ──▶ UI host: component in inbox or link ─┤
                                                                          ▼
                                   outputs validated against the case type and provenance rules
                                                                          ▼
                                   checkpoint: validators, then approval (if any)
                                                                          ▼
                                   step record written; case updated; event emitted
                                                                          ▼
                                   transition chosen (done / failed / timeout / custom outcome)
```

## 4. Durability

- The state of every run (current states, timers, pending human steps) is saved after every transition.
- Timers survive restarts. A "wait 3 days, then escalate" fires even if the process restarted in between.
- Each agent step is resumable or retryable, with what went wrong last time included in the retry. AgentX already does this for subtasks, with "failure-aware retry" in `TaskRunner.ts`.
- Each external call is idempotent where possible. Step records keep tool call IDs so a retry doesn't double-send.

## 5. Deployment shapes

| Shape | Notes |
|---|---|
| **Local desktop** | The core runs in the app. SQLite store, local sandboxes. External links need a relay or tunnel. |
| **Self-hosted server** | The core runs headless, as AgentX already can. Postgres, container sandboxes, public links served directly. |
| **Cloud** | The same core, with managed storage and sandboxes. An earlier assessment suggested running AgentX in a container and building MemBase's own workflow and policy layer on durable infrastructure such as Durable Objects and Workflows. That decision is open. |

Plugins don't change between deployment shapes. Only the core's backends do (store, sandbox, scheduler).

## 6. Trust boundaries

1. **Core ↔ plugin code:** separated by bindings. Untrusted code never runs in-process.
2. **Core ↔ sandboxed code:** no secrets, declared network only, and resource limits.
3. **Core ↔ UI:** pages and components run in opaque-origin frames, and every action goes through the policy engine.
4. **Core ↔ external participants:** scoped, expiring links. Their inputs are untrusted, and the tools they trigger run with the narrowest policy.
5. **Core ↔ documents and data:** content read from files, emails or web pages is untrusted. It may contain hidden instructions. Steps that process it (such as extraction) run with the minimum set of tools and can only output schema fields.

## 7. Relation to AgentX components

| AgentX today | Core service it seeds |
|---|---|
| `TaskRunner` (Conductor) | The workflow runtime. It already has a run log, resume, retries, verify and repair, and budgets. |
| Claude Agent SDK and Pi backends | The agent runtime |
| `PermissionManager`, permission modes, Guarded mode, `source-policy.ts` | The policy engine |
| `credentials/` (AES-256-GCM), `TokenRefreshManager`, OAuth flows | The credential vault |
| `script-executor.ts` (argv spawn, CRAFT_*-only env, workspace containment) | The sandbox runtime (without dependency management yet) |
| `McpClientPool`, `createSdkMcpServer`, API tool factory | Plugin loader and bindings |
| Pages renderer and `PageActionBroker` | The UI host |
| Automations (`SchedulerTick`, label events, `semanticCondition`) | Event bus and scheduler |
| `decisions/` (decision layer) | The decision service |
