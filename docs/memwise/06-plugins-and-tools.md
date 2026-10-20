# 06 · Plugins and tools

A plugin is how capabilities reach a domain. Most features, including first-party ones, are plugins. The core stays small and trusted, and the plugin contract is proven by the platform's own use of it.

## 1. What a plugin can contain

| Component | What it is | Example |
|---|---|---|
| **Connectors** | Tools, credentials and auth flows for an external system | Gmail, a CRM, a broker API |
| **Tools** | Typed capabilities with an effect class, local or remote | `extract_fields`, `validate_gstin` |
| **Workflows** | Workflow folders (shape, steps, case type) | "Client intake" |
| **Skills** | `SKILL.md` instruction packs | "How to review a lease" |
| **Components** | UI for workflow steps (MCP Apps style) | Intake form, approval card |
| **Page templates** | Standalone dashboards and tools | "Receivables dashboard" |
| **Type suggestions** | Entity and case types the plugin expects | `Client`, `Invoice` |
| **Triggers** | Schedules and events that start workflows | "When an invoice is overdue" |
| **Default policies** | Approvals, limits, allowed tools | "Payments over ₹1L need approval" |
| **Environment** | Runtime, libraries, lockfile, network | `python 3.12`, `polars 1.x` |
| **Playbooks** | Guides used by meta workflows | Today's `sources.md` |

A plugin is written **in its own terms**. It declares what it needs and provides and never refers to a particular domain's entities. That keeps plugins reusable across businesses.

## 2. The MemWise plugin format *(Decided)*

MemWise has its **own manifest format**, separate from the Claude plugin manifest (`.claude-plugin/plugin.json`), because a MemWise plugin carries things Claude's format has no place for: workflows, case and entity types, effect classes, policies, environments and capability requirements.

```yaml
# memwise-plugin.yaml
id: acme/client-intake
version: 1.4.0
title: Client intake
description: Collect client details and documents, verify them, approve onboarding.

provides:
  tools:      [extract_fields, validate_gstin]
  workflows:  [client-intake]
  components: [intake_form, approval_card]
  pages:      [intake_dashboard]
  capabilities: [document_extraction]

requires:
  capabilities: [email_send, document_signing]
  entities:
    Client:  { fields: { name: PersonName, email: Email, tax_id: Identifier } }

tools:
  extract_fields:
    effect: read
    input:  { files: List<File>, schema: Schema }
    output: { fields: List<ExtractedField> }
    quarantine: true            # reads untrusted documents (see 07)
  validate_gstin:
    effect: read
    input:  { gstin: Identifier(GSTIN) }
    output: { valid: Boolean, legal_name: Text }

environment:
  runtime: python@3.12
  lockfile: env/uv.lock
  network: [api.gst.gov.in]

policies:                       # defaults: the domain may tighten, never loosen
  - tool: extract_fields
    rate_limit: 30/min
```

### Claude plugins still work *(Decided)*

The loader **imports Claude plugins**: their skills (`SKILL.md`) and MCP servers come in as a MemWise plugin, with their tools unclassified until bound (§4). Existing plugins keep working without being rewritten. A MemWise plugin's tools and skills can also be **exported** over MCP for use in Claude and other hosts.

Don't freeze the contract up front. Build the first two or three first-party plugins (connectors, plus client intake) and let the contract settle from them before calling it stable.

## 3. Tools and effect classes *(Decided)*

Every tool declares its **effect class** in the tool contract. The plugin author knows, because they wrote the tool.

| Class | Meaning | Default treatment (the domain can tighten) |
|---|---|---|
| `read` | Looks something up, changes nothing | Allowed |
| `draft` | Prepares something; nothing leaves or changes | Allowed, shown in the record and previewable |
| `write` | Changes our own data, and can be undone | Allowed if the step permits |
| `outbound` | Something reaches another party | Preview and approval at first |
| `irreversible` | Can't be taken back: payment, deletion, filing | Approval, always |

