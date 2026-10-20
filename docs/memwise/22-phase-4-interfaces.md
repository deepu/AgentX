# 22 · Phase 4 interfaces

The boundaries Phase 4 ([17](17-build-plan.md), "Plugins and bindings") is built against, in the same spirit as [18](18-kernel-interfaces.md), [19](19-phase-2-interfaces.md) and [20](20-phase-3-interfaces.md): agreed first, built in parallel, joined at the end. Earlier contracts still hold and change only additively.

| Contract | File |
|---|---|
| Manifest, bindings, mappings, identity | `packages/defs/src/plugin-types.ts` |
| Definition additions (`WorkflowDef.origin`, `ProjectDefs.plugins`, `bindings`, draft kind `binding`) | `packages/defs/src/types.ts`, `draft-types.ts` |
| Kernel additions (`Plugins`, identity, read-through) | `packages/runtime/src/types.ts` |
| App API shapes and channels | `packages/shared/src/protocol/memwise.ts`, `channels.ts` |
| Tables | `packages/db/migrations/0004_plugins.sql` |
| Meta playbook | `examples/intake/workflows/bind-plugin/` |
| Example plugins | `examples/plugins/` |

**Vocabulary.** People read "plugin", "connector", "binding", "mapping", "match". A connector is a plugin that reaches an outside system.

## 1. What changes, in one paragraph

A plugin is a folder with a `memwise-plugin.yaml`. Installing it copies the folder into the project's `plugins/<slug>/<version>/`, where it does nothing. Binding it, through the **bind-plugin** meta playbook, writes `domain/bindings/<slug>.yaml`: which of its tools are bound and with what effect class, which domain entities and roles its own names stand for, which bound tool provides each capability it needs, how its records map onto domain entities, and how the domain tightens its policy. Only frozen bindings bind tools (plus the kernel's own). A plugin's workflows are **referenced, not copied**: indexing resolves them through the binding into domain terms, so they run, check and show like authored ones, with an origin. Mapped connector records are linked to domain records by identity resolution; confident matches link, uncertain ones go to the inbox.

## 2. The plugin format (06 §2, D28)

```yaml
# memwise-plugin.yaml
id: memwise/client-intake           # <publisher>/<name>
version: 1.0.0
title: Client intake
trust: first-party                   # first-party | verified | community | local (default local)
provides:
  capabilities: { document_extraction: { tool: intake.extract_fields } }
requires:
  capabilities:
    email_send: { as: email.send }   # in my workflows `email.send` is whatever the domain binds for email_send
  entities:
    Client:
      fields:
        name:   { type: PersonName, required: true }
        email:  Email
        tax_id: Identifier(GSTIN)
        pan:    Identifier(PAN)
  roles:
    staff:   { title: Staff }
    manager: { title: Manager }
tools:
  gst.validate_gstin:
    description: Look up a GSTIN in the GST registry.
    effect: read
    input: { type: object, properties: { gstin: { type: string } }, required: [gstin] }
    run: { builtin: gst.validate_gstin }
mcp_servers: {}                       # as in Claude's .mcp.json: { command, args, env } | { url, headers } | { source: <slug> }
workflows: [client-intake]            # folders under workflows/
skills: []                            # folders under skills/ with SKILL.md
records: {}                           # connectors: record kinds a binding can map (§5)
policy: { tools: { rules: { intake.extract_fields: { rateLimit: 30/min } } } }
environment: { runtime: python@3.12 } # recorded only (built in Phase 7)
```

- **Workflows are written in the plugin's own terms**: `Ref<Client>`, `domain.client.create`, `assignee: manager`, `email.send`. They never name a domain's entities (06 §1).
- **Tool routes** (06 §6), chosen by the core: `{ builtin: <name> }` first-party code shipped with the app, found in the kernel's `builtins`; `{ mcp: <server>, tool: <name> }` a tool of a declared MCP server, over stdio or HTTP; `{ command: [...] }` a subprocess per call, JSON arguments on stdin and a JSON result on stdout. Every route goes through the tool gateway, so policy, the ledger, idempotency and secrets apply the same.
- **Tool names are global.** Two bound plugins may not bind the same name (`tool-name-taken`). The kernel's own names (`domain.*`, `recall.*`, `playbooks.*`, `plugins.*`, `identity.*`, `step.*`) are reserved.
- **Not acted on yet**, only parsed and shown: `components`, `pages`, `triggers` (Phase 6), `environment` (Phase 7).

### Claude plugins import (D28)

