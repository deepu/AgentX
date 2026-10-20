# 03 · Domain and data

The domain is the heart of the system. If plugins are the libraries and workflows are the business logic, the domain is the **database and the data model**: one connected store where everything that matters is a typed record that can refer to anything else.

## 1. Why one store

Normal business software scatters data: the CRM has customers, the accounting tool has invoices, the workflow tool has tasks, and documents live somewhere else. Questions that cross those systems become integration projects.

In MemBase, entities, workflow definitions, cases, step records, comments and files all sit in **one store with typed references**. That turns hard questions into simple lookups:

- "All open cases for customer Acme, and where each one is stuck."
- "Which workflows, pages and rules use `Invoice.due_date`?" This is the impact analysis run before any change.
- "Every step last month where a person corrected an extracted value." This is the input for learning and calibration.
- "Chat with this step" loads one step record and everything linked to it.

Pages become views over this store, and agents query one place instead of many.

## 2. Two layers *(Agreed)*

| Definitions | Instances |
|---|---|
| Entity types (fields, relationships, lifecycle states, rules) | Entity records, or links to records held by plugins |
| Workflow definitions (statecharts, step instructions) | Cases: one per run |
| Case types | Step records |
| Mappings and plugin bindings | Comments, corrections, attachments |
| Policies | Audit and change log entries |
| Page and component templates | Page instances and their data |

- **Definitions are versioned.** They change through proposals and approval (see §8).
- **Instances point to the exact definition version they were created under.** A case started under workflow v3 still makes sense after v4 ships. Its step records name the instruction version they ran with.

## 3. Entity types

An entity type is a business noun that the domain owner defines, usually through conversation (see [08](08-authoring.md)).

Each entity type has the following parts:

| Part | Example | Why it matters |
|---|---|---|
| **Fields** made of value types | `Customer.name: PersonName`, `Customer.credit_limit: Money` | Type safety without a global schema |
| **Relationships** | Customer has many Invoices, and an Invoice has one Document | Workflows and pages follow links instead of re-fetching |
| **Lifecycle states** | Invoice: Draft → Sent → Overdue → Paid | State changes become **business events** that start workflows |
| **Rules** | "A GST number must be valid", "changing a credit limit needs approval" | Every workflow and page inherits them |
| **Field ownership** | `Customer.email` is owned by the CRM, `Customer.risk_score` by the domain | Decides where writes go when several systems hold a field |
| **Field-level access** | Bank details are visible to Finance only | Enforced everywhere, chat included |

An entity's lifecycle is itself a small state machine, built with the same mechanism as workflows (see [05](05-workflows-and-steps.md)). "When an invoice becomes Overdue, start the follow-up workflow" is a trigger expressed in business terms, not as "a webhook from tool X".

## 4. Value types *(Proposed)*

Only these small types are standardised across all domains and plugins:

| Value type | Notes |
|---|---|
| `Text`, `Number`, `Boolean`, `Enum` | Basic types |
| `Money` | Amount plus an ISO currency, and never a bare float |
| `Date`, `DateTime`, `Duration` | Always time-zone aware |
| `Percentage`, `Quantity(unit)` | |
| `PersonName`, `Email`, `Phone`, `Address` | Country-aware formats |
| `Identifier(kind)` | For example a tax ID or GSTIN, with pluggable validators |
| `File`, `Image`, `Document` | Stored as attachments, with metadata |
| `TimeSeries` | Points of `(time, value)`, for analysis and charts |
| `Ref<EntityType>` | A typed reference to another record |

Business entities like "Customer" are **never** standardised globally. That's what keeps the system usable by any business.

## 5. Mappings: plugins → domain *(Agreed)*

Plugins keep their own schemas. A CRM plugin talks about `Client`, and an accounting plugin talks about `Party`. Each plugin is mapped **once** into the domain. The domain is the hub, so the number of mappings grows with the number of plugins, not with the number of plugin pairs.

### How a mapping is made
1. **An agent drafts it** as part of the "bind a plugin" meta workflow. It uses the plugin's field descriptions, any hints to well-known concepts, and sample data.
2. **A person reviews it.** They see each mapping with sample values, confidence, and gaps such as "your Customer has no `tax_id` field: add it, or leave it unmapped?"
3. **A person edits it where needed, then freezes it.** It is now stored as deterministic transformation code and data. No LLM runs when it's used.
4. **Validation runs on sample records** before freezing, including a round trip for two-way fields.

