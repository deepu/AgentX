# MemBase design

MemBase is an agentic system built for **workflows and policies**. It builds on AgentX, a mirror of the open-source Craft Agents desktop app.

This folder collects the architecture worked out in the project's design discussions in October 2026. It is a **design proposal, not an implementation**. Nothing here has been built yet. Where a statement describes current AgentX behaviour, it says so and names the code.

## The idea in one paragraph

A business process is packaged as software that people with domain knowledge can build and run by talking to an agent:
- **Plugins** bring tools, workflows, UI components and data definitions.
- A **Domain** is a single typed store holding the business's own model: entities, workflow definitions, cases and the record of every step that ran.
- **Workflows** are state machines whose states are meaningful steps: things a domain expert would want to verify or approve.
- **Pages** are the human surface: standalone dashboards, or forms and approval cards inside a workflow.
- A small, trusted **core** runs it all and enforces policy.
- Almost everything else, including how new plugins, mappings and workflows get created, is itself a plugin or a workflow.

## Reading order

| # | Doc | What it covers |
|---|---|---|
| 01 | [Vision and principles](01-vision-and-principles.md) | Why this exists and the rules that shaped every decision |
| 02 | [Concepts and glossary](02-concepts.md) | Every noun in the system and how they relate |
| 03 | [Domain and data](03-domain-and-data.md) | The domain store, entities, value types, mappings, identity, versioning |
| 04 | [Plugins](04-plugins.md) | What a plugin contains, bindings, dependencies, environments, lifecycle |
| 05 | [Workflows and steps](05-workflows-and-steps.md) | Statecharts, steps as checkpoints, instructions and tools, human steps, step records |
| 06 | [Pages and UI](06-pages-and-ui.md) | How pages, workflow components and the app shell fit together |
| 07 | [Core runtime](07-core-runtime.md) | The microkernel: what the core owns and why |
| 08 | [Building by conversation](08-authoring.md) | Meta workflows that create plugins, mappings, workflows and pages |
| 09 | [Reference scenarios](09-scenarios.md) | Worked examples used to stress-test the design |
| 10 | [AgentX gap analysis and roadmap](10-agentx-gap-analysis.md) | What AgentX already has, what's missing, and a phased plan |
| 11 | [Open questions](11-open-questions.md) | Decisions not yet made |

## Status of decisions

Each doc marks its decisions with one of three labels:

- **Agreed:** settled in discussion with the project owner.
- **Proposed:** recommended here, but not yet confirmed.
- **Open:** listed in [11-open-questions.md](11-open-questions.md).