`importClaudePlugin(dir)` reads `.claude-plugin/plugin.json` (name, version, description), `skills/*/SKILL.md` and `.mcp.json` (`mcpServers`) into a manifest: id `claude/<name>`, trust `community`, the servers as `mcp_servers`, the skills as `skills`. Its tools are found by connecting to each server at install (`tools/list`); each becomes `<server>.<tool>` with the server's description, input schema and annotations, and **no effect class**: until a binding classifies it, it counts as irreversible (D29). Commands, hooks and agents in a Claude plugin are ignored, with a note in the install report (16 item 12).

### Installing

`installPlugin(projectRoot, sourceDir)` copies a plugin folder (a MemWise plugin, or a Claude plugin converted with its generated manifest) to `plugins/<slug>/<version>/`, refusing to overwrite a different folder at the same version. `memwise plugin install <project> <dir>` and `memwise:plugins:install` do this; for an imported plugin the kernel discovers the tools and writes them into the copied manifest. Installing changes nothing live. Several versions may sit side by side; a binding pins one. For an imported plugin only its own files are compared with the installed copy (the generated manifest is not part of the source): installing the same folder again rewrites the manifest in place, so tools found now (a server that was down the first time) come in; the manifest is kept when a server can't be reached now or a frozen binding pins that version.

## 3. Bindings (06 §4)

```yaml
# domain/bindings/memwise__client-intake.yaml
plugin: memwise/client-intake
plugin_version: 1.0.0
plugin_hash: 9c1e…                    # the installed folder the binding was made against
version: 1                            # bumped by each freeze
frozen: { by: per_01…, at: 2026-10-21T02:10:00Z, run: run_01… }
tools:
  gst.validate_gstin:    { effect: read }
  intake.extract_fields: { effect: read }
capabilities: { email_send: email.send }
entities:
  Client: { entity: Customer, fields: { name: name, email: email, tax_id: gstin, pan: pan } }
roles: { staff: staff, manager: manager }
records: {}
policy: { effects: { outbound: approve } }   # the domain's tightening (D30)
dry_run: { at: …, hash: …, passed: true, summary: … }
```

- **Only frozen bindings bind.** A tool reaches a step only if it is shipped by a plugin, bound in the domain (not `off`), allowed by the workflow and picked by the step (06 §4). Tools passed to the kernel directly (`options.tools`, the Phase 1–3 sample set) stay bound as before, so existing projects keep working.
- **Classification.** A binding's class for a tool wins over the manifest's; a tool with neither is irreversible. Loosening a declared class (declared `outbound`, bound as `read`) is a check error, and never takes effect: the tool keeps the stricter of the two classes. Classifying an unclassified tool is what binding is for.
- **The kernel's extractor.** The kernel's own quarantined `intake.extract_fields` stays bound in every domain (it is the kernel's extractor, not the plugin's), so a binding's class for it is ignored.
- **Capabilities** (06 §8): `capabilities: { email_send: email.send }` names the bound tool that provides it, from any bound plugin whose `provides.capabilities` lists it. A required capability left unfilled is an error unless `optional`. Swapping vendors is a binding change only.
- **Policy layers** (D30): platform → each relevant plugin's `policy` → the binding's `policy` → domain → workflow → step. A plugin layer applies to a step when the workflow comes from that plugin or the step allows one of its tools. The plugin's `policy` is written in its terms and is renamed through the binding like its workflows (capability aliases such as `email.send` in `tools` rules, allow and deny become the bound provider; plugin roles in `approvals.by` the domain's). Plugin layers are loaded from the indexed bindings at run time, like the domain policy.
- **Freezing** writes the file through a **binding draft** (draft kind `binding`, copying `domain/` only) and the Phase 3 draft machinery: edits are recorded, publishing refuses a stale or conflicting draft, and `mw.binding_versions` records who froze which content.
- **Upgrades are proposals** (06 §5): installing a newer version changes nothing; binding it again starts from the current binding, and the dry run shows how each workflow changes (structural diff). The old binding, and the old plugin folder it pins, keep running until the new one freezes.

### Resolving plugin workflows (06 §5)

`loadProject` reads `plugins/` and `domain/bindings/` and, for every frozen binding, adds the plugin's workflows to `project.workflows` in domain terms (`resolveWorkflow(workflow, plugin, binding)`):

