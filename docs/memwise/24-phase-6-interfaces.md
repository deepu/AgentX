# 24 · Phase 6 interfaces

The boundaries Phase 6 ([17](17-build-plan.md), "Domains and records", designed in [21](21-domains-and-records.md), D70–D78) is built against, in the same spirit as [18](18-kernel-interfaces.md) to [23](23-phase-5-interfaces.md): agreed first, built in parallel, joined at the end. Earlier contracts still hold and change only additively, with one planned exception: entity tables are renamed (§3).

| Contract | File |
|---|---|
| Definition shapes: domains, workspace, entity additions, triggers, hand-offs, pages, views, conditions | `packages/defs/src/domain-types.ts` (re-exported from `@memwise/defs`) |
| Additions to existing definition types (`EntityTypeDef`, `WorkflowDef`, `StateDef`, `StepDef`, `ProjectDefs`) | `packages/defs/src/types.ts` |
| Kernel additions (`kernel.domains`, `kernel.records`, `kernel.triggers`, `kernel.audit`) | `packages/runtime/src/types.ts` (`KernelPhase6`) |
| App API shapes and channels | `packages/shared/src/protocol/memwise.ts` (Phase 6 section) |
| Tables | `packages/db/migrations/0006_domains_and_records.sql` |
| Example project | `examples/etmf/` (two domains, `etmf` regulated and `edc`) |

**Vocabulary.** People read "domain", "record", "page", "view", "automation", "sign". Code says domain, entity record, record page, view, trigger, signature. The UI still says **playbook** for a workflow.

## 1. What changes, in one paragraph

