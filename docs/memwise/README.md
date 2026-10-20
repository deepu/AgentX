# MemWise design

MemWise is an agentic platform for **workflows and policies**: a domain expert turns their process into working software by talking to an agent, and the result is dependable where it matters and flexible where judgment is needed. It is built on this repo, our fork of the open-source Craft Agents app.

This folder is the design, as agreed in the October 2026 discussions. It replaces the earlier `docs/membase` set, which is still in git history. Phase 0 (rename and spikes) and Phase 1 (the kernel) are built; the rest is design. Where a statement describes today's code, it names the file.

## The idea in one paragraph

A business process becomes a **workflow**: a statechart of steps a domain expert recognises, written as plain files (a small shape file plus one Markdown file per step). Each run produces a **case** in a Postgres-backed **domain** that holds the business's own entities. Steps are done by people, by the system, or by agents running on a durable **agent runtime** that journals every model and tool call, knows the effect of every tool, and treats untrusted content with suspicion. **Policy** is layered and only ever tightens, and it's compiled into the tool gateway and the database itself. **Plugins** bring tools, workflows and UI. **Chat** stays, anchored to anything, and is one of the ways definitions get built and changed.

```
┌──────────── Work plane: domain · workflows and cases · inbox · pages · plugins · chat ────────────┐  ┌ Control rail ┐
├──────────── Agent runtime: engines · DBOS journal · context and recall · effect gateway ·  ───────┤◀▶│ identity     │
│             model gateway · trust boundary · sandboxes · checkpoints · interaction                │  │ policy       │
├──────────── State plane: Postgres · object store · event log ─────────────────────────────────────┤  │ change ctrl  │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘  │ metering     │
                                                                                                         │ traces       │
                                                                                                         └──────────────┘
```

## Reading order

| # | Doc | What it covers |
|---|---|---|
| 01 | [Vision and principles](01-principles.md) | Why this exists, why agents aren't apps, the principles behind every decision |
| 02 | [Concepts and glossary](02-concepts.md) | Every noun, grouped by plane |
| 03 | [Architecture](03-architecture.md) | The four planes, the OS model, one step end to end, what's core |
| 04 | [Domain and data](04-domain-and-data.md) | Entities, value types, mappings, identity, cases, access |
| 05 | [Workflows and steps](05-workflows.md) | Statecharts, the file format, strictness, people, checks, views, editing, step records |
| 06 | [Plugins and tools](06-plugins-and-tools.md) | The MemWise plugin format, effect classes, binding, environments |
| 07 | [Agent runtime](07-agent-runtime.md) | Two engines, DBOS journaling, context and recall, gateways, trust boundary |
| 08 | [Policy and control](08-policy-and-control.md) | Identity and step tokens, tighten-only policy, change control, metering, traces |
| 09 | [Chat](09-chat.md) | The always-on chat, anchors, building by chat, storage |
| 10 | [Experience](10-experience.md) | Building on the Craft Agents UI, shell surfaces, pages, components, external participants |
| 11 | [Building by conversation](11-authoring.md) | Meta workflows, creating a workflow, maturity path |
| 12 | [State and packaging](12-state-and-packaging.md) | Postgres, object store, one binary, project folder and CLI, relay, open core |
| 13 | [From Craft Agents to MemWise](13-from-craft-agents.md) | What we keep, wrap, grow and build; rename and upstream |
| 14 | [Reference scenarios](14-scenarios.md) | Client intake and four other stress tests |
| 15 | [Decision log](15-decisions.md) | Every decision made so far, with its reason |
| 16 | [Open questions](16-open-questions.md) | What's left, including the spikes that start the build |
| 17 | [Build plan](17-build-plan.md) | Phases 0–6, each with an exit test, the spikes and the risks |
| 18 | [Kernel interfaces](18-kernel-interfaces.md) | The Phase 1 package boundaries, contracts and conventions |

## Status labels

- **Decided:** agreed with the project owner and recorded in the [decision log](15-decisions.md).
- Anything unlabelled is design detail that follows from the decisions and can change during the build.
- **Open:** listed in [16](16-open-questions.md).

## Next

The [build plan](17-build-plan.md): Phase 2, client intake for internal users, built on the kernel.