### What a mapping covers
- Field-to-field links, including transformations (split a name, convert a currency, normalise a date).
- Entity-to-entity links (the plugin's `Client` is the domain's `Customer`).
- Direction: read, write, or both. Writes go to the system that owns the field.
- **Unmapped fields are kept** under the plugin's namespace (`crm.*`), never dropped.

### Store links, not copies *(Proposed)*
By default the domain stores **identity links plus the fields it owns itself**, and reads plugin-owned fields live through the mapping, with caching. Copying every system's data into the domain would create a stale duplicate of everything. A domain can choose to materialise data (for example for analytics), and the mapping then becomes a sync job.

## 6. Identity resolution

"Acme Ltd" in the CRM and "ACME Limited" in accounting are the same customer. The domain keeps an **identity link table**: domain entity ID ↔ the record ID in each plugin.

- A matching step proposes links, with confidence scores. It uses deterministic matching first (a tax ID or email), and a model only for fuzzy matches.
- Confident matches link automatically, under a policy threshold. Uncertain ones go to a person through the inbox.
- Corrections are logged and improve future matching.

## 7. Cases

A **case type** is defined by a workflow and built from domain types:

```yaml
case_type: client_intake
fields:
  customer:      Ref<Customer>          # links to the domain entity
  engagement:    Ref<Engagement>
  pan:           Identifier(PAN)
  gstin:         Identifier(GSTIN)
  annual_turnover: Money
  documents:     List<Document>
  risk_memo:     Document
  status:        Enum[draft, submitted, verified, approved, rejected]
```

- Every value in a case carries **provenance** (see [02](02-concepts.md)).
- A case can create or update entities. When the intake is approved, its fields are written to `Customer` through the mapping rules and field ownership.
- Cases are queryable like any other record: by entity, by state, by person, or by age.

## 8. Versioning, freezing and change

Everything in the definitions layer follows one lifecycle:

```
draft ──▶ in review ──▶ frozen (vN) ──▶ proposal for vN+1 ──▶ impact analysis ──▶ approved ──▶ frozen (vN+1)
```

- **Frozen** means a definition changes only through a proposal. Agents, plugin upgrades and calibration jobs can all *propose*. None of them can change a frozen definition directly.
- **Impact analysis** comes before approval. It follows the references in the store to list everything affected: "renaming `Customer.gstin` affects 3 workflows, 2 pages, 1 rule and 14 open cases".
- **Migrations:** cases already in progress keep their pinned version, unless the proposal includes an explicit migration.
- **History:** an append-only change log records every change to every record. That gives audit trails, "as of last Tuesday" views, and undo.

## 9. Access and privacy

- Field-level access is defined on entity types and applied everywhere: queries, pages, step inputs, and chat with a step.
- Values marked sensitive are hidden in logs and in step records shown to people without access.
- External participants, such as a client filling in a form, see only the slice of one case that their step exposes (see [06](06-pages-and-ui.md)).

## 10. Storage shape *(Proposed)*

- **Engine:** relational. SQLite for a local single-user setup, Postgres on a server.
- **Layout:** typed tables for the hot paths (entities, cases, step records, the change log), plus JSON documents for flexible fields. Every reference is explicit and typed (`Ref<T>`).
- **Change log:** append-only, with one event per mutation. The current state can be rebuilt by replaying it.
- **Files:** stored in object storage (local disk or S3-compatible), and referenced from records.
- **Export:** a domain can be exported as definitions plus, optionally, instances. That makes a domain a shareable, portable "app".

## 11. Relation to AgentX today

| Need | AgentX today |
|---|---|
| A typed store for entities and cases | None. Workspace data is mostly files and JSONL. |
| Run state | `tasks/<slug>/runs/<runId>/run-log.jsonl` plus node output JSON files (`packages/shared/src/tasks/storage.ts`) |
| Per-page data | A SQLite store per page and `snapshot.json` (`packages/shared/src/pages/`) |
| Project memory | `projects/{slug}/MEMORY.md`, append-only for agents |
| Value types and validators | None as a shared concept |

The domain store is new work. AgentX's existing file layouts can be migrated into it gradually (see [10](10-agentx-gap-analysis.md)).
