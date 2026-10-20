# 02 · Concepts and glossary

This is the vocabulary used across all the docs. The diagram at the end shows how the concepts relate.

## Core nouns

### Domain *(Agreed: the name and the idea)*
A domain is a business's **own model of its world**, stored as one connected, typed store. It has two layers:
- **Definitions:** entity types, workflow definitions, case types, mappings, plugin bindings, rules and policies. These are versioned, and changes go through approval.
- **Instances:** entity records (or links to records in other tools), cases, step records, comments and files. These change as work happens.

A domain is portable: you can export it, share it, or start one from a template (for example, "starter domain for an accounting practice"). See [03](03-domain-and-data.md).

### Workspace
In AgentX today, a workspace is an operational container holding sessions, sources, skills, automations, pages and projects. In MemBase it stays the **place where work happens**: people, chat sessions, runs in progress and settings. A workspace **attaches one domain**, and several workspaces can attach the same domain (for example per team, per region, or test versus live).

*Why separate them:* a workspace changes constantly, while a domain should change only through proposals. Several workspaces sharing one domain shouldn't mean copying it.

### Entity and entity type
An **entity type** is a business noun defined in the domain: Customer, Invoice, Engagement, Instrument. It has:
- fields made of value types,
- relationships to other types,
- lifecycle states, and
- rules.

An **entity** is one instance of a type: a specific customer, a specific invoice. Its fields may live in the domain store or be linked from a plugin's system (see "Mapping" below).

### Value type *(Proposed)*
A small, globally standardised data type that every plugin understands. Examples: `Money(amount, currency)`, `Date`/`DateTime` with a timezone, `Address`, `PersonName`, `Phone`, `Email`, `File`, `Percentage`, `TimeSeries`. Standardising these, and nothing bigger, removes most integration bugs without forcing a global business schema.

### Plugin *(Agreed)*
A versioned package of capabilities. It can contain any mix of:
- connectors and tools,
- workflows,
- skills,
- UI components,
- page templates,
- case and entity type suggestions,
- triggers,
- default policies, and
- environment requirements.

It can hold one of these or many. See [04](04-plugins.md).

### Connector
A plugin component that reaches an external system, such as Gmail, a CRM, a broker API or a database. It's made of tools plus credentials and auth flows. It is AgentX's "source", generalised.

### Tool
A callable capability with a typed input and output schema: `compute_gst`, `send_email`, `extract_fields`, `create_invoice`. Tools are deterministic code from the agent's point of view. They may call external services, but the agent doesn't improvise their behaviour.

### Mapping *(Agreed)*
The translation between a plugin's data and the domain's entities. For example, the CRM's `Client.company_name` becomes the domain's `Customer.name`. An agent proposes it, a person reviews and **freezes** it, and it's stored as deterministic code. Mappings run both ways (reading and writing back).

### Plugin binding *(Agreed)*
The full record of how one plugin fits into one domain. It covers the plugin's data mappings, and how the plugin's own definitions (workflows, rules, forms) refer to domain entities. There is one binding per plugin per domain. Like a mapping, it's proposed, reviewed and frozen.

### Workflow *(Agreed: workflows are state machines, proposed)*
A process definition: a **statechart** whose states are steps and whose transitions fire on domain events or step outcomes. It is stored in the domain, comes from a plugin or is authored locally, and is versioned. See [05](05-workflows-and-steps.md).

### Step *(Agreed)*
A state in a workflow that a domain expert would recognise as a meaningful checkpoint. Each step has:
- **instructions**, ranging from strict to open,
- **allowed tools**,
- **inputs and outputs** in the case, and
- a **checkpoint**: validation, approval, or both.

A step can be carried out by an agent, by a person, or purely mechanically with no agent at all.

### Case *(Agreed)*
The structured record of **one run of a workflow**. It references entities (*which* customer, *which* invoice) and holds run-specific fields (submitted form data, computed values, decisions, status). Its type, the **case type**, is defined by the workflow using domain value and entity types. In state-machine terms, the case is the machine's *context*.

