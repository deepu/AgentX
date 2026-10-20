# 03 · Architecture

MemWise has four planes. The **agent runtime** is the centre. Above it is the business's view of the work, below it is the state everything persists to, and down the side runs the control rail that every plane obeys.

```
┌──────────────────────────────── Work plane ────────────────────────────────┐   ┌──── Control rail ────┐
│ Domain · Workflows and cases · People and inbox · Pages and components ·   │   │ Identity and         │
│ Plugins · Chat (anchored)                                                  │   │   delegation         │
├────────────────────────────── Agent runtime ───────────────────────────────┤   │ Policy (tighten only)│
│ Engines (open + step) · Durable sessions (DBOS journal) · Context and      │◀─▶│ Change control       │
│ recall · Tool and effect gateway · Model gateway · Trust boundary ·        │   │ Metering and budgets │
│ Workspaces and sandboxes · Checkpoints and evals · Interaction             │   │ Traces and replay    │
├──────────────────────────────── State plane ───────────────────────────────┤   │                      │
│ Postgres (system of record, journal, queues) · Object store · Event log    │   │                      │
└─────────────────────────────────────────────────────────────────────────────┘   └──────────────────────┘
```

## Why an operating system is the model

An agent runtime looks less like a database server and more like an operating system running untrusted, long-lived processes on someone's behalf.

| Operating system | MemWise |
|---|---|
| Process | Agent session |
| Scheduler | Run queue and workers (DBOS queues) |
| RAM / disk | Context window / domain, step records and recall tools |
| System calls | Tool and effect gateway |
| Users and permissions | Identity, delegation, policy |
| File system | Workspaces and object store |
| Device drivers | Connectors |
| Signals and IPC | Interrupts, events, agent messages |
| Hibernate | Session waiting on a person |
| Shell | The MemWise app |

Supabase taught us the **state plane and packaging** ("it's just Postgres", one binary, database rules generated from policy). Temporal taught us **durable execution** (journal every effect, resume exactly). The OS gives the **runtime** itself.

## Work plane

| Block | What it is | Doc |
|---|---|---|
| Domain | Entity types, relationships, lifecycles, mappings, in the business's own words | [04](04-domain-and-data.md) |
| Workflows and cases | Statecharts of steps, one case per run | [05](05-workflows.md) |
| People and inbox | Approvals, inputs, reviews, escalations | [08](08-policy-and-control.md), [10](10-experience.md) |
| Pages and components | Dashboards, forms, approval cards | [10](10-experience.md) |
| Plugins | Connectors, tools with effect classes, workflows, UI, default policies | [06](06-plugins-and-tools.md) |
| Chat | Always-on chat, plus chats anchored to anything | [09](09-chat.md) |

## Agent runtime

| Block | What it does | Doc |
|---|---|---|
| Engines | Open engine (Claude SDK, Pi) for chat and open work; step engine (own loop on `pi-ai`) for workflow steps | [07](07-agent-runtime.md) |
| Durable sessions | DBOS journal of every model and tool call; hibernate on human waits; exact resume and replay | [07](07-agent-runtime.md) |
| Context and recall | Declared, recorded context per step; journaled recall tools | [07](07-agent-runtime.md) |
| Tool and effect gateway | One gate for every tool call: effect class, policy, approvals, previews, idempotency, secret injection | [06](06-plugins-and-tools.md), [07](07-agent-runtime.md) |
| Model gateway | Model by role, budgets, cache, fallbacks, metering, recording | [07](07-agent-runtime.md) |
| Trust boundary | Taint tracking on by default; quarantined reading | [07](07-agent-runtime.md) |
| Workspaces and sandboxes | Files, code execution and browser per run; managed environments | [07](07-agent-runtime.md) |
| Checkpoints and evals | Output validation with provenance; example cases; corrections become tests | [05](05-workflows.md), [07](07-agent-runtime.md) |
| Interaction | Interrupts become inbox items, steering, sub-agents, case leases | [07](07-agent-runtime.md) |

## Control rail

| Block | What it does | Doc |
|---|---|---|
| Identity and delegation | People, roles, external participants, agent roles, step tokens, on-behalf-of | [08](08-policy-and-control.md) |
| Policy | Layered, tighten only, compiled to gateway rules and Postgres RLS | [08](08-policy-and-control.md) |
| Change control | Draft → checked → tested → approved → live; proposals with impact analysis | [08](08-policy-and-control.md) |
| Metering and budgets | Tokens, compute and money, per step, run, workspace and organisation | [08](08-policy-and-control.md) |
| Traces and replay | Every journaled call, explainable and replayable | [08](08-policy-and-control.md) |

## State plane

Postgres is the one required service. The object store is local disk on desktop. See [12](12-state-and-packaging.md).

## One agent step, end to end

The "Check answers" step of client intake ([14 · Scenario 1](14-scenarios.md)), showing which block does what.

| # | What happens | Blocks |
|---|---|---|
| 1 | The run enters "Check answers". The runtime issues a step token: role *intake checker*, acting for the workflow owner. | identity, runs |
| 2 | Context is assembled from the step file: instructions v3, the case fields it reads, Acme's customer record, tool guides. The list is recorded. | context |
| 3 | The step engine opens a journaled session in a fresh workspace. | step engine, sessions |
| 4 | The model gateway picks the "checker" model, with a 40k token budget and a cached prefix. | model gateway, budgets |
| 5 | The agent reads the client's PDF through quarantine and gets clean fields back. The session is now tainted. | trust boundary |
| 6 | It calls `recall.similar_cases` to see how past mismatches were resolved. The call is journaled. | recall, journal |
| 7 | It calls `gst.validate_gstin`, a `read`. Allowed; the key is injected at the gateway and the result journaled. | effect gateway |
| 8 | It wants to email the client. `outbound` plus tainted means an approval card showing the exact email. The session hibernates. | effect gateway, inbox |
| 9 | Next morning the manager edits one line and approves. The session resumes from its journal and the email goes out once. | sessions, people |
| 10 | Outputs are checked against the case type and provenance rules. The step record and trace are written. | checkpoints, traces |
| 11 | The manager's edit is saved as a correction, and can become an example case for the next instruction change. | evals |

## What lives in the core

Anything that enforces trust is core, because a plugin can't police itself:

- the run engine (statecharts on DBOS) and both agent engines,
- the tool and effect gateway and the model gateway,
- the policy compiler and evaluator, and identity,
- the credential vault (plugins describe auth needs; only the vault holds secrets),
- the sandbox runtime,
- the plugin loader and bindings,
- the UI host (sandboxed frames, the bridge, external links),
- the event log and scheduler, and
- the decision service (a small classifier used for routing, risk and outcome checks; it never grants authority).

Everything else, including connectors, domain packs, channels, page tooling and the authoring meta workflows, is a plugin.

## Deployment shapes

One binary, three modes. Plugins and definitions don't change between them; only the backends do. See [12](12-state-and-packaging.md).

| Shape | Notes |
|---|---|
| Desktop | Bundled Postgres, local disk as the object store, local sandboxes. Public links go through the relay. |
| Self-hosted server | Postgres, S3-compatible storage, container sandboxes, public links served directly. |
| Hosted (paid) | The same binary on managed Postgres, storage and sandboxes, with metering and billing. |