A project folder now holds a **workspace** (people's roles, house rules) and **several domains**, each with its own entities, workflows, pages, views and policy. Every entity type is a typed table named `domain.<domain>__<entity>`. Every change to a record writes an **append-only, hash-chained version** with who, when (server time) and why. Entity types gain a **page layout**, **calculated fields** (row formulas and rollups compiled to SQL), a **parent** for the page tree, **links** to the same thing in another domain (fields read through, never copied) and a **lifecycle statechart** whose transitions go through the gateway and announce **entity events** in the same transaction. Workflows say **what starts them** (`starts_on:` entity events, dates on records, schedules, incoming messages) and hand work to each other with four **block states** (`start`, `call`, `for_each`, `wait_until`). A domain can be **regulated**: person steps can require an **e-signature** (re-authentication, meaning, hash of what was signed), a lifecycle transition can require one, reasons are required, and the audit trail exports. Person steps that review a Document open the Document's **record page in review mode**.

## 2. Project layout and domains (D70)

```
project/
  workspace.yaml                    name, roles, workspace house rules (optional)
  domain/                           the default domain (Phase 2–5 layout), id `domain`
    domain.yaml                     optional: name, regulated, …
    roles.yaml  policy.yaml  entities/*.yaml  bindings/*.yaml
  workflows/<id>/                   workflows of the default domain (and the meta playbooks)
  domains/<id>/                     any number of further domains
    domain.yaml                     name, regulated, owner, accepts_from, intake, retention
    policy.yaml                     the domain layer
    entities/*.yaml
    workflows/<id>/…
    pages/*.yaml                    free pages: dashboards (§6)
    views/*.yaml                    shared views (§6)
  plugins/…                         installed once, for the workspace (Phase 4)
```

- **Domain ids** match `^[a-z][a-z0-9_]{0,30}$`. The folders at the project root (`domain/`, `workflows/`) are the **default domain**, whose id is `domain`, so every Phase 2–5 tool name (`domain.customer.create`) and example keeps working. Its display name is `domain/domain.yaml`'s `name`, else "Main". A project may have only `domains/` (the eTMF example) and no default domain at all; the meta playbooks (create-playbook, change-playbook, bind-plugin) then live in the default domain's `workflows/` folder, which may exist without `domain/`.
- **Workflow ids stay unique in the workspace** (`duplicate-workflow` across domains). `WorkflowDef.domain` says which domain a workflow belongs to.
- **Entity names are unique within a domain.** `ProjectDefs.entities` is keyed by the **entity key**: the bare name in the default domain (`Customer`), else `<domain>.<Entity>` (`etmf.Site`). `EntityTypeDef.domain` is always set by the loader. Inside a domain, files name its own entities bare (`Ref<Site>`, `many Document`); another domain's entity is named with its key (`Ref<edc.Site>`). `scopedEntities(project, domain)` returns the map a workflow of that domain resolves names against (its own entities bare, every other entity by key).
- **`workspace.yaml`:**

  ```yaml
  workspace: Northlight CRO
  roles:
    tmf_specialist: { title: TMF specialist, description: QCs and files TMF documents }
    study_manager:  { title: Study manager }
  policy:                           # workspace house rules: the layer above every domain's
    effects: { irreversible: deny }
  ```

  Roles come from `workspace.yaml` merged with `domain/roles.yaml` (the default domain's file, kept for Phase 2–5 projects); a role defined in both is an error (`duplicate-role`). `ProjectDefs.roles` holds them all.
- **`domain.yaml`** (`DomainDef`, domain-types.ts):

  ```yaml
  domain: etmf
  name: eTMF
  owner: study_manager              # role that gets flags, held triggers, and owns triggered cases by default
  regulated: true                   # §9
  retention: 25y
  accepts_from: [intake]            # domains whose workflows may start or call workflows here (§8)
  intake: { address: etmf }         # incoming messages to this address start `message:` triggers (§7)
  ```
- **Policy layers** gain the workspace: platform → plugins → **workspace** → domain → workflow → step, tighten only (D30). `layersFor` takes `workspacePolicy`; a workflow's domain layer is its own domain's `policy.yaml`.
- **Grants (roles per domain, with an optional record scope).** A person's role is granted workspace-wide (Phase 2's `mw.person_roles`, unchanged) or in one domain, optionally limited to records: `mw.grants (person_id, role_id, domain, scope jsonb)`, where `scope` is `{ <field>: <record id> }`, for example `{ sponsor: "spon_…" }`. The person actor gains `grants?: { role, domain, scope? }[]` beside `roles` (workspace-wide roles only). Every role check that concerns a workflow, step or record of a domain uses `hasRole(actor, role, domain)` (runtime) and `mw.actor_has_role_in(role, domain)` (SQL), which accept a workspace-wide role or a grant in that domain. A person whose grants in a domain are all scoped sees only rows of that domain's tables whose scope field (a column with that name) holds one of the scope's ids; tables without that column are not filtered (open point: following the parent chain).
- **Plugins** are installed once for the workspace and bound per domain: a binding file in `domains/<id>/bindings/` binds into that domain; `domain/bindings/` stays the default domain's. Phase 6 keeps one binding per plugin per domain and doesn't build per-workflow bindings (open point).

## 3. Tables named by domain, record versions, server time (D72, D77)

- **Names.** `entityTableName(def)` is `<domain>__<snake(entity)>` (`etmf__site`, `domain__customer`), in schema `domain`, with its field-access view `domain_read.<same>`. Entity tools are `<domain>.<snake(entity)>.create`, `.get`, `.update`, `.transition` and `.list` (`etmf.site.get`; `domain.customer.create` in the default domain). `id` prefixes stay `entityIdPrefix(entity)`.
- **Migration.** On the first index after upgrading, a Phase 2 table `domain.<entity>` whose entity now lives in the default domain is renamed to `domain.domain__<entity>` (`alter table … rename`, same transaction as the schema sync; data, ids and indexes kept); its old `domain_read` view is dropped and re-made. `mw.identity_links.entity` and other stored entity names keep the entity key (unchanged for the default domain). Tested on a copy of a Phase 5 database.
- **Columns** every table has: `id, lifecycle, created_at, updated_at, created_by_step, idempotency_key` (as before) plus `version int not null default 1` and `updated_by text`. `updated_at` and `created_at` come from `now()` only: the store never sends them.
- **Record versions (every domain).** A trigger on each domain table writes `mw.record_versions` on every insert and update, so no write path can skip it:

  | column | |
  |---|---|
  | `entity` | the entity key (`etmf.Document`) |
  | `record_id`, `version` | primary key; `version` is the row's new `version` |
  | `at` | `clock_timestamp()` of the database server |
  | `by` | the actor: person id, `step:<stepRunId>`, `source:<plugin or domain>` or `system` (from the transaction's `mw.*` settings) |
  | `via` | step run id, link id or `app` |
  | `reason` | `mw.reason` setting of the transaction; required in a regulated domain for anything but a step write (a step write's reason is "<workflow title>: <step title>, case <id>") |
  | `values` | the whole row as JSON (field names, not columns) |
  | `changed` | field names that differ from the previous version |
  | `prev_hash`, `hash` | `hash = sha256(prev_hash ‖ canonical JSON of entity, record_id, version, at, by, reason, values)`; `prev_hash` is the previous version's hash, or 64 zeros |

  The app role may only `insert` and `select` it; a `before update or delete` trigger refuses any change, for every role, so tampering needs a superuser and still breaks the chain. `verifyChain(entity, recordId)` recomputes it. Rows written before Phase 6 get version 1 with reason "recorded before version history" on the migrating index.
- **Writes set the context** through `withRecordContext(db, { reason, via })`, which sets `mw.reason` and `mw.via` for the transaction; the actor settings already say who.

## 4. Entity definitions (D71, D73, D74)

```yaml
# domains/etmf/entities/site.yaml
entity: Site
title: "{site_number} · {name}"           # how a record is named; default the first Text field, else the id
parent: study                             # a `one` relationship: the page tree (§6)
fields:
  site_number: Text
  study:       { type: Ref<Study>, required: true }
  activated_on: Date
  sponsor_approved: Boolean
relationships:
  documents:           many Document               # inverse is Document's one `site` (inferred when unique)
  expected_documents:  { many: ExpectedDocument, via: site }
calculated:
  start_up_pack_complete: { percent: expected_documents, where: "status = 'filed'" }
  documents_filed:        { count: documents, where: "status = 'filed'" }
  days_activating:        { formula: "days_since(activated_on)" }
links:
  edc.Site:
    match: [site_number]                  # fields compared, in this domain's names
    follow: [name, address, principal_investigator]   # read through the link, read-only here
lifecycle:
  initial: selected
  states:
    selected:   { on: { picked: activating } }
    activating: { on: { approved: open }, after: { 60d: { remind: study_manager } } }
    open:       { on: { last_visit: closing } }
    closing:    { on: { archived: closed } }
    closed:     {}
  transitions:
    picked:   { by: [role:study_manager, source:edc] }
    approved: { by: [step], guard: "start_up_pack_complete = 100% and sponsor_approved" }
invariants:
  - "status = 'open' implies activated_on is set"
page: …                                   # §6
```

- **Fields** as before. A field may say `controlled: false` to be exempt from the regulated reason rule (§9); by default every field of a regulated domain is controlled.
- **Relationships** keep the string form `one X` / `many X`; the object form `{ one|many: X, via: <field> }` names the inverse for `many`. A `many` relationship's inverse is the target's `one` relationship (or `Ref` field) pointing back; it must exist and be unique, else `via` is required (`ambiguous-inverse`).
- **`calculated:`** fields (`CalculatedFieldDef`). Rollups over a `many` relationship: `count`, `sum`, `min`, `max` (with `field:`), `percent` (of the related rows, those matching `where`; 0–100; a record with no related rows is `null`). Row formulas: `formula:` over the record's own fields. Both are written in the **condition language** (§5), compiled to SQL in `domain_read.<table>` (columns, so filters, sorts, guards and rollups of rollups can use them). Calculated fields are read-only and never stored.
- **`links:`** (`EntityLinkDef`) to the same thing in another domain: `match` names fields of this entity (the other side's field of the same name, or `match: { site_number: number }` to rename); `follow` names the other side's fields this entity shows, read-only, through `domain_read` (a join on the pairing). Records are paired in `mw.identity_links` with `plugin = 'domain:<other domain>'`, `source = <other entity>`, `external_id = <other record id>`: by key when exactly one record matches; none or several makes an identity candidate for a person (Phase 4's inbox card). Pairing runs on index and on every entity event of either side. Followed fields may not also be fields of this entity (`followed-field-clash`). The other domain must exist and own the entity (`unknown-link`). A link is one way: the other side doesn't need to know.
- **`lifecycle:`** keeps the Phase 2 list form (`[a, b, c]`: any role may move to any state, transitions are named `to_<state>`), or the statechart above (`LifecycleDef`). `EntityTypeDef.lifecycle` stays the list of state names in both forms; `lifecycleChart` holds the chart. The record's state is still the `lifecycle` column and is called **`status`** in the condition language and on screen.
  - `transitions.<name>.by`: who may make it: `step` (any workflow step whose tools allow `<domain>.<entity>.transition`), `role:<id>` (a person in the app, or a step acting for them), `source:<plugin id | domain:<id>>` (a plugin's write-back or a linked domain), `system` (the kernel itself, e.g. a timer). Absent: `[step, role:<domain owner>]`.
  - `guard`: a condition on the record that must hold (the transition is refused with the condition and the values that failed).
  - `signed: true` (regulated domains): refused unless the case making the transition holds a signature on this record whose content hash matches the record now (§9).
  - `after: { <duration>: { remind: <role> } | { transition: <name> } }` on a state: a timer from entering the state (`mw.entity_timers`), cancelled on leaving it.
- **`invariants:`** never block a write. After each write the kernel evaluates them; a broken one raises a **flag** (`mw.record_flags`, one open flag per record and invariant) for the domain owner's role, shown on the record page and as an inbox item; the flag closes itself when the invariant holds again.
- **`ownership:`** (Phase 4) still says which plugin owns a field; followed link fields are owned by the linked domain. Fields the domain owns are editable on the record page by people with `role:` rights to `update` (default: any person with a role in the domain), always with a reason in a regulated domain.

## 5. The condition language

One small language for guards, invariants, rollup `where`, row formulas, view filters and `wait_until` (`parseCondition` in defs; `compileCondition` to SQL in db). It is not a general formula language.

```
expr     := or ;  or := and ('or' and)* ;  and := not ('and' not)* ;  not := 'not' not | implies
implies  := cmp ('implies' cmp)?
cmp      := sum (op sum | 'is set' | 'is not set' | 'in' '(' literal (',' literal)* ')')?     op: = != < <= > >=
sum      := term (('+' | '-') term)* ;  term := unary (('*' | '/') unary)* ;  unary := '-' unary | atom
atom     := number ['%'] | 'text' | true | false | null | today | now | duration (30d, 2w, 12h)
          | name ('.' name)?            a field, calculated field, followed field, `status`, `id`, `created_at`, `updated_at`; `record.x` = `x`
          | fn '(' expr (',' expr)* ')' days_since(d) days_until(d) coalesce(a, b) lower(t) length(t)
          | '(' expr ')'
```

- Names are checked against the entity (`unknown-field` with the file and position). Types are checked loosely: comparisons between a number and text are errors; `100%` is the number 100 (Percentage values are 0–100); `today + 30d` and `d - today` work on dates.
- `parseCondition(src) → { ast, names, diagnostics }`; `compileCondition(ast, { columnOf(name) → sql }) → { sql, params }` with `$n` parameters, never interpolated text. A condition evaluated for one record runs as `select (<sql>) from domain_read.<table> where id = $1` under the actor, so it respects RLS.

## 6. Record pages, page tree, views, free pages, notes, mentions (D73)

**Page layouts** (`PageLayoutDef`): an entity's `page:` section.

```yaml
page:
  layout: split                     # single | split | sidebar
  header: [title, artifact, status, site]
  left:  [{ viewer: file }]
  right: [{ fields: [artifact, study, site, about, document_date, version] }, checks, details, { related: [versions, signatures] }]
  below: [mentions, notes]
```

- Areas: `header` (field names) and, by layout, `main` (single), `left`/`right` (split), `main`/`side` (sidebar), plus `below` for all. Blocks: `fields: [names]`, `details` (always present: every field the viewer may see; added to the end of the first area if left out), `viewer: <Document or File field>`, `related: [many relationships]` (each a small table, with "Open view"), `cases` (open and recent cases whose case values reference this record), `lifecycle` (the chart with the current state, the transitions the viewer may make, guard status), `chart: { kind: bar|line|donut, of: <relationship or calculated field>, by: <field> }`, `checks` (review mode only), `notes`, `mentions` ("Mentioned in"), `start` (workflows this record can start: those whose `starts_on` names this entity or whose start fields take a `Ref` to it), `history` (record versions and signatures). Unknown blocks and fields are check errors (`unknown-page-block`, `unknown-field`). No `page:` gives `defaultPageLayout(def)`: single, header = title + status, blocks fields (all), lifecycle if any, related (every many), cases, notes, mentions, history.
- **Record pages are built on request** by `kernel.records.page(entityKey, id, actor, { review? })` → `RecordPage` (runtime types): the layout, the record's values with provenance-like **sources** per field (`domain`, `plugin:<id>`, `link:<domain>`, `calculated`, `step:<stepRunId>` from the last version that changed it, `person:<id>`), hidden fields, followed values, the blocks' data, flags, the transitions the actor may make with guard results, signatures and whether each still matches ("changed since signed"). Nothing is stored. Editing a field: `kernel.records.update({ entity, id, values, reason }, actor)`; a status change: `kernel.records.transition({ entity, id, transition, reason }, actor)`.
- **Page tree** (`kernel.records.tree(domain, actor, { parent? })`): roots are records of entities without `parent` that something else names as parent (Sponsor); under each record its children by every entity whose `parent` points at it, grouped by entity ("Sites · 7"); a group over 25 records is one entry that opens a view. Free pages hang in the tree by `under: { entity, id? }` (under a record type, or one record), else at the domain's top.
- **Views** (`ViewDef`, `views/*.yaml` shared; personal ones in `mw.views`): `entity`, `filter` (condition), `sort: [{ field, desc }]`, `group: field`, `columns: [fields]`, `layout: table | board` (board groups by `status` by default). `kernel.records.query({ entity, filter?, sort?, group?, columns?, limit, offset }, actor)` → `RecordQueryResult` compiles to SQL on `domain_read` (RLS applies).
- **Free pages** (`FreePageDef`, `pages/*.yaml`): a dashboard is a list of blocks (`kpi: { label, value: { count|percent|sum|avg: <entity>, where?, field? }, target? }`, `table: { view or inline view }`, `heatmap: { rows: <entity>, columns: [{ label, value }] }`, `list: { view }`, `text: markdown`) with `params` (e.g. `study: Ref<Study>`, bound from the page's place in the tree). `kernel.records.dashboard(domain, pageId, params, actor)` → `DashboardData` computes every number in SQL now. A written page (prose) is data: `mw.pages` (id, domain, under, title, body markdown, versions), edited in the app.
- **Notes**: `mw.record_notes` (entity, record id, body markdown, version, by, at), one note per record, with history; under the record's access rules (the kernel checks the actor can read the record).
- **Mentions**: `@` references in notes, chat messages, step rationales and comments are stored as `mw.mentions (target_entity, target_id, source_kind, source_id, at)`, written by `kernel.records.mention(...)` and by the kernel when it stores notes and step records (it parses `[[etmf.Site:site_…]]` tokens the editor inserts). The page's `mentions` block lists them; renames carry through because the reference is the id.

## 7. Entity events and triggers (D74, D76)

- **Entity events** (`EntityEvent`): `created`, `changed` (with `fields`), `entered` (`state`, `from`, `transition`), plus `changed` for a record whose **rollups** another record's write affected (the parent named by the written row's inverse column). The writing transaction inserts them into `mw.entity_events` (id, entity, record id, kind, data, at, `seq` bigserial), so an event exists exactly when its change committed. A **dispatcher** (one DBOS workflow per kernel, woken by `pg_notify('mw_changes', {kind:'entity'})` and a sweep every 30 s) reads events after its cursor and, for each, in order: pairs links (§4), re-checks `wait_until` waits on that record (§8), evaluates invariants, arms or cancels state timers, and fires `entered:`/`created:`/`changed:` triggers. Each consumer records `(event id, consumer)` in `mw.event_deliveries` (primary key), so a replay never acts twice.
- **Triggers** (`TriggerDef`, a workflow's `starts_on:`):

  ```yaml
  starts_on:
    - entered: Site.activating                     # also created: Document, changed: { entity: Site, fields: [status] }
      with: { site: record }                       # case field ← the record's id (default: the one Ref<Site> start field)
    - before: { field: Person.cv_expires, by: 30d } # one case per record per date
      with: { person: record }
    - every: 2w                                    # optional `at: "06:00"`, `on: monday`
    - message: { address: etmf }                   # an incoming message to the domain's intake address
      with: { sender: message.from, subject: message.subject, documents: message.attachments }
    as: study_manager                              # optional: who the case runs as (default the workflow's owner role)
  ```

  Each firing has a **key**: `entered:<trigger>:<event id>`, `date:<trigger>:<record>:<date>`, `every:<trigger>:<slot start>`, `message:<trigger>:<message id>`. `mw.trigger_firings (key primary key, workflow_id, trigger_index, kind, record, run_id, status: started|held|discarded|failed, at, message)`; the run id is derived from the key, so a retried firing starts nothing new.
  - **Date triggers** are swept every minute: a record whose date minus `by` (or plus, for `after:`) is on or before today and has no firing for that date fires once. Changing the date makes a new key (a new firing for the new date).
  - **Schedules** keep `next_due` in `mw.trigger_state`; a desktop closed through several slots fires **once** for the latest missed slot on start (catch-up once), then resumes the schedule.
  - **Messages** (§10) fire the domain's `message:` triggers for the message's address.
  - **Storm guard.** More than `storm_limit` firings (workspace setting, default 25) from one trigger within one minute: the rest are `held` and the owner role gets one inbox item ("300 cases would start from Activate a site · Start them · Discard"); `kernel.triggers.release(trigger, decision, by)`.
  - **Who it runs as.** A triggered case's input provenance is `by: trigger:<workflow>#<n>`; its steps act for the trigger's `as` role (else the workflow's `owner`), so policy and approvals apply as for a person in that role.
  - `kernel.triggers.list()` → `TriggerSummary[]` (workflow, kind, plain description, last fired, next due, held count) is the **Automations** screen.

## 8. Hand-offs: block states (D75)

A state with a block and no step file. Blocks are additive `StateDef` fields; a state has at most one block, a step file, or neither (a wait state).

```yaml
states:
  qc:
    on: { approved: file, sent_back: start_fix }
  start_fix:
    start: { workflow: fix-rejected-document, with: { document: case.document, note: case.qc_comment } }
    on: { started: end }                                   # `started` comes at once
  file_it:
    call: { workflow: file-document, with: { document: case.document }, returns: { filed_id: document } }
    on: { filed: next, rejected: needs_person, failed: needs_person }   # the child's last event into `end`
  fan_out:
    for_each: { items: case.sites, as: site, call: { workflow: update-consent, with: { site: item } }, join: all }
    on: { done: review, failed: needs_person }             # join all | any | <N>
  collect_pack:
    wait_until: { record: case.site, condition: "start_up_pack_complete = 100%" }
    on: { met: approve }
    wait: { remind: 7d, timeout: 60d → needs_person }
```

- **start** starts a case of another workflow (its live version) with `with:` values (`case.<path>`, `item`, `record`, or a literal) and moves on with event `started` at once. Idempotent on `start:<runId>:<enteredSeq>:<state>:<n>`. The new case records `started_by: { runId, caseId, state }` (`mw.case_links` kind `started`). Independent afterwards: cancelling the parent leaves it.
- **call** starts a child the same way (kind `called`) and waits. When the child ends, the parent gets the child's **outcome**: the event that moved the child into `end` (e.g. `filed`); a child that stops sends `failed`. `returns:` maps child case fields into the parent case (provenance `system` with note "from <child workflow> case <id>"). Cancelling (stopping) the parent stops its called and fanned-out children that are still active.
- **for_each** over a `List` case field: one start or call per item (`item` names the element; `as:` names it in messages), joined on `all` (every child ended), `any` (the first), or a number N; it sends `done` (or `failed` when a call child failed and the join can no longer be met). `start` children need no join and send `started`.
- **wait_until** names a `Ref` case field (`record:`) and a condition on that record's entity. On entering the state, and on every entity event for that record (§7), the kernel evaluates it (as the system actor) and sends `met` once it holds (DBOS `send` with idempotency key `met:<runId>:<enteredSeq>`). `wait:` timers work as in any state.
- **Under the hood.** Block states are wait states for the run driver: it waits on `DBOS.recv('events')`. The commit that enters a block state writes an outbox row (`mw.run_outbox`: start child / evaluate wait), which the dispatcher performs and acknowledges; a child run that reaches `end` or stops writes an outbox row that sends its outcome to the parent with `DBOS.send(…, idempotencyKey)`. So every hand-off is exactly once across crashes.
- **Across domains:** a workflow of domain A may start or call a workflow of domain B only if B's `domain.yaml` lists A in `accepts_from` (`cross-domain-not-allowed`).
- **Policy doesn't leak, versions are pinned:** the child runs under its own policy and stays on the version it started on.
- **Checks** (`memwise check`): the target workflow exists; `with:` keys are start fields of the target's case with compatible types; `returns:` names fields of both; the state's `on:` names only events the block can send (`started`; `met`; `done`/`failed`; the child's possible outcomes and `failed` for `call`); call cycles (A calls B calls A) are errors (`call-loop`); a `wait_until` condition compiles against the record's entity.
- **On screen:** the case view shows parent, children and started cases (`CaseView.links`); the map draws block states with a dashed edge to the other workflow.

## 9. Regulated mode (D77)

A domain with `regulated: true`:

- **Signed person steps.** A person step may say `sign: "Reviewed and approved for filing"` (any domain; required to be a person step: `sign-on-non-person-step`). `submitStep` then needs `signature: { password }` (or, later, an SSO re-authentication): the kernel verifies the person's password; five failures in 15 minutes lock the account for 30 minutes (`mw.auth_events`, `mw.people.locked_until`); every attempt is logged. The signature (`mw.signatures`): id, step run, person id and name, server time, the meaning, the record it covers (the step's `review.record`, else the first `Ref<Document>`-typed read), and `content_hash = sha256(canonical { entity, record_id, file sha256 if any, values after the step's writes })`. A signature can't move: it names one record and one hash. The record page shows each signature and "changed since signed" when the record's current content hash differs. Agents never sign: no tool signs, and an agent step can't have `sign:`.
- **Signed transitions.** `transitions.<t>.signed: true` is refused unless the case making it holds a signature on the record whose hash matches now (`signature-required`).
- **Reasons.** In a regulated domain every person edit of a controlled field needs a reason (refused without one); step writes get the generated reason (§3).
- **One person per login.** `MwStatus.canActAs` is false when any domain is regulated; the desktop owner's "act as" is refused by the server.
- **Passwords** in a regulated workspace are at least 12 characters; personal tokens of people who sign expire after 12 hours idle (open point: SSO with MFA on hosted).
- **Audit export.** `kernel.audit.record(entityKey, id)` → `AuditTrail` (the record, every version with its hash and the chain check, signatures, the cases and step runs that touched it, flags); `kernel.audit.export(entityKey, id, format: 'json' | 'pdf')` → bytes. The PDF is a plain, paginated rendering of the same (title page, version table, signature manifest, chain result). The TMF Reference Model exchange format is an open point.
- **Retention**: `domain.yaml retention` is recorded and shown; nothing in a regulated domain can be deleted by the app role (no delete grants anywhere on domain tables).
- **Draft → live** of a workflow in a regulated domain needs the change-playbook review step to be signed (the publish tool refuses without a signature on that review).
- **Validation pack.** `memwise validation-report <project> [--out report.md]` runs every workflow's example cases (as `memwise test`) and writes a report: the engine version, every workflow version and hash, each example's result, and the checks. The release attaches the exit tests' results (open point: the CI job that builds it).

## 10. Incoming messages (D76)

- **One intake address per domain** (`domain.yaml intake.address`). Messages reach the core as a Phase 5 webhook with purpose `email-inbound:<domain>` (scheme `hmac-sha256`), posted through the relay (`/h/<hookId>`) by an email service's inbound hook (open point: a Cloudflare Email Worker that forwards mail for `<address>@<install>.<relay domain>` to the hook). The body is JSON `InboundMessageBody`: `{ messageId, from, to, subject, text?, html?, receivedAt?, attachments: [{ filename, contentType, contentBase64 }] }`.
- The kernel stores each message once (`mw.inbound_messages`, unique `(domain, message_id)`), saves attachments as files, and fires the domain's `message:` triggers with `message` = `{ id, from, to, subject, text, receivedAt, attachments: DocumentValue[] }`. `kernel.triggers.receiveMessage(domain, body)` is the same entry for tests and other channels.
- The **router** is an ordinary workflow (`route-message` in the example) that reads the message and `start`s or `for_each`-starts the right case.

## 11. Review screens (D78)

- A person step may say how it is reviewed: `review: { kind: document, record: case.document }`, `{ kind: table, items: case.<List field> }` or `{ kind: diff }`. Without `review:` the renderer is chosen from what the step writes, as in [21 §9](21-domains-and-records.md): a step that reads a `Ref<Document>` (or `Document`) and writes fields of it → document; a write of `List<…>` → table; else form or decision card.
- **Document review is the record page in review mode.** `MwInboxItem` for such a step carries `review: { kind: 'document', entity, recordId }`; the inbox opens `kernel.records.page(entity, id, actor, { review: { stepRunId } })`, whose `RecordPage.review` holds: the proposed values (the case values the step writes, prefilled from the case, with their provenance, confidence, page and quote), the checks (the last agent step's checkpoint results and flags, with evidence), the outcomes, and whether signing is required with its meaning. After the step, the record's fields are what was signed, and the buttons are gone.
- **Highlights come from quotes.** Extraction returns `{ value, confidence, quote, page }`; the viewer finds the quote in the PDF's text layer (pdf.js) and highlights its box. Text that isn't found is listed without a highlight. Scanned PDFs without a text layer show no highlights (OCR inside quarantine is an open point).
- **Table review** (`review.kind: table`): rows with accept, edit and reject, "accept all at or above 0.9", a why per row from the item's rationale, and a comment.
- **Diff review** for a change to a signed record or a definition: the record versions side by side, or the Phase 3 draft diff.
- **Queue mode** in the inbox: "Review in a row" opens the first item and, after each decision, the next of the same kind; keys `a` approve, `s` send back, `j`/`k` next/previous.

## 12. Kernel API additions (`@memwise/runtime`, `KernelPhase6`)

```ts
interface KernelPhase6 {
  readonly domains: DomainsService;   // list domains with counts, the workspace, grants
  readonly records: RecordsService;   // record pages, update, transition, query/views, tree, dashboards, notes, mentions
  readonly triggers: TriggersService; // list, release held firings, receive a message, sweep now (tests)
  readonly audit: AuditService;       // trail, chain check, export
}
```

Existing methods keep their signatures. Additive options: `SubmitStepInput.signature?: { password: string }` and `SubmitResult.status` gains `'signature-required' | 'signature-failed' | 'locked'`; `CaseView.links`; `InboxItem` input/decision kinds gain `review?` and `sign?`; new inbox kinds `flag` and `trigger-hold`; `KernelChange` gains `{ kind: 'records'; entity; recordId? }` and `{ kind: 'triggers' }`; `listEntities` accepts an entity key; `Person` gains `grants`. The types are in `packages/runtime/src/types.ts`.

## 13. App API (`packages/shared/src/protocol/memwise.ts`)

Channels (all `(workspaceId, input)`):

```
memwise:domains:list          ()                         → MwDomain[]
memwise:records:page          MwRecordPageInput          → MwRecordPage
memwise:records:update        MwRecordUpdateInput        → MwRecordWriteResult
memwise:records:transition    MwRecordTransitionInput    → MwRecordWriteResult
memwise:records:query         MwRecordQueryInput         → MwRecordQueryResult
memwise:records:tree          { domain, parent? }        → MwTreeNode[]
memwise:records:notes:save    { entity, id, body, reason? } → MwRecordWriteResult
memwise:pages:dashboard       { domain, pageId, params } → MwDashboard
memwise:views:list            { domain, entity? }        → MwView[]
memwise:views:save            MwView                     → MwView     (personal)
memwise:triggers:list         ()                         → MwTrigger[]
memwise:triggers:release      { trigger, decision }      → MwSubmitResult
memwise:audit:get             { entity, id }             → MwAuditTrail
memwise:audit:export          { entity, id, format }     → { name, mime, dataBase64 }
```

`memwise:cases:submit` takes `signature?: { password }`. Shapes mirror the kernel's (§12) without kernel types.

## 14. App screens

- **Sidebar**: the top half is cross-domain (Inbox, Cases, Playbooks, Pages, Automations, Chats, with a domain filter); below it, **Domains**, each expanding into Pages (the record tree and free pages), Playbooks, Entities and House rules. A regulated domain shows a small "Regulated" mark.
- **Record page** for any record, drawn from the layout: header with title, status and transition buttons, the areas and blocks, flags, and "History" (versions with who, when, why; signatures). Editable fields edit in place (with a reason in a regulated domain).
- **Entities** page per domain: the entity types, each with Records (a view: table or board, filter, sort, group, columns) and Definition (fields, types, where each comes from, who sees it, connections, lifecycle).
- **Dashboard** pages (TMF health): KPI tiles, tables, a heatmap.
- **Inbox**: document review opens the Document's page in review mode with the PDF and highlights, the proposed index values, checks, comment, and "Approve and sign" (the signing dialog: who you are signing as, the meaning, password). Table review. "Review in a row" queue mode.
- **Automations**: the trigger list, with held firings to start or discard.
- **Case view**: parent, called and started cases; a waiting `wait_until` shows the condition and the record's current value ("Start-up pack 90% of 100%").

## 15. Exit test

`packages/server-core/src/memwise/__tests__/phase6-exit.test.ts`, against a real Postgres with scripted models, the `examples/etmf` project (domains `etmf`, regulated, and `edc`), a Bun relay on a local port with the core connected:

1. EDC holds Site `US-012` named "Harbor Oncology, Boston"; the eTMF Site `US-012` is paired by `site_number` and shows that name through the link.
2. The study manager moves US-012 from `selected` to `activating` (`picked`); the `activate-site` workflow starts by its `entered: Site.activating` trigger and waits in `collect_pack` (`wait_until start_up_pack_complete = 100%`), at 90%: nine of ten expected start-up documents are filed, the PI CV isn't.
3. An email with `vogel-cv.pdf` arrives at the eTMF intake address through the relay webhook. The `route-message` router starts `file-document`; the agent (scripted) classifies and indexes it (artifact `Investigator CV`, site US-012, about Dr. Lena Vogel, document date, each with page and quote).
4. The TMF specialist opens the inbox item: the Document's page in review mode, with the proposed values and checks; a wrong password is refused and logged; the right one signs "Reviewed and approved for filing".
5. `file` transitions the Document to `filed` (a signed transition) and the matching expected document to `filed`; every change wrote a version, and the Document's chain verifies.
6. The Site's `start_up_pack_complete` is 100%, so `activate-site` moves on to `approve_activation` by itself.
7. The TMF health dashboard's completeness for US-012 reads 100%.
8. The CV's `expires_on` makes the `watch-expiries` date trigger list a next firing for that person; the automations list shows it.
9. The Document's audit trail exports as JSON and PDF, with the signature manifest; tampering with a version row (as superuser) makes `verifyChain` fail.

## 16. Storage API (`@memwise/db`), for the pieces that build on it

So the kernel pieces can be written beside the storage piece, `@memwise/db` exports these (names and shapes fixed; bodies are the storage piece's):

```ts
// naming (tables.ts)
entityTableName(def: EntityTypeDef | string): string             // '<domain>__<snake>'; a bare string = default domain
domainToolNames(def: EntityTypeDef | string): { create; get; update; transition; list }   // '<domain>.<snake>.<verb>'
applyDomainSchema(pool, entities /* by key */, opts: RlsOptions & { domains?: Record<string, DomainDef> }): Promise<string[]>
                                                                   // tables, renames, version + event triggers, views (calculated, followed), RLS

// conditions → SQL (conditions.ts)
compileCondition(ast: ConditionNode, ctx: { column(name: string): string | undefined; param(v: unknown): string }): string
                                                                   // throws ConditionCompileError(message, pos) for unknown names / bad types
evaluateCondition(db: Queryable, def: EntityTypeDef, entities, recordId: string, condition: string)
  : Promise<{ holds: boolean; values: Record<string, unknown> }>   // reads domain_read (RLS of db's actor); values = the names it read

// writes and reads (domain/entities.ts, PgEntityStore; pass a client from withActor)
create(db, def, values, opts: CreateEntityOptions & { reason?: string; id?: string }): Promise<string>
update(db, def, id, values, opts?: { reason?: string; expectedVersion?: number }): Promise<{ version: number; changed: string[] }>
transition(db, def, id, opts: { to: string; transition: string; reason?: string }): Promise<{ version: number; from?: string }>
get(db, def, id): Promise<StoredEntityRow | undefined>             // StoredEntityRow gains version, updatedAt, values incl. calculated + followed
query(db, def, entities, q: { filter?: string; sort?; group?; columns?; limit?; offset? })
  : Promise<{ rows: StoredEntityRow[]; total: number; groups?: { key: string | null; count: number }[] }>
aggregate(db, def, entities, a: { kind: 'count' | 'sum' | 'avg' | 'percent'; field?: string; where?: string; of?: string })
  : Promise<number | null>
withRecordContext(db, ctx: { reason?: string; via?: string; transition?: string; by?: string }): Promise<void>   // set_config(..., true)

// history and integrity (stores/records.ts)
PgRecordVersions.list(db, entityKey, recordId): Promise<RecordVersionRow[]>    // oldest first
PgRecordVersions.verifyChain(db, entityKey, recordId): Promise<{ ok: boolean; brokenAt?: number; message?: string }>
contentHash(input: { entity: string; recordId: string; fileSha256?: string; values: Record<string, unknown> }): string
PgSignatureStore.add(db, s: NewSignature): Promise<string>;  forRecord(db, entityKey, id); forCase(db, caseId); forStepRun(db, stepRunId)
PgEntityEvents.after(db, seq: number, limit: number): Promise<EntityEvent[]>;  latestSeq(db)
PgGrantStore.list(db, personId); set(db, personId, grants: Grant[])
PgPeopleStore.recordAuthEvent(personId, kind: 'signature-ok' | 'signature-failed' | 'locked', detail?)
PgPeopleStore.lockState(personId): Promise<{ lockedUntil?: string; recentFailures: number }>
PgNoteStore.get / save(db, entityKey, id, body, by) → version;  PgMentionStore.add / forTarget
PgFlagStore.raise(db, { entity, recordId, invariant, message }) / close(db, entity, recordId, invariant) / list(filter)
PgViewStore.listPersonal(db, personId, domain) / save;  PgPageStore (written pages) get / save / list
```

Tables owned by the storage piece (migration `0006_domains_and_records.sql`): `mw.grants`, `mw.record_versions`, `mw.signatures`, `mw.auth_events` (+ `mw.people.locked_until`), `mw.record_notes`, `mw.mentions`, `mw.record_flags`, `mw.views`, `mw.pages`, `mw.entity_events`:

```sql
create table mw.entity_events (
  seq        bigserial primary key,
  id         text not null unique,          -- evt_<ulid>
  entity     text not null,                 -- entity key
  record_id  text not null,
  kind       text not null,                 -- created | changed | entered
  data       jsonb not null default '{}',   -- { fields } | { state, from, transition }
  by         text,
  at         timestamptz not null default clock_timestamp()
);
-- written by the generated row trigger of every domain table, in the writing transaction;
-- `pg_notify('mw_changes', '{"kind":"entity"}')` on insert.
```

Tables owned by the flow piece (migration `0007_flow.sql`): `mw.event_deliveries`, `mw.trigger_firings`, `mw.trigger_state`, `mw.inbound_messages`, `mw.case_links`, `mw.run_outbox`, `mw.entity_timers`.

## 17. As built

Built as five parallel pieces (definitions, storage, records, flow, app) against this contract. Every kernel test, the server-core suite, the eight eTMF example cases (`memwise test examples/etmf`) and the exit test pass. Where the code differs from the sections above:

**Exit test.** It follows §15 with two changes. The nine documents filed before MemWise are created already `filed`, because only a playbook step may file an expected document. The scripted classifier names the test's own record ids, not the example's fixed ones. The CV's expiry is `cv_expires` on the Person. Writing the test found a Phase 5 bug: the relay dropped every `x-memwise-*` request header, so `hmac-sha256` webhooks were refused once they came through it. The relay now passes `x-memwise-signature` on.

**Definitions (§2, §4, §5, §7, §8).**
- `file-document` has two more system steps, `index` and `send_to_qc`, plus a `study` field. `file` ends with outcome `filed`.
- The Site's `approved` guard is only `start_up_pack_complete = 100%`. The invariant is `status = 'open' implies start_up_pack_complete = 100%`.
- A dashboard `percent`'s `of` is the denominator set.
- `returns:` maps parent field ← child field.
- A bare `item` in a hand-off means `{ item: '' }`.
- A plain status list becomes a lifecycle with a `to_<state>` transition per state.
- A transition with no `by` defaults to `[step, role:owner]`.
- `related` also accepts `versions` and `signatures`.
- The duration unit `y` is a year of 365 days.
- `memwise check` always binds the entity tools, and it warns that per-domain plugin bindings are not supported yet.
- Index ids are `<domain>/<id>`. Policy ids are `workspace`, `domain` and `domain:<id>`.
- `loadWorkflow` keeps `starts_on`.

**Start fields.** A case may start with three kinds of field:
- fields people write;
- the one Ref no step writes (the record the case is about);
- any field a step reads that no step writes, such as the file a router hands on.

Example cases settle block states through the flow's dispatcher.

**Storage (§3, §16).**
- A field named `version` or `updated_by` is stored in column `fld_<name>`.
- The app role may only select `mw.record_versions` and `mw.entity_events`. A `SECURITY DEFINER` row trigger writes them, so nothing else can forge a version. The primary key of `mw.record_versions` is `(entity, record_id, version)`.
- The hash and `verifyChain` are computed in Postgres (`mw.record_hash`, `mw.canonical_json`). The signature's `contentHash` is computed in TypeScript.
- `mw.by` wins over the actor. A step's write without a reason gets "step <run>".
- Creating a record that has a lifecycle also emits `entered` (from null), so `entered:` triggers fire for records created in that state. A `changed` list names the lifecycle `status`. A rollup parent's `changed` list includes the formulas that depend on that rollup.
- The reason rule (regulated domains) applies only to a person's update of a controlled field. Fields are controlled unless `controlled: false`. Transitions and system writes need no reason.
- Record scope applies when every one of the person's grants in that domain is scoped. A scoped entity is filtered by its own id. Step tokens are not scoped.
- A new `domain_step_update` policy lets steps update records. The kernel passes `updaters: domainUpdaters()`, so only steps whose tools include `.update` or `.transition` for an entity may update its table. It also passes the domains, so a regulated domain's reason rule is compiled into the row trigger as well as checked in TypeScript.
- Conditions:
  - `!=` compiles to `is distinct from`, and `x = null` to `is null`;
  - dividing by zero gives null;
  - `date + number` adds days;
  - a rollup `percent` is unrounded, and null when there are no rows.
- Followed fields carry `_link__<table>`, which surfaces as `StoredEntityRow.followed`.
- `PgFlagStore.list(db, filter)` takes a connection. `raise` returns `{ id, raised }`. Flags carry their domain.

**Records, regulated mode and audit (§6, §9, §12).**
- It is `kernel.audit.trail()`, not `audit.record()`.
- The per-domain policy applied at run time is read from a row the kernel writes at index (`domain_policies`), so removing a policy file takes effect.
- A dashboard's table or list is narrowed by each page parameter that names one of the entity's fields.
- Link pairing with no match makes no candidate; the records pair later, when a matching record appears. Several matches each go to the domain owner as an identity candidate.
- A signed step with no record to cover signs the case answer (`entity: 'case'`). Only person steps sign.
- Values a person corrects while reviewing are written onto the reviewed record in the same transaction as the signature, with the reason "corrected at review", so the record is what they signed.
- What a signature covers leaves out fields with an `access:` list. Not everyone who checks a signature can read those fields, and the same record must hash the same way for all of them.
- A person may write a field with an `access:` list only when they hold one of its roles.
- A person changes grants only in domains they own (the domain's owner role).
- Signing locks after 5 wrong passwords within 15 minutes, a sliding window: someone guessing slowly is not locked out.
- The `signature-ok` sign-in event is written in the submit transaction.
- A value a person sends back exactly as the case has it keeps its provenance, the Phase 5 rule for external answers applied to person steps too. A review screen sends every value, so approving the agent's reading leaves it "read by the agent" and only corrections are the person's.
- The page tree shows entity types that have no parent and no children as top-level groups. A group of more than 25 records opens a view.
- Mentions are written on the kernel's own connection.
- Passwords are at least 12 characters in a regulated workspace.
- The desktop owner holds every role the project defines, and an existing owner gains any role the project added since, on each start. With "act as" refused in a regulated domain, the owner otherwise could do nothing there.
- Someone with no password yet (the desktop owner) chooses one at their first signature: signing answers `password-not-set`, and the sign dialog asks for a new password twice, saves it (`memwise:people:password:set`) and signs. Changing a password later needs the current one.
- Publishing a playbook of a regulated domain needs change-playbook's approving review to be signed.
- `memwise validation-report <project>` writes the validation pack.
- The audit PDF comes from a small writer with no dependencies.

**Flow (§7, §8, §10).**
- The dispatcher is a loop whose state is in tables, not a DBOS workflow, so the DBOS journal doesn't grow without end:
  - the cursor is in `mw.trigger_state`, under `dispatcher`;
  - each consumer is recorded in the `mw.event_deliveries` ledger, with 5 tries;
  - an advisory lock means one dispatcher per database.

  Exactly once comes from the ledger, idempotent keys and run ids derived from them.
- The order of consumers is records (link pairing, invariant flags), then waits, timers and triggers.
- Extra columns:
  - `trigger_firings`: `values`, `acts_for`, `decided_at`;
  - `case_links`: `outcome`, `ended_at`, `child_workflow`;
  - `event_deliveries`: `error`;
  - `notifications`: `entity` and `record_id`, with a nullable `run_id`;
  - `runs`: `acts_for`.
- `mw_changes` gains the kind `flow`. `StepToken` gains `actsFor`. The machine's states gain the kind `block`.
- A `changed` trigger fires when any field it lists changed, or on any change when it lists none.
- A child's outcome that the parent's state can't take stops the parent with a plain reason. A child busy in a long agent step stops at its next wait.
- Incoming email has its own ledger consumer (`email-inbound`), plus a sweep after a crash. A message that keeps failing is given up on after 5 tries in a process, and its error is recorded.
- A lifecycle timer's transition must allow `system` in its `by` (`memwise check`: `timer-not-allowed`).
- Held firings show in the inbox for the playbook's owner role, else for its domain's owner, the same rule `triggers.release` uses.
- A kernel with no project folder reads domains from the indexed definitions.
- Identity links for entities in a named domain are keyed by the entity key (`etmf.Site`), in Phase 4's code too.

**App (§13, §14).**
- Two channels were added, `memwise:files:read` and `memwise:people:password:set`. The protocol also gained `MwEntityType.definition`, `MwDomain.detail`, `domain` on playbook and case summaries, `MwSubmitResult.retryAfter`, and the client-side code `sign.cancelled`.
- Navigation:
  - The top items are Inbox, Cases, Playbooks, Pages, Automations and Chats.
  - The domain filter on the inbox, cases and playbooks shows only when a list spans more than one domain.
  - The Domains section has no middle list. When a project has only the default domain, the Domains section and the filters stay hidden.
- The top "Pages" item opens a cross-domain overview that includes the workspace's own pages. "Automations" opens the playbook triggers; the earlier chat automations moved under it.
- Document review shows inside the inbox, with no new route. The queue groups items by review kind, playbook and step.
- The walkthrough against a real server (screenshots in the project files, `phase-6-walkthrough/`) fixed:
  - record titles in place of ids in tables, boards, dashboards, related rows, case values and proposed values;
  - shared views, whose files name the entity without its domain;
  - `related: [versions, signatures]` in a page layout, which shows the history and signatures blocks;
  - case names, condition-wait wording ("Waiting for a condition"), formatted percentages, enums and dates;
  - grouping, board cards and the Status column on the Entities screen.
- Diff review is a stand-in: the inbox item carries no record versions yet, so it compares a form step's prefill with what the step read.
- Small gaps:
  - a record group such as "Sites · 7" opens the entity's full list without the parent filter;
  - "Ask in chat" on a record isn't wired;
  - starting a playbook from a record doesn't prefill the record;
  - only the first viewer block's file loads.

**Not done yet.**
- Record reminders are written but not shown in the inbox.
- After an `any` or N join is met, the remaining `for_each` children keep running.
- Followed fields used in a rollup's `where` don't send parent events when the linked record changes.
- Record scope doesn't follow the parent chain.
- Deletes write no version.
- Mentions from step rationales and chats are not stored.
- Personal sign-in doesn't expire after 12 hours idle.
- Playbooks drafted inside `domains/` are not covered by Phase 3 authoring yet.
- Per-domain plugin bindings are not supported.
- The eTMF flow shows no quote highlights on the PDF: quotes come only from a reader tool's fields (`page`, `quote`), and the classify step writes by judgement. The example needs a reader tool, or judgement writes need to carry a page and quote.
- An admin can't set another person's password from the app; people choose their own at their first signature.
- Small things: the Missing documents view repeats the same text in two columns; the case diagram tags a condition wait with a role; the inbox chip calls a document review "Form"; the bundled Postgres needs a manual `chmod` when the server runs as root.
- These need real accounts or decisions:
  - incoming email on a real address (a Cloudflare Email Worker in front of the relay webhook);
  - SSO with MFA for signing;
  - WORM storage for regulated files;
  - a TMF exchange format for import and export.