| In the plugin's terms | Becomes |
|---|---|
| `Client`, `Ref<Client>`, `List<Client>` | `Customer`, `Ref<Customer>`, `List<Customer>` |
| `domain.client.create` / `.get`, and their `map:` argument names | `domain.customer.create` / `.get`, arguments renamed by the field map (an unmapped one is dropped, with a warning) |
| capability aliases (`email.send`) | the bound provider |
| plugin roles (assignee, owner, `approvals.by`) | domain roles |
| example cases (tool stubs, scripted tool calls, `expect.entities`) | renamed the same way |

The resolved workflow keeps `dir` inside `plugins/`, has `origin: { kind: plugin, plugin, pluginVersion, bindingVersion }`, and its `hash` covers the plugin's workflow folder and the binding, so a new binding is a new version for runs (D36) and running cases keep theirs. **Forking:** a playbook change on a plugin workflow makes a draft that copies the resolved files into `workflows/<id>/` with `forked_from: <plugin>@<version>`; once published the local folder wins (`origin.kind: fork`) and the plugin's is shadowed, noted in the checks.

## 4. The bind-plugin meta playbook (11 §3)

Shipped in the project folder beside create-playbook and change-playbook, added to existing projects at start.

```yaml
workflow: bind-plugin
owner: manager
start: check
steps:
  check:    { on: { ok: propose, missing: needs_person } }               # system: plugins.install_check
  propose:  { on: { classified: dry_run, unclassified: classify } }      # system: plugins.propose_binding → binding draft
  classify: { on: { proposed: dry_run, needs_person: needs_person } }    # agent (binder): classes from tool descriptions
  dry_run:  { on: { passed: review, failed: fix } }                      # system: plugins.dry_run
  fix:      { on: { done: dry_run }, wait: { remind: 2d, timeout: 14d → end } }       # person: edit the binding
  review:   { on: { approved: freeze, changes_requested: fix }, wait: { remind: 2d, timeout: 14d → fix } }
  freeze:   { on: { frozen: link, stale: dry_run } }                     # system: plugins.freeze
  link:     { on: { done: end } }                                        # system: identity.resolve
  needs_person: { on: { resolved: check }, assignee: manager }
```

Case type `plugin_binding`: `plugin`, `version` (plugin version), `draft`, `summary`, `unclassified`, `gaps`, `checked_hash`, `report`, `errors`, `examples_failed`, `binding_version`, `linked`, `candidates`.

| Step | Performer | Does |
|---|---|---|
| `check` | system | Install check: the plugin is installed, its required capabilities have providers among bound plugins (or are optional), no tool name is taken, what it can reach (tools by class, servers, network). Outcome `ok` or `missing`. |
| `propose` | system | `proposeBinding`: deterministic, no model. Classes from the manifest, else MCP annotations (`readOnlyHint` → read; `destructiveHint` → irreversible; otherwise none); entities matched by name and field types; fields by name, then by type (`Identifier(GSTIN)` finds `gstin`); roles by id; capabilities by the only provider; record sources by name and field similarity, with identity keys from identifier and email fields. Writes the binding draft; the gaps go into `summary`. Outcome `classified` or `unclassified`. |
| `classify` | agent, model role `binder`, guided | Reads the unclassified tools (names, descriptions, annotations, schemas) and proposes a class for each with a reason through `plugins.classify_tools` (effect `draft`). When unsure, the stricter class. |
| `dry_run` | system | Checks of the domain with the binding applied (the resolved workflows included); the plugin's example cases run through the binding (out of process, as in 20 §5); mappings applied to sample records from each mapped source's list tool (a `read`), with round trips for `both`/`write` fields; for upgrades, the structural diff of each workflow. Writes `report.json`; `passed` or `failed`. |
| `fix` | person, assignee `staff` | The binding review screen in edit mode; "Done" sends it back to the dry run. |
| `review` | person, assignee `manager` | The binding review screen: approve, or ask for changes. |
| `freeze` | system | Publishes the binding draft if its content hash is the one the dry run passed, as the next binding version, and re-indexes; `frozen` or `stale`. |
| `link` | system | For each mapped record source, `identity.resolve`: confident matches link, uncertain ones become inbox items, unmatched ones are created or left unlinked (§6). Writes `linked` and `candidates`. |

## 5. Mappings (04 §5, D64)

```yaml
records:
  contact:
    entity: Customer
    fields:
      name:  { from: company_name, transform: [trim, squash] }
      email: { from: email, transform: [trim, lower] }
      gstin: { from: gst_number, transform: [trim, upper] }
    identity:
      keys: [gstin, email]
      fuzzy: { field: name, auto: 0.95, review: 0.75 }
      create_missing: false
```

