# 04 · Domain and data

The domain is the business's model of its world: one connected, typed store where everything that matters can refer to anything else. Plugins are the libraries, workflows are the business logic, and the domain is the data model.

## 1. Why one store

Business software scatters data: customers in the CRM, invoices in accounting, tasks in a workflow tool, documents somewhere else. Questions that cross those systems become integration projects.

In MemWise, entities, cases, step records, comments and files sit in **one Postgres database with typed references**, and every definition is indexed beside them. Hard questions become lookups:

- "All open cases for Acme, and where each one is stuck."
- "Which workflows, pages and policies use `Invoice.due_date`?" This is the impact analysis run before any change.
- "Every step last month where a person corrected an extracted value." This is the input for learning.
- "Chat with this step" loads one step record and everything linked to it.

## 2. Definitions are files, instances are rows *(Decided)*

| Definitions: files in the project folder | Instances: rows in Postgres |
|---|---|
| Entity types (fields, relationships, lifecycles, rules) | Entity records, or identity links to records held by plugins |
| Workflows (`workflow.yaml`, `steps/*.md`) | Runs and cases |
| Case types (`case.yaml`) | Step records and traces |
| Mappings and plugin bindings | Comments, corrections, attachments |
| Policies | The event log |
| Component and page templates | Page data |

- **Files are the source of truth for definitions.** Chat, the app and the CLI all write the same files, so every change has a diff that can be reviewed, and a domain can live in git.
- **Postgres indexes every definition** (by name, version and references) so the runtime, impact analysis and pages can query them.
- **Instances pin the definition version** they were created under. A case started under workflow v3 still makes sense after v4 ships.

## 3. Entity types

| Part | Example | Why it matters |
|---|---|---|
| **Fields** made of value types | `Customer.name: PersonName`, `Customer.credit_limit: Money` | Type safety without a global schema |
| **Relationships** | Customer has many Invoices | Workflows and pages follow links instead of re-fetching |
| **Lifecycle states** | Invoice: Draft → Sent → Overdue → Paid | State changes become **business events** that start workflows |
| **Rules** | "A GSTIN must be valid" | Every workflow and page inherits them |
| **Field ownership** | `Customer.email` owned by the CRM, `Customer.risk_score` by the domain | Decides where writes go |
| **Field-level access** | Bank details visible to Finance only | Enforced everywhere, chat included, through RLS and column policies |

Entity lifecycles use the same statechart mechanism as workflows. "When an invoice becomes Overdue, start the follow-up workflow" is a trigger in business terms.

Postgres tables for entity types are **generated** from the definitions, so the business never writes DDL.

```yaml
# domain/entities/customer.yaml
entity: Customer
fields:
  name:         PersonName
  gstin:        Identifier(GSTIN)
  pan:          Identifier(PAN)
  credit_limit: Money
  bank_account: { type: Text, access: [finance] }
relationships:
  engagements: many Engagement
lifecycle: [prospect, active, dormant, closed]
ownership:
  email: crm          # the CRM plugin owns this field
```

## 4. Value types

Only these small types are standardised across all domains and plugins:

| Value type | Notes |
|---|---|
| `Text`, `Number`, `Boolean`, `Enum` | Basic types |
| `Money` | Amount plus ISO currency; never a bare float |
| `Date`, `DateTime`, `Duration` | Always time-zone aware |
| `Percentage`, `Quantity(unit)` | |
| `PersonName`, `Email`, `Phone`, `Address` | Country-aware formats |
| `Identifier(kind)` | GSTIN, PAN, VAT and so on, with pluggable validators |
| `File`, `Image`, `Document` | Stored in the object store, referenced from rows |
| `TimeSeries` | `(time, value)` points |
| `Ref<EntityType>`, `List<T>` | Typed references and lists |

## 5. Mappings: plugins → domain

Plugins keep their own schemas. Each plugin is mapped **once** into the domain, so the number of mappings grows with plugins, not with pairs of plugins.

1. **An agent drafts it** in the "bind a plugin" meta workflow, from field descriptions and sample data.
2. **A person reviews it**, with sample values, confidence and gaps ("your Customer has no `tax_id`: add it or leave it unmapped?").
3. **It is validated** on sample records, including a round trip for two-way fields.
4. **It is frozen** as deterministic transformation code. No model runs when it's used (P1).

A mapping covers field-to-field links with transformations, entity-to-entity links, direction (read, write or both; writes go to the field's owner), and unmapped fields, which are kept under the plugin's namespace (`crm.*`), never dropped.

**Store links, not copies.** By default the domain stores identity links plus the fields it owns, and reads plugin-owned fields live through the mapping, with caching. A domain can choose to materialise data (for analytics), and the mapping becomes a sync job.

## 6. Identity resolution

"Acme Ltd" in the CRM and "ACME Limited" in accounting are the same customer. The domain keeps an **identity link table** (domain entity ↔ each plugin's record ID).

- Deterministic matching first (tax ID, email), a model only for fuzzy matches.
- Confident matches link automatically under a policy threshold; uncertain ones go to the inbox.
- Corrections are logged and improve future matching.

## 7. Cases

A case type is defined next to its workflow, from domain types:

```yaml
# workflows/client-intake/case.yaml
case: client_intake
fields:
  customer:        Ref<Customer>
  engagement:      Ref<Engagement>
  pan:             Identifier(PAN)
  gstin:           Identifier(GSTIN)
  annual_turnover: Money
  documents:       List<Document>
  flags:           List<Flag>
  status:          Enum[draft, submitted, checked, approved, rejected]
```

- Every value carries **provenance**.
- A case can create or update entities. When intake is approved, its fields are written to `Customer` through the mapping and field ownership.
- Cases are queryable like any record: by entity, state, person or age.

## 8. History

- The **event log** is append-only in Postgres, with one event per change to any row. It gives audit trails, "as of last Tuesday" views, undo and the triggers that start workflows.
- Definition history is the project folder's history (git where used) plus the version index in Postgres.
- Change control for definitions is in [08](08-policy-and-control.md).

## 9. Access and privacy

- Field-level access is declared on entity types and compiled into Postgres RLS and column policies, so it applies to people, agents (through step tokens), pages and chat alike.
- Sensitive values are hidden in traces and step records shown to people without access.
- External participants see only the slice of one case their step exposes.

## 10. Open

- Default for linking versus materialising plugin data, especially for analytics.
- The first value-type catalogue, and whether country-specific identifier validators are plugins.

See [16](16-open-questions.md). Several domains per workspace and links between them are settled in [21](21-domains-and-records.md).
