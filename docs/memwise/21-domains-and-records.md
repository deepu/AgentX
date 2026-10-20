# 21 · Phase 6: domains and records

What Phase 6 of the [build plan](17-build-plan.md) adds, as agreed with the project owner on 20 October 2026. Decisions are D70–D78 in the [decision log](15-decisions.md).

**Where it came from.** We tried MemWise on a regulated vertical, an **eTMF** (electronic Trial Master File) for clinical operations, and mocked up its screens: [eTMF mocks](https://claude.ai/artifact/3CHZqLXTKtSUtzbd8gHAX4). Comparing the mocks with Phases 0–5 found seven things that no phase builds. Some of them were already sketched in [04](04-domain-and-data.md) and [05](05-workflows.md) but never planned. Phase 6 builds all seven.

**Why after Phase 5.** Most of it reuses earlier phases:
- linked entities reuse the Phase 4 mappings and identity resolution
- table review comes from the Phase 4 binding flow
- document review extends the Phase 5 extraction badges
- email triggers need the Phase 5 relay

Phase 3 is not changed, by the owner's choice. Records written before Phase 6 are migrated by it (§3, §8).

Vocabulary: the UI says **playbook**; code, files and these docs say **workflow** (as in [19](19-phase-2-interfaces.md)).

## 1. Workspaces and domains *(Decided, D70)*

- A **workspace is the organisation**. It holds:
  - people and roles
  - installed plugins and their credentials
  - model settings and billing
  - house rules that apply everywhere
- A **domain is one area of work** with its own vocabulary, such as eTMF, Client intake or Safety reporting. It holds its own:
  - entity types
  - workflows
  - pages
  - policy
- A workspace holds **many domains**. This replaces the earlier "a workspace attaches one domain" ([02](02-concepts.md)) and D51's one domain per install.
- **Roles are defined at workspace level and granted per domain.** A grant can also be limited to some records, for example "TMF specialist in eTMF, for sponsor Aster Bio only", because a CRO's sponsors must not see each other's data. Grants compile into the same RLS settings as D46, with a domain and an optional record scope added.
- **Plugins are installed once, in the workspace** (code and credentials), and **bound per domain**, and optionally per workflow. The binding is per domain because it maps onto that domain's entities ([06](06-plugins-and-tools.md)). One Veeva connector can feed eTMF one way and EDC another.
- **Policy layers gain a workspace layer:** workspace → plugin → domain → workflow → step, still tighten only (D30).

Files:

```
project/
  workspace.yaml            roles, workspace house rules
  domains/
    etmf/
      domain.yaml           name, links to other domains (§2)
      entities/*.yaml
      workflows/<id>/…
      pages/…               free pages (§4)
      views/…               shared views (§4)
      policy.yaml
    intake/…
```

The sidebar follows the same split:
- **The top half is cross-domain:** Inbox, Cases, Workflows, Pages, Chats, each with a domain filter.
- **Domains sit below it.** Each one expands like a Notion teamspace into Pages (its record tree), Workflows, Entities and House rules.

## 2. Linked entities across domains *(Decided, D71)*

Two domains can each have their own entity for the same real thing, for example Site in EDC and in eTMF. Each keeps its own fields, and a **link** keeps the shared ones in step.

```yaml
# domains/etmf/entities/site.yaml
entity: Site
links:
  edc.Site:
    match: [study, site_number]     # records are paired automatically by this key
    follow: [name, address, principal_investigator, status]
fields:
  tmf_complete: { type: Percent, rollup: … }   # eTMF's own fields
```

- **Each shared field has one source.** eTMF's `name` follows EDC's `name`; nothing syncs the same field both ways.
- **Followed fields are read through the link, not copied,** so they can't drift. In the following domain they are read-only, like fields a plugin owns (D10).
- **Records are paired by the match key.** A record that matches nothing, or matches more than one, goes to a person, using Phase 4's identity resolution.
- **Another domain is just another source.** This is the same machinery as plugin mappings ([04 §5](04-domain-and-data.md)), so it is built once.

## 3. Storage: typed tables named by domain *(Decided, D72)*

- **Each entity type stays a generated, typed table** (D47), named `domain.<domain>__<entity>`, for example `domain.etmf__site`. All domains share the one `domain` schema; there is no schema per domain.
- **Not one generic JSON table, Notion style.** Typed tables keep:
  - real indexes and constraints
  - fast rollups (7,000 expected documents per study)
  - per-field access through column grants

  Notion's flexibility is in its interface, which §4 provides.
- **The table count on hosted** (many workspaces × dozens of entities) is handled by hosting, with a database per tenant or sharding ([12](12-state-and-packaging.md)), not by weakening the model.
- **Migration:** Phase 2's `domain.<entity>` tables move to `domain.<domain>__<entity>`, and the entity tools become `<domain>.<entity>.create` and `.get`.

## 4. Record pages, views and rollups *(Decided, D73)*

**Every record gets a page, generated from its entity definition.** Nobody builds record pages. They are drawn on request from the layout and the record's data, never stored.

- **The page always shows every field the viewer may see.** That's the `details` block, which is always present. The layout only decides placement: header fields, order, grouping, and a "More" fold. Only access rules hide a field.
- **The layout is structured, not free flow.** It has one of three shapes:
  - `single`
  - `split`: two halves, e.g. a document beside its fields
  - `sidebar`: main plus a narrow side column

  Blocks from a fixed set go into named areas: `fields`, `details`, `viewer`, `related`, `cases`, `lifecycle`, `chart`, `checks`, `notes` and `start` (start a workflow here). With no `page:` section an entity gets a default layout. Every record of a type looks the same, the agent can write and check layouts by chat, review mode (§8) has known places to put things, and split and sidebar stack on a phone. Custom blocks are MCP App components.

```yaml
# domains/etmf/entities/document.yaml
page:
  layout: split
  header: [title, artifact, status, site]
  left:
    - viewer: file
  right:
    - fields: [artifact, study, site, about, document_date, version]
    - checks                  # review mode only
    - details
    - related: [versions, signatures]
  below:
    - mentions
    - notes
```

- **Editing follows field ownership.** Fields a plugin or linked domain owns are read-only, with a link to their source. Fields the domain owns are editable in place. Status changes only through a lifecycle transition (§5).
- **Notes:** each record can have a free-flow notes block (Notion-style). Notes are data in Postgres, with history, under the record's access rules.
- **The page tree is the relationships.** Each entity type names one `parent` (Site → Study → Sponsor), and the domain's Pages tree walks those links. A new site from the CTMS appears in the tree by itself. Large collections show as one grouped entry ("Documents · 6,480") that opens a view.
- **Free pages** cover anything that isn't one record: dashboards such as TMF health, and written pages such as inspection prep notes. They hang anywhere in the tree. A dashboard is a definition (a file, [10 §4](10-experience.md)) whose numbers come from Postgres; a written page is data.
- **Views** are saved queries on one entity type: filters, sort, grouping, columns, and a table or board layout. Shared views are definitions (files); personal views are rows.
- **Calculated fields** come in two kinds:
  - **row formulas**, such as "days since activated"
  - **rollups across relationships:** count, sum, min, max or percent with a filter, such as `tmf_complete = filed ÷ expected`

  Both compile to SQL, so they're fast and respect RLS, and the checker validates them. There is no general formula language.
- **Mentions:** a record mentioned in notes, chat or a step record is stored as a reference, so renames carry through. Every record page has a "Mentioned in" section.

## 5. Lifecycles that act *(Decided, D74)*

[04 §3](04-domain-and-data.md) already says entity lifecycles use the workflow statechart mechanism. Phase 6 builds that. Today `lifecycle:` is only a list of states.

```yaml
lifecycle:
  initial: selected
  states:
    selected:   { on: { picked: activating } }
    activating: { on: { approved: open }, guard: { approved: "start_up_pack_complete = 100% and sponsor_approved" },
                  after: { 60d: remind(study_manager) } }
    open:       { on: { last_visit: closing } }
    closing:    { on: { archived: closed } }
    closed:     {}
  transitions:
    picked:   { by: [role:study_manager, source:ctms] }
    approved: { by: [step] }
invariants:
  - "status = open implies principal_investigator is set"
```

- **Who can move a record:** each transition names who may make it (a workflow step, a role, or a source like the CTMS).
- **Transitions go through the gateway** as a write, so they get policy, approval when required, and an audit record. Each one emits an event such as `site.entered(activating)`, in the same transaction as the change.
- **Entities don't name workflows. Workflows say what starts them** (§7). The record page lists them by reverse lookup.
- **Guards block a transition.** Invariants never block a write; a broken invariant raises a flag for a person. Otherwise a correct update from a source system would be rejected just because our data is behind.
- **Timers on states** work like workflow timers.
- **A plain list stays valid** and means "any role can move along it".

## 6. Workflows handing work to each other *(Decided, D75)*

[05 §6](05-workflows.md) names sub-workflows. Phase 6 builds four blocks:

| Block | What it does | Example |
|---|---|---|
| **start** | Start a case in another workflow and carry on. Idempotent, and the new case records who started it. | QC sends a document back, which starts "Fix a rejected document" |
| **call** | Run another workflow and wait. The child's outcome becomes the parent's event, and its outputs map back into the parent case. | Filing calls "Fix a rejected document" and resumes when the fix arrives |
| **for each** | Start or call once per item, then join on all, any or N. | Amendment 3 fans out to every site that needs a new consent form |
| **wait until** | Wait until a condition on a record is true, with a timeout. | "Collect the start-up pack" waits until `start_up_pack_complete = 100%` |

- **Prefer `wait until`.** Waiting on the data catches work that arrives by any route (email, upload, a chase). Waiting on child cases misses the work that came in another way. `wait until` re-checks on the record's change events, with no polling.
- **Policy doesn't leak.** A child runs under its own workflow's policy.
- **Versions are pinned.** A child starts on its workflow's live version and stays on it.
- **Cancelling** a parent cancels what it called or fanned out. Started cases are independent.
- **Across domains,** one workflow can start or call another only if the target domain allows it.
- **Checks:** `memwise check` verifies that inputs and outputs match between workflows and catches call loops.
- **On screen:** case pages show parent, child and related cases, and the map shows dashed edges to other workflows.
- **Under the hood:** DBOS child workflows and events, so all of it is durable.

## 7. Triggers *(Decided, D76)*

A workflow lists what starts it:

```yaml
starts_on:
  - entered: site.activating                      # an entity event (§5)
  - before: { field: person.cv_expires, by: 30d }  # a date on a record
  - every: 2w                                     # a plain schedule
  - message: { address: etmf }                    # an email, webhook or channel message
```

- **Date triggers** start one case per record per date. That's better than a weekly case that re-checks everything.
- **Messages:** one intake address per domain, feeding a small router workflow that classifies each message and starts the right case. That's better than an address per workflow.
- **Exactly once:** each firing has a key (trigger, record and date, or message ID).
- **Catching up:** a desktop that was closed runs each missed firing once.
- **Storm guard:** above a limit, for example a bulk import that would start 300 cases, MemWise holds the cases and asks in the inbox before starting them.
- **Who it runs as:** a triggered case runs as the workflow's `owner` role, so policy and approvals still apply.
- **Screen:** the existing Automations screen becomes the list of all triggers.

## 8. Regulated mode *(Decided, D77)*

Regulated mode is a switch on a domain, for GxP work such as eTMF (21 CFR Part 11, EU Annex 11, ALCOA+). Other domains don't pay for it.

**E-signatures**
- A person step can require one: `sign: "Reviewed and approved for filing"`.
- Signing means re-authenticating (password, or SSO with MFA). Repeated failures lock the account and are logged.
- **What's stored:** name, person ID, server time, the meaning, and a hash of exactly what was signed (the document hash plus its index values). A record that later differs shows "changed since signed". A signature can't be moved to another record.
- **Agents never sign.** Their work is credited through the step record. A regulated domain's policy can require a signed person step before a GxP record is written.

**Records that can't be changed**
- In every domain, each record change becomes a version row with who, when and why. Regulated mode makes a reason required for controlled fields.
- **Postgres enforces it:** the app role can't update or delete history rows, and history entries are hash-chained, so tampering shows. This builds [04 §8](04-domain-and-data.md)'s event log, and Phase 6 migrates existing records into it.
- **Timestamps come from the server only.**
- **Files** are already stored by hash. Hosted storage adds write-once object locking.

**Export and retention**
- The audit trail exports per record and per study, readable (PDF) and machine-readable, plus the TMF Reference Model exchange format.
- Retention is configurable, for example 25 years for trial records.

**Accounts**
- One person per login: the desktop "act as another person" (D51) is off in regulated mode.
- Password rules, lockout and session timeout. SSO with MFA on hosted.

**Validation pack**
- Each release ships a validation report built from the exit tests and example cases.
- Customers validate their own workflows by trying them on past cases.
- In regulated mode, the draft → live change ([08](08-policy-and-control.md)) needs a signature.

## 9. Review screens *(Decided, D78)*

Person steps keep being drawn from their schema (D45). The renderer is chosen by what the step writes:

| Writes | Renderer |
|---|---|
| A record | form (Phase 2) |
| Outcomes only | decision card (Phase 2) |
| A `Document` plus fields from it | **document review**: the record's page in review mode |
| A list of records | **table review**: filter, accept all high-confidence, row accept/edit/reject, a "why" per row, comments |
| A change to a definition, or to a signed record | **diff review** |

- **Document review is a page mode, not a separate screen.** The inbox opens the Document's record page (§4) with three things added: the agent's proposed values as a draft, the checks with links to their evidence, and the outcome buttons. After approval the draft becomes the record's fields and the buttons go away, so what was signed is what was filed. The Document record exists from the moment the file arrives, and its lifecycle runs received → indexed → in QC → filed.
- **Highlights come from quotes, not model coordinates.** Quarantined reading (D49) returns each value with its page and a short quote, and we locate the quote in the PDF's text layer to get the highlight box. Scans are OCR'd inside quarantine first.
- **Queue mode in the inbox:** keyboard-first approve-and-next, for someone checking forty documents in a row.

## 10. Exit test

The eTMF scenario, end to end, in a regulated domain:

1. A principal investigator's CV arrives by email at the eTMF address for a site that is activating.
2. The router starts a filing case, and the agent classifies and indexes the CV.
3. A TMF specialist reviews it on the Document's page and signs.
4. The document is filed and its version history is hash-chained.
5. The site's `start_up_pack_complete` reaches 100%, so its activation case, waiting with `wait until`, moves on by itself.
6. The TMF health page shows the change.
7. The site's EDC record supplies its name through a link, and an expiry trigger for the CV is scheduled.
8. The audit trail for the document exports with the signature record.

## 11. What this changes

- **[02](02-concepts.md):** the workspace and domain concepts are updated to match §1.
- **D10** still holds (each domain owns its model), with links between domains (D71).
- **D47:** tables are renamed by §3.
- **D51** (one domain per install) is replaced by D70.
- **[16](16-open-questions.md) item 7** (several domains per workspace) is settled.
- **[17](17-build-plan.md):** "Multi-domain workspaces" leaves "Deliberately later". The old Phase 6 (server, hosting and learning) becomes Phase 7.

## 12. Open

- **Test versus live:** this was previously "two workspaces sharing a domain". With domains inside a workspace, it could be a domain copy or an environment flag.
- **eTMF first:** whether the first eTMF build is native (MemWise as the TMF system of record) or connected to Veeva Vault. Both sit on the same entities and workflows.
- **Value types:** whether regulated mode needs its own (e.g. `SignedDocument`) or reuses `Document` plus a signature record.