- **A fixed set of deterministic transforms**: `trim`, `lower`, `upper`, `digits`, `squash` (collapse spaces), `{ default: v }`, `{ map: { a: b } }`, `{ money: INR }`, `{ template: "{first} {last}" }`. No model runs when a mapping is used (P1). `compileMapping(binding) → (record) → MappedRecord` is pure and tested.
- **Unmapped source fields are kept** under the plugin's namespace (`extra`), never dropped.
- **Direction** defaults to `read`. `write` and `both` are declared and round-trip checked at dry run; writing back to the owner happens with linked entities in Phase 6.
- **Links, not copies** (04 §5): the domain keeps identity links and the fields it owns. A field the entity's `ownership:` gives to the plugin is **read through** the link: `kernel.entityRecord(entity, id, actor)` returns the row, its links, and each linked record's mapped values read live through the source's `get` tool (a `read` through the gateway, under the actor). The app shows them with their source. Field access holds through links: a field hidden from the actor is left out of a linked record's values, and its unmapped `extra` is shown only to someone who sees every field of the entity.

## 6. Identity resolution (04 §6, D65)

`matchRecord(mapped, candidates, rules) → IdentityMatch` is pure:

1. **Keys first.** For each key field in order, both sides normalised (trim, lower case, spaces removed); an equal non-empty value is a `key` match with score 1 ("same GSTIN"). Two different domain records matching is a conflict: `review`.
2. **Fuzzy second.** Name similarity (token-sorted Jaro–Winkler over normalised words, with legal suffixes such as Ltd, Limited, Pvt, Private, LLP, Inc removed), deterministic. At or above `auto`: `link`; at or above `review`: `review`; else `none`. A key present on both sides with different values caps the score below `auto` (never auto-linked).
3. **No model in Phase 4.** A model for fuzzy matches (04 §6) waits until deterministic matching is shown to fall short.

`kernel.identity.resolve({ plugin, source })` lists the source's records through its list tool, maps them and matches each against the entity's rows: `link` writes `mw.identity_links` (method `key` or `fuzzy`); `review` writes a pending `mw.identity_candidates` row, shown in the inbox to the binding's owner role as an **identity match** item (side by side, with reasons); `none` creates a domain record from the mapped fields when `create_missing` (method `created`), else stays unlinked. Already linked records and pairs a person rejected are never proposed again. Links are one to one per source: confirming a match settles the other pending candidates for the same outside record or the same domain record (status `settled`, not `rejected`, which is only a person's "different"), and a confirm that would give a domain record a second link from the same source, or link an outside record already linked, is refused and settled. `kernel.identity.decide({ candidateId, decision: 'confirm' | 'reject', by })` links (method `person`) or records the rejection; decisions are logged with who made them, so corrections improve the next run. Resolving again is idempotent.

## 7. Connectors as plugins (06 §9)

- **The Connectors plugin** (`memwise/connectors`, first-party): the connector setup guide (`sources.md`) as a skill, and the bridge from connectors people set up in chat (Craft "sources") to plugins: every MCP source of the workspace can be installed as a plugin `source/<slug>` whose server is `{ source: <slug> }`. The host resolves it at call time with the source's stored credentials (`SourceServerBuilder`), so nothing secret is copied into the project. Its tools are imported unclassified, like any MCP server.
- **Example plugins** in `examples/plugins/`: `client-intake` (intake in plugin terms; tools `gst.validate_gstin` and `intake.extract_fields` on builtin routes; requires `email_send`), `sample-email` (provides `email_send` with the sandbox `email.send`), and `sample-crm`, a **Claude plugin** (`.claude-plugin/plugin.json` and `.mcp.json`) whose dependency-free stdio MCP server (`server.mjs`) holds a few contacts and exposes `list_contacts`, `get_contact` and `create_contact`.

## 8. Kernel API additions (`@memwise/runtime`)