- **Classes from MCP hints.** MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) seed the class for imported tools.
- **Unclassified means irreversible.** A tool from a server we didn't write, with no declaration, is treated as `irreversible` until classified. Classification happens once, at binding: the agent proposes a class from the tool's description, and a person confirms.
- **Classes that depend on arguments.** A generic tool (an HTTP call) can declare its class as a function of its input: `GET` is `read`, `POST` is `outbound`. Otherwise it's split into two tools.
- **Preview and dry run** are part of the contract for `draft`, `outbound` and `irreversible` tools, so an approval card can show exactly what will happen.
- **Idempotency keys** are required on every effect, so a retry never repeats it.

Why it's required: policy can say "outbound needs approval" or "irreversible never runs automatically" without naming tools; previews and approvals know what they're approving; and autonomy can be earned class by class (a workflow whose outbound drafts are approved unchanged often enough can be proposed for auto-send).

## 4. Binding a plugin into a domain

Installing means **binding**, through the "bind a plugin" meta workflow ([11](11-authoring.md)):

1. **Install check:** are required capabilities available? What policies come with it? What will it be able to reach?
2. **Tool classification:** confirm effect classes, especially for imported tools.
3. **Entity binding:** the agent proposes how the plugin's entities map to domain entities (`Client` → `Customer`) and flags gaps.
4. **Data mapping:** field mappings, directions and ownership ([04 §5](04-domain-and-data.md)).
5. **Policy review:** the plugin's defaults are shown; the domain may tighten them.
6. **Dry run** on sample data.
7. **Freeze:** the binding is stored as a file with a version, and the plugin becomes available to workflows.

**A step can never use a tool the domain hasn't bound.** A tool's path into a step is: shipped by a plugin → bound to the domain → allowed by the workflow → picked for the step (and optionally required).

## 5. Plugin definitions in a domain

- **Referenced, not copied.** The domain records "plugin X v1.4 plus its binding". Each definition carries its origin: *from plugin X*, *authored here*, or *forked from X v1.4*.
- **Customising means forking**, with a link back, so the domain can see what changed upstream since the fork.
- **Upgrades are proposals.** A new plugin version is compared with the binding and any forks; an impact analysis lists broken mappings, changed workflows and cases in flight; the agent drafts updated mappings and merges; a person approves. Until then the old version runs.

## 6. How plugin code is reached

The core decides how a tool is reached, by trust and location, never the plugin author:

| Binding | When |
|---|---|
| **In-process** | First-party code in the core's language |
| **Subprocess** | Community code, or another language (Python beside the TypeScript core) |
| **Remote** | Hosted elsewhere, usually MCP over HTTP |

Every route goes through the **tool and effect gateway** ([07](07-agent-runtime.md)), so policy, secrets, journaling and idempotency apply the same way to all of them. MCP is one contract and transport for the tool layer, not the plugin itself: MCP has no notion of workflows, cases, domains or policies.

## 7. Environments

Plugins **declare** what their code needs (runtime, libraries and lockfile, resources, network destinations). They never ship or manage sandboxes. The core builds or reuses an environment from the declaration, chooses where it runs, enforces limits and network rules, and records the environment hash in every step record.

The same mechanism serves ad hoc analysis: an agent asks for "a sandbox with plugin X's environment", writes code, and the code and results go into the step record. Analysis that keeps recurring is proposed as a tool.

## 8. Dependencies by capability

Plugins depend on **capabilities, not plugin names**. "Needs `email_send`" can be met by Gmail, Outlook or SMTP. Swapping vendors doesn't touch workflows, and the domain can show which capabilities are missing.

## 9. First-party features as plugins

| Feature today | Becomes |
|---|---|
| Source setup (`sources.md`, `source_test`, OAuth triggers) | The "Connectors" plugin, the first one we package |
| Pages tooling | The "Pages" plugin (rendering stays in the core UI host) |
| Messaging gateway (Telegram, WhatsApp, Lark) | Channel plugins that deliver inbox items |
| Decision model | Core service; the `decide` tool is a thin plugin |
| Domain packs (accounting, onboarding) | Plugins with workflows, types, components and pages |

## 10. Distribution

- Sources: the project folder, a team registry or a public directory.
- Trust levels per plugin (first-party, verified, community, local) set default bindings and policies.
- Signing and the registry come later ([16](16-open-questions.md)).
