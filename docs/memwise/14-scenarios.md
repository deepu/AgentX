# 14 · Reference scenarios

These scenarios stress-test the design. Scenario 1 is the first workflow to build *(Decided: internal users first)*.

## Scenario 1: Client intake with document extraction

> A worker sends a client a form. The client drops some files. The system extracts what it can and fills in the form, leaving fields empty when it isn't sure. The client checks and submits. An agent checks the answers, and a manager verifies.

### Pieces
- **Plugin:** "Client intake": tools `extract_fields` (`read`, quarantined) and `validate_gstin` (`read`), the `client-intake` workflow folder, an intake form and approval card, an intake dashboard.
- **Domain:** `Customer` and `Engagement` entities (the plugin's `Client` is bound to `Customer`). Case type `client_intake`.

### Shape

```
Prepare request (staff) ──sent──▶ Client fills form (client) ──submitted──▶ Check answers (agent, guided)
                                    ▲     │ remind 3d · timeout 7d                │checked   │needs_info
                                    │     ▼                                       ▼          │
                                    │  Needs a person ──resolved──▶ Check    Verify (manager, approval)
                                    │                                          │approved   │sent_back
                                    └──────────────── sent back with comments ─┴───────────┘
                                                                               ▼
                                                              Onboard (system, no model)
```

### How each step works
1. **Prepare request:** the worker picks the client. The core issues a single-use, expiring link, delivered by email or WhatsApp through the relay.
2. **Client fills form:** generated from the step's declared writes. When the client drops files, they become `Document`s on the case, and the form calls `extract_fields`, which the step's policy allows even though the run is waiting on the client. Extraction runs as quarantined reading and returns a value, confidence and source per field. Only confident fields are pre-filled, each with a "from invoice.pdf" badge. The client edits and submits.
3. **Check answers (agent, guided, step engine):** compares typed and extracted values, calls `gst.validate_gstin` (required), may call `recall.customer_history`, and writes flags citing documents. If it needs the client, it takes `needs_info`. If it wants to email the client, the email is `outbound` from a tainted session, so it waits for approval.
4. **Verify (manager):** an approval card with the case, flags and provenance. Approve, approve with edits, or send back with comments, which re-opens step 2 with values kept and comments shown.
5. **Onboard (system):** writes approved fields to `Customer` through the mapping, creates the `Engagement`, sends notifications. No model.

### What it demands
| Demand | Provided by |
|---|---|
| A participant who isn't a user | External links and the relay |
| A tool call while the run waits on a person | Component actions allowed by the step's policy |
| Field-level trust | Provenance and confidence on case values |
| Documents with hidden instructions | Quarantined reading; taint; `outbound` needs approval |
| Deadlines and reminders | DBOS durable timers |
| Send-back loop | Statechart cycles |
| No double emails after a crash | Journal and idempotency keys |

The first build is a simplified version for **internal users only** (the "client" step done by staff); external links and the relay follow.

## Scenario 2: Creating a connector (the meta case)

> "Add Linear as a source."

Today's source setup recast as a meta workflow in the "Connectors" plugin:

```
Understand need (agent ↔ person) ─▶ Research service (agent, open) ─▶ Configure (agent, strict)
  ─▶ Test (system: source_test) ─fail─▶ Configure
  ─pass─▶ Authenticate (person: OAuth or key via the vault) ─▶ Write guide (agent)
  ─▶ Classify tools (agent proposes effect classes, person confirms) ─▶ Bind to domain ─▶ Done
```

The playbook becomes step instructions, "ask the user" moments become human steps, and the new connector's tools get effect classes before any workflow can use them.

## Scenario 3: Technical analysis with Python

> An analyst wants daily technical screens on a watchlist, using Polars.

- **Plugin:** "Technical analysis": tools `compute_indicators` and `backtest` (`read`, Python), environment `python 3.12` with `polars` and a lockfile, requires the `market_data` capability, ships a "Daily screen" workflow and a "Screen results" page.
- **Shape:** Scheduled 08:00 → Fetch data (system) → Screen (system) → Interpret (agent, guided) → Analyst review (person, choice card) → Record decisions (system).
- **Demands:** managed environments; ad hoc analysis in a sandbox with the plugin's environment, recorded in the step record; pages over domain queries.

## Scenario 4: A long-running release loop

> A release loop that waits for commits, gates, builds, releases, sends failures to a fixer agent, and escalates to a person.

A workflow that never finishes, mostly mechanical, with one agent state and one human state, and every failure on an explicit path. The live map is the monitor. Running for a month with only a couple of restarts is the reliability bar, which is what durable timers and journaled sessions are for.

## Scenario 5: Swapping a CRM

> The business moves from CRM A to CRM B.

1. Install CRM B, which provides the same `crm.contacts` capability.
2. Bind it: mappings from CRM B to the existing `Customer`; field ownership moves.
3. Identity resolution links CRM B records to existing customers.
4. Impact analysis: no workflow changes, because workflows reference `Customer`, not CRM A.
5. Uninstall CRM A after cut-over.
