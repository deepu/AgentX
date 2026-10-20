# 04 · Plugins

A plugin is how capabilities reach a domain. The design aim is that **most features, including first-party ones, are plugins**. The core stays small and trusted, and the plugin contract is proven by the platform's own use of it.

## 1. What a plugin can contain *(Agreed)*

A plugin can hold **any mix** of the following, from a single item up to all of them:

| Component | What it is | Example |
|---|---|---|
| **Connectors** | Tools, credentials and auth flows that reach an external system | Gmail, a CRM, a broker API, Postgres |
| **Tools** | Typed, callable capabilities, either local code or remote | `compute_gst`, `extract_fields`, `backtest` |
| **Workflows** | Statechart definitions with step instructions | "Client intake", "Monthly close" |
| **Skills** | Reusable instruction packs (the open `SKILL.md` format) | "How to review a lease" |
| **Components** | UI that belongs to workflow steps (MCP App style) | Intake form, approval card, review document |
| **Page templates** | Standalone dashboards and tools | "Receivables dashboard" |
| **Type suggestions** | Entity and case types the plugin expects | `Party`, `Invoice`, `Instrument` |
| **Triggers** | Schedules and events that start workflows | "On the 1st of each month", "when an invoice is overdue" |
| **Default policies** | Approvals, limits and allowed tools | "Payments over ₹1L need approval" |
| **Environment requirements** | Languages and libraries its code needs | `python 3.12`, `polars 1.x` |
| **Playbooks** | Guides used by meta workflows | AgentX's `sources.md` is one of these |

A plugin is **written in its own terms**. It declares what it *needs* (entities with certain fields, other capabilities) and what it *provides*. It never refers directly to any particular domain's entities. That's what makes plugins reusable across businesses.

## 2. Manifest *(Proposed)*

```yaml
id: acme/client-intake
version: 1.4.0
title: Client intake
description: Collect client details and documents, verify them, approve onboarding.

provides:
  tools: [extract_fields, validate_gstin]
  workflows: [client_intake]
  components: [intake_form, approval_card]
  pages: [intake_dashboard]

requires:
  capabilities:
    - document_signing          # any installed plugin that provides this
    - email_send
  entities:
    Client:                     # the plugin's own name
      fields: { name: PersonName, email: Email, tax_id: Identifier }
    Engagement:
      fields: { type: Enum, start_date: Date }

environment:
  runtime: python@3.12
  lockfile: env/uv.lock
  resources: { memory: 1GB, timeout: 120s }
  network: [api.gst.gov.in]

policies:                       # defaults: the domain may tighten them, never loosen them
  - step: approve_onboarding
    require_role: manager
  - tool: extract_fields
    rate_limit: 30/min
```

## 3. Dependencies by capability *(Proposed)*

Plugins depend on **capabilities, not on other plugins by name**. "Needs `email_send`" can be satisfied by a Gmail plugin, an Outlook plugin or an SMTP plugin, whichever is installed. Benefits:
- **Swapping vendors doesn't touch workflows.**
- There is no dependency hell from pinned plugin names.
- The domain can show clearly which capabilities are missing and offer plugins that provide them.

Where a plugin really needs a specific integration, it can name a specific capability (`hubspot.deals`), at the cost of portability.

## 4. Binding a plugin into a domain *(Agreed)*

Installing a plugin into a domain means **binding** it. This is a guided meta workflow (see [08](08-authoring.md)):

1. **Install check.** Are the plugin's required capabilities available? Which policies does it bring? What will it be able to access?
2. **Entity binding.** An agent proposes how the plugin's expected entities map to domain entities, for example `Client` → `Customer` and `tax_id` → `gstin`. It flags gaps and suggests adding fields or creating new entity types.
3. **Data mapping.** For connectors: field mappings, directions and field ownership (see [03 §5](03-domain-and-data.md)).
4. **Policy review.** The plugin's default policies are shown, and the domain can tighten them.
5. **Dry run.** Its workflows are tried on sample or historical data.
6. **Freeze.** The binding is stored with a version, and the plugin is active.

There is **one binding per plugin per domain**. It covers both directions:
- **Data:** the plugin's records ↔ domain entities.
- **Definitions:** the plugin's workflows, rules and components use domain entities through the binding.

## 5. Plugin definitions inside a domain *(Agreed)*