```ts
interface KernelOptions {
  builtins?: ToolDefinition[];                       // implementations for `run: { builtin }`
  resolveMcpSource?(slug: string): Promise<McpServerDef | undefined>;   // `{ source }` servers (the host)
}
interface Kernel {
  plugins: {
    list(): Promise<PluginSummary[]>;                // installed, with binding state
    get(id: string): Promise<PluginDetail | undefined>;
    install(dir: string, by: Actor): Promise<PluginSummary>;          // MemWise or Claude plugin folder
    startBind(pluginId: string, by: PersonActor): Promise<{ runId: string; caseId: string }>;
    binding(pluginId: string, opts?: { draftId?: string }): Promise<BindingView | undefined>;
  };
  identity: {
    resolve(input: { plugin: string; source?: string }): Promise<{ linked: number; candidates: number; unmatched: number; created: number }>;
    candidates(filter?: { status?: IdentityCandidate['status']; actor?: Actor }): Promise<IdentityCandidate[]>;   // with actor: none unless they decide matches
    decide(input: { candidateId: string; decision: 'confirm' | 'reject'; by: PersonActor }): Promise<{ applied: boolean; message?: string }>;
    links(entity: string, recordId: string): Promise<IdentityLink[]>;
  };
  entityRecord(entity: string, id: string, actor: Actor): Promise<EntityRecordView | undefined>;   // row + links + read-through
}
```

- The inbox gains `identity` items (pending candidates, for the bind-plugin playbook's owner role).
- Kernel tools (plugin `memwise`): `plugins.install_check`, `plugins.propose_binding`, `plugins.classify_tools`, `plugins.dry_run`, `plugins.freeze` and `identity.resolve`, for the meta playbook's steps.
- MCP connections are opened lazily, one per server, and closed at shutdown. A `{ source }` server is resolved (`resolveMcpSource`) when its connection opens and the connection is kept for the kernel's lifetime: a refreshed OAuth token of the connector is used once the server reconnects (a closed or failed connection is reopened on the next call).
- `{ command }` tools run with the MCP SDK's safe default environment (`getDefaultEnvironment()`: PATH, HOME and the like) plus the route's own, never the kernel's (no database URL or API keys).

## 9. App API

| Channel | Request → response |
|---|---|
| `memwise:plugins:list` / `get` | → `MwPluginSummary[]` / `(id)` → `MwPluginDetail` |
| `memwise:plugins:install` | `({ path })` → `MwPluginSummary` (a folder on the machine running the kernel; desktop and the owner only) |
| `memwise:plugins:bind` | `(pluginId)` → `{ runId, caseId }` |
| `memwise:bindings:get` | `({ pluginId, draftId? })` → `MwBindingView` (the binding, gaps, classes, the last report with mapped sample records) |
| `memwise:identity:list` / `decide` | `({ status? })` → `MwIdentityCandidate[]` (only for people who decide identity matches, the bind-plugin owner role; others get none) / `(MwDecideIdentityInput)` → `MwSubmitResult` |
| `memwise:entities:record` | `({ entity, id })` → `MwEntityRecord` (values, links, read-through values with their source) |
| `memwise:changed` | gains `{ kind: 'plugins' }` |

Editing a binding draft uses `memwise:drafts:write` (the file is under `domain/`).

## 10. Screens

- **Plugins** (sidebar): installed plugins with version, trust, what they provide and require, and their binding (not bound, being bound, bound vN, newer version available); Install (folder picker on desktop) and Bind.
- **Binding review** (opened from the bind-plugin inbox items and the plugin page): tools with their class and where it came from (declared, MCP hints, agent, person), editable; capabilities; entities and field renames; record mappings as a table with sample records before and after, errors and round trips; identity rules; the plugin's default policy and the domain's tightening; the dry-run report and, for upgrades, the workflow changes. Approve, ask for changes, or Done (fix).
- **Inbox**: identity match items, side by side with the reasons: "Same company" or "Different".
- **Entities**: linked records show a source badge and their read-through values.
- **Playbooks**: plugin workflows show "from Client intake 1.0.0".

## 11. Exit test

`packages/server-core/src/memwise/__tests__/phase4-exit.test.ts`, through the app API against a real Postgres with scripted models:

1. A fresh domain: `memwise init` (empty) with the domain's own `Customer` (`name`, `email` owned by the CRM, `gstin`, `pan`) and roles. The intake, sample-email and sample-crm plugins are installed; nothing new is bound.
2. sample-email is bound (all classified, so no agent step), reviewed and frozen.
3. client-intake is bound through the guided binding: `Client → Customer` with `tax_id → gstin`, `email_send → email.send`; the dry run runs its example cases through the binding; the manager approves; freeze makes `client-intake` a live playbook "from Client intake 1.0.0"; a case runs on it and writes a `Customer`.
4. sample-crm (a Claude plugin over MCP) is bound: its tools come in unclassified, the binder agent classifies them, `contact → Customer` is mapped, the dry run maps the sample contacts, the manager approves, and `link` resolves identities: the contact with the same GSTIN links automatically, a near name goes to the inbox and is confirmed, an unrelated one stays unlinked. The customer's record then shows its CRM email, read through the link.