### Run
One execution of a workflow, which produces exactly one case. A run is in one or more states (several, when it has parallel branches), may wait for days, and survives restarts.

### Step record *(Agreed)*
The structured trace of one step execution. It holds:
- the inputs it saw and the version of its instructions,
- its tool calls and their results,
- the rules it evaluated,
- the reasons behind each decision, captured when the decision was made,
- its outputs, each marked with where it came from, and
- the checkpoint outcome.

The step record is the audit log, the context for chatting with the step, and the data used for learning.

### Provenance
For any value in a case: where it came from (*computed by tool X*, *judged by the agent*, *extracted from file Y page 2 with 0.82 confidence*, *entered by person Z*, *edited by person W*). Strict steps rely on provenance to reject values the agent made up.

### Policy *(Agreed)*
A rule about what is allowed. Examples:
- which tools a step may call,
- which fields a role may see,
- what needs approval,
- spending, token or time budgets, and
- where code may run.

Plugins ship default policies. The domain and the workspace can only tighten them.

### Page *(Agreed: both standalone and as a component)*
A piece of UI made of HTML and an app bridge, rendered in a sandbox. Pages come in two roles. See [06](06-pages-and-ui.md).
- A **standalone page** is a dashboard, tracker or tool that lives on its own and is created ad hoc. It works like AgentX Pages today.
- A **component** is UI that belongs to a workflow step, such as a form, an approval card, a review document or a checklist. It follows the MCP Apps pattern: a tool or step points to a UI resource.

### Shell
The fixed, first-party app chrome that every plugin depends on:
- the inbox (things waiting on you),
- case view,
- run monitor,
- step chat,
- domain editor, and
- the design system.

### Core
The trusted microkernel. It provides:
- the workflow runtime,
- the domain store,
- the policy engine,
- the credential vault,
- the sandbox runtime,
- the plugin loader and bindings,
- the UI host, and
- the event bus and scheduler.

See [07](07-core-runtime.md).

### Meta workflow
A workflow whose output is a definition instead of business work. Examples: "create a connector", "create a workflow", "map a plugin to the domain", "design a page". This is how everything gets built through conversation. See [08](08-authoring.md).

### Sandbox
A core service that runs code in an isolated environment built from a declared set of dependencies, such as Python with Polars. Plugins declare what they need, and the core decides where and how the code runs.

## How they relate

```
                         ┌──────────────────────────── Domain ────────────────────────────┐
                         │  DEFINITIONS (versioned, approved)                              │
 Plugin ──binding──────▶ │   entity types · workflow defs · case types · rules · policies  │
  ├ connectors/tools     │   mappings · plugin bindings · page/component templates         │
  ├ workflows            │                                                                 │
  ├ components/pages     │  INSTANCES (live)                                               │
  ├ type suggestions     │   entities/links ◀── cases ──▶ step records ──▶ comments/files  │
  ├ policies (defaults)  │        ▲               ▲             ▲                          │
  └ env requirements     └────────┼───────────────┼─────────────┼──────────────────────────┘
                                  │               │             │
             Workspace ── attaches ┘   runs (statecharts)   chat-with-step
             (people, sessions,        executed by Core     grounded in records
              runs, pages)
                                  Core: runtime · store · policy · vault · sandbox · UI host · scheduler
```

## Terms from AgentX, and how they map

| AgentX today | MemBase concept |
|---|---|
| Workspace | Workspace (unchanged), which now attaches a Domain |
| Source (MCP / API / local) | Connector inside a plugin |
| Skill | A skill inside a plugin, often used as step instructions |
| Task + `task.yaml` DAG | Workflow, generalised to a statechart |
| Subtask / node | Step |
| Run log + node outputs | Step records + case |
| Page | Standalone page; components are new |
| Automation | Trigger (from a plugin or domain) that starts a workflow or a step |
| Project + `MEMORY.md` | Mostly superseded by the domain; project memory may remain for chat sessions |
| Permission modes, Guarded mode | Inputs to the policy engine |
| Decision model (`decide`) | A core service used by steps, rule checks and calibration |
