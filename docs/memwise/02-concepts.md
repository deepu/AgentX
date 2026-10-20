# 02 · Concepts and glossary

The vocabulary used across all the docs, grouped by plane (see [03](03-architecture.md)). The diagram at the end shows how the nouns relate.

## Work plane: what the business sees

### Domain
An **area of work** within an organisation (client intake, eTMF) and the business's **own model of it**: entity types, workflows, case types, mappings, policies, plus the records created as work happens. Definitions are files in the project folder; instances are rows in Postgres. See [04](04-domain-and-data.md).

### Workspace
The **organisation**: people, roles, installed plugins, chats and settings. A workspace holds **several domains**. Roles are defined once in the workspace and granted per domain, optionally scoped to some records; plugins are installed once and bound per domain. Entities in different domains can be linked. Until Phase 6 a workspace has one domain (D51). See [21](21-domains-and-records.md).

### Entity and entity type
An **entity type** is a business noun the domain defines (Customer, Invoice, Engagement) with fields, relationships, lifecycle states, rules, field ownership and field-level access. An **entity** is one record of that type.

### Value type
A small type every plugin understands: `Money`, `Date`, `DateTime`, `Address`, `PersonName`, `Identifier(kind)`, `File`, `TimeSeries`, `Ref<T>` and a few more. Business entities are never standardised globally.

### Workflow
A process definition: a **statechart** whose states are steps and whose transitions fire on step outcomes, domain events or timers. Stored as `workflow.yaml` plus one Markdown file per step. See [05](05-workflows.md).

### Step
A state in a workflow that a domain expert would recognise as a checkpoint. It has a **performer** (agent, person, external participant or system), **instructions** with a strictness (strict, guided, open), **reads and writes** on the case, **tools**, a **checkpoint** and **outcomes**.

### Case
The structured record of **one run**: references to entities plus run-specific fields, each value carrying provenance. Its shape is the workflow's **case type**. In statechart terms, the case is the machine's context.

### Run
One execution of a workflow, producing exactly one case. A run can wait for days and survives restarts. **The run, not the chat session, is the centre of the system.**

### Inbox
Everything waiting on a person: approvals, inputs, reviews, escalations, and questions raised by agents. Items open their component in place, and can be delivered through channels (email, WhatsApp, Telegram).

### Page and component
Sandboxed HTML talking to the host over a bridge. A **page** stands alone (a dashboard, a tracker). A **component** belongs to a step (an intake form, an approval card) and follows the MCP Apps pattern. See [10](10-experience.md).

### Plugin
A versioned package in the **MemWise plugin format**: any mix of connectors, tools, workflows, skills, components, page templates, type suggestions, triggers, default policies and environment requirements. Claude plugins can be imported. See [06](06-plugins-and-tools.md).

### Tool and effect class
A callable capability with typed input and output and a declared **effect class**:

| Class | Meaning | Example |
|---|---|---|
| `read` | Looks something up, changes nothing | Search customers |
| `draft` | Prepares something; nothing leaves or changes | Compose an email |
| `write` | Changes our own data, reversibly | Update a case field |
| `outbound` | Something reaches another party | Send an email, post to Slack |
| `irreversible` | Can't be taken back | A payment, a deletion, a filing |

### Mapping and binding
A **mapping** translates a plugin's data into domain entities (the CRM's `Client.company_name` is the domain's `Customer.name`). A **binding** is the complete, frozen record of how one plugin fits one domain: data mappings, entity bindings and policy review.

## Agent runtime: what makes agent work dependable

### Engine
What runs an agent loop. MemWise has two (see [07](07-agent-runtime.md)):
- the **open engine**: the existing Claude Agent SDK and Pi backends, for chat and open-ended work;
- the **step engine**: our own loop on `pi-ai`, for strict and guided workflow steps, where every model and tool call is journaled.

### Journal
The durable log of every model response and tool result in a session, kept by DBOS in Postgres. It makes resume and replay exact and keeps effects from repeating.

### Context and recall
What the agent sees at a step. **Pushed context** is declared: instructions, the case fields the step reads, linked entities. **Pulled context** comes through **recall tools** (past cases, step records, entity history), which are journaled and can be marked required. There is no separate memory store for workflows.

### Model gateway
The one path for every model call: model chosen by **role** ("checker", "extractor"), budgets, caching, fallbacks, metering and recording.

### Taint and quarantined reading
A session that reads untrusted content (an uploaded PDF, an email, a web page) is **tainted**, which narrows what it may do next. **Quarantined reading** sends untrusted documents through a separate model call that has no tools and can only return schema fields.

### Step record
The structured trace of one step execution: inputs and instruction version, context assembled, tool calls, rules evaluated, decision-time rationale, outputs with provenance, checkpoint outcome, cost, taint. It is the audit log, the context for chat, and the data for learning.

### Provenance
Where a value came from: computed by a tool, judged by the agent, extracted from a file with a confidence, entered or edited by a person.

### Example case
A sample case with expected outcomes, used as a test. Every human correction can become one.

## Control rail: what every layer obeys

### Identity, role and step token
People and roles exist from the first phase. Every agent action runs under a short-lived **step token** naming the role, run, case, step and the person it acts for. Postgres row-level security reads the same token, so the database governs agents as well as people.

### Policy
Rules about what is allowed: tools, data access, approvals, budgets, effect classes, where code runs. Layered **plugin → domain → workflow → step**, tighten only, and compiled into tool-gateway rules and Postgres RLS. Never written by hand as database rules.

### Change control
Definitions move **draft → checked → tested → approved → live (vN)**. Changes to live things are proposals with an impact analysis. Running cases stay on the version they started with unless a migration is approved.

### Trace
The full, replayable timeline of a run: step records plus every journaled call.

## State plane: where everything persists

- **Postgres:** the system of record (domain rows, cases, step records, runs, the DBOS journal and queues, the definitions index, policies, traces).
- **Object store:** files, workspaces and large artifacts. Local disk on desktop, S3-compatible elsewhere.
- **Event log:** append-only, in Postgres. History, triggers and replay.

## Surfaces

### Chat and anchor
Chat stays. There is one **always-on chat**, and a chat can be opened on any **anchor**: home, a workflow, a run or case, a step, an entity or a page. The anchor sets the chat's context and permissions. See [09](09-chat.md).

### Project folder
The folder holding a domain's definitions as files. Chat, the app and the CLI all write it.

### Meta workflow
A workflow whose output is a definition: "create a workflow", "bind a plugin", "create a connector". This is how things get built by conversation. See [11](11-authoring.md).

## How they relate

```
                       ┌───────────── Project folder (definitions, as files) ──────────────┐
 Plugin ──binding────▶ │ workflow.yaml · steps/*.md · case.yaml · entity types · policies   │
  ├ tools (+effect)    │ mappings · bindings · components                                    │
  ├ workflows          └─────────────────────────┬──────────────────────────────────────────┘
  ├ components/pages                            │ indexed
  ├ type suggestions   ┌─────────────────────── Postgres ─────────────────────────────────┐
  └ default policies   │ entities ◀── cases ──▶ step records ──▶ traces · event log        │
                       │   ▲           ▲  runs (statecharts on DBOS)  ▲ journal            │
                       └───┼───────────┼──────────────────────────────┼───────────────────┘
                           │           │                              │
       chats anchored ─────┘   step engine / open engine ── tool & model gateways ── policy (tighten only)
       to any of these                  under step tokens
```