- **Referenced, not copied.** The domain records "plugin X v1.4 plus its binding". Each definition carries its origin: *from plugin X*, *authored in this domain*, or *forked from X v1.4*.
- **Customising means forking.** Editing a plugin's workflow creates a domain-owned fork that links back to the original. The domain can then see "what changed upstream since I forked?", much like git.
- **Policies only get tighter.** A plugin ships defaults. The domain and the workspace may tighten them. Nothing may loosen a policy below what the domain sets.

## 6. Upgrades

When a new plugin version arrives:
1. The core compares its definitions and schemas against the frozen binding and any forks.
2. An **impact analysis** lists what changes: mappings that break, workflows that change, cases in flight.
3. The agent drafts a **proposal**: updated mappings, merges for forks, and a migration plan for cases in flight.
4. A person approves it. Until then, the domain keeps running the old version.

## 7. Bindings to the runtime: how code is reached *(Agreed)*

A plugin's tools have a **contract**: name, description, input and output schemas, an optional UI resource, and auth requirements. *How* they're reached is a deployment decision made by the core, based on trust and location, never by the plugin author:

| Binding | When | Notes |
|---|---|---|
| **In-process** | First-party or highly trusted code in the core's language | Fastest, but no isolation |
| **Local subprocess** | Untrusted or community code, or another language (Python next to a TypeScript core) | Process isolation; crashes and memory don't leak into the core |
| **Remote** | Hosted by another party, or needs special infrastructure | Usually over MCP via HTTP |

**MCP's role:** MCP is a good *contract* for the tool layer (schemas, resources, prompts, `ui://` components, auth) and one of the transports. It isn't the plugin itself. A plugin is bigger than an MCP server, because MCP has no notion of workflows, cases, domains or policies. A plugin's tool layer can be **exposed** over MCP so that other hosts, such as Claude or ChatGPT, can use it too.

## 8. Environments *(Agreed: sandboxes belong to the core)*

Plugins **declare** what their code needs:
- runtime,
- libraries plus a lockfile,
- resources, and
- network destinations.

They never ship or manage sandboxes. The core:
- builds or reuses an environment from the declaration (plugins with identical lockfiles share one),
- decides where it runs (a local subprocess, a container or a remote sandbox) by trust and resource needs,
- enforces limits and network rules, and
- records the environment's hash in every step record, for reproducibility.

The same mechanism covers **ad hoc analysis**. An agent asks the core for "a sandbox with plugin X's environment", writes code (for example with Polars), runs it, and the code and results go into the step record. Analysis that keeps getting repeated can be promoted to a fixed tool in the plugin (see [08](08-authoring.md)).

## 9. What stays out of plugins

Anything that **enforces trust** stays in the core, because a plugin can't police itself:
- policy evaluation and approvals,
- credential storage and the actual sign-in plumbing (plugins *describe* auth needs, and the core *holds* secrets),
- the sandbox runtime,
- the domain store's access control, and
- the UI host's sandboxing.

## 10. Distribution

- **Sources:** a local folder (authored in this domain), a team registry, or a public directory.
- **Publishing** follows the maturity path in [08](08-authoring.md): ad hoc → saved → reviewed and versioned → packaged.
- **Trust level** is recorded per plugin (first-party, verified, community, local). It affects which bindings and policies apply by default.
- **Compatibility:** plugins that use only MCP tools and `SKILL.md` skills can also be used, partially, in other ecosystems (Claude, ChatGPT and Codex plugins), and vice versa.

## 11. First-party features as plugins

Using AgentX features as examples, here is what would be a plugin rather than core:

| Feature | Becomes |
|---|---|
| Source setup (`sources.md`, `source_test`, OAuth triggers) | The "Connectors" meta plugin: a playbook, validation tools and the auth flow UI |
| Pages | The "Pages" plugin: page tools, templates and refresh scripts. The *rendering* stays in the core UI host. |
| Kanban board | A "Board" plugin: a page and component over cases |
| Messaging (Telegram, WhatsApp, Lark) | Channel plugins: deliver inbox items and forms, receive replies |
| Decision model | Mostly core (it's used by policy and the runtime), with the `decide` tool as a thin plugin |
| Domain packs (accounting, onboarding, trading) | Plugins with workflows, type suggestions, components and pages |

**Caution** *(Agreed)*: don't freeze the plugin contract up front. Build two or three first-party features as plugins first (connectors, plus one domain workflow with a form step), let the contract emerge from them, and freeze it only then.
