# 09 · Reference scenarios

These scenarios were used to stress-test the design. Each one shows how the concepts fit together and what it demands from the core.

---

## Scenario 1: Client intake with document extraction

> A worker sends a client a form. The client drops some files. The system extracts as much as possible and fills in the form, leaving fields empty when it isn't sure. The client checks and submits. The worker verifies it.

### Pieces
- **Plugin:** "Client intake". It provides the `extract_fields` and `validate_gstin` tools, the `client_intake` workflow, the intake form and approval card components, and an intake dashboard page.
- **Domain:** `Customer` and `Engagement` entities (the plugin's `Client` is bound to `Customer`). The case type is `client_intake`.

### Workflow

```
Prepare request (worker) ──sent──▶ Client fills form (external) ──submitted──▶ Check (agent, guided)
                                       ▲      │ timeout (3 days → reminder; 7 days)         │
                                       │      ▼                                              ▼
                                       │   Needs a person                     Verify (worker, approval)
                                       │                                         │approve      │send back
                                       └──────────────── send back with comments ─────────────┘
                                                                                 ▼
                                                                    Onboard (mechanical: write Customer,
                                                                             create Engagement, notify)
```

### How each part works
1. **Prepare request:** the worker picks the template and the client. The core issues a **single-use, expiring link** and delivers it by email or WhatsApp.
2. **Client fills the form:** the form is generated from the case type's fields. When the client drops files:
   - the files become `Document` attachments on the case,
   - the form calls `extract_fields(files, schema)`, which the step's policy allows even though the run is waiting on the client,
   - the tool returns, for each field, a value, a confidence score and a source ("invoice.pdf p.2"),
   - only fields above the threshold are pre-filled, and the rest stay empty,
   - each pre-filled field shows a "from invoice.pdf" badge (provenance), and
   - the client edits and submits. The answers are validated against the schema.
3. **Check (agent, guided):** cross-checks extracted values against typed ones, validates GSTIN through a tool, applies rules, and writes flags to the case.
4. **Verify (worker):** an approval card showing the case, flags and provenance for each field. Choices: approve, approve with edits, or send back with comments. Sending back re-opens step 2 with the earlier values pre-filled and the comments shown.
5. **Onboard (mechanical):** writes the approved fields to `Customer` through the mapping, creates the `Engagement`, and sends notifications. No agent is involved.

### What it demands from the core
| Demand | Core capability |
|---|---|
| A participant who isn't a user | Scoped external links and public hosting of interactive forms |
| A tool call while the run waits on a person | Component actions allowed by the step's policy |
| Field-level trust | Provenance and confidence on case values |
| Documents may contain hidden instructions | `extract_fields` has no other tools, outputs schema fields only, and is rate-limited |
| Drafts, deadlines, reminders | Durable human steps with timers and escalation |
| Send-back loop | Statechart cycles |

### Learning
Every edit the worker makes in step 4 is a labelled example ("extraction said X at 0.8, a person changed it to Y"). An improvement workflow can propose a better pre-fill threshold or new worked examples for extraction. These are proposals, checked against example cases.

---

## Scenario 2: Creating a connector (the meta case)

> "Add Linear as a source."

This is AgentX's existing flow, recast as a meta workflow in the "Connectors" plugin.

```
Understand need (agent ↔ person) ─▶ Research service (agent, open) ─▶ Configure (agent, strict: schema)
        ─▶ Test (mechanical: source_test) ─fail─▶ Configure
        ─pass─▶ Authenticate (person: OAuth or key prompt via the vault) ─▶ Write guide (agent)
        ─▶ Bind to domain (sub-workflow: "Bind a plugin") ─▶ Done
```

What this shows:
- The `sources.md` playbook becomes step instructions.
- The "ask the user" moments become human steps.
- The "if the API is weak, use the browser" branch becomes a guarded transition.
- The new connector immediately goes through **binding**, so its data maps into the domain before any workflow uses it.

---

## Scenario 3: Technical analysis with Python

> An analyst wants daily technical screens on a watchlist, using Polars.

### Pieces
- **Plugin:** "Technical analysis".
  - **Tools:** `compute_indicators(series, [RSI, MACD])` and `backtest(strategy, series)`, written in Python.
  - **Environment:** `python 3.12`, `polars 1.x`, `numpy`, with a lockfile.
  - **Requirements:** a `market_data` capability (provided by a broker or TradingView connector plugin).
  - **Workflow:** "Daily screen".
  - **Page template:** "Screen results".
- **Domain:** `Instrument` and `Watchlist` entities, plus `TimeSeries` values.

### Workflow
```
Scheduled 08:00 ─▶ Fetch data (mechanical) ─▶ Screen (mechanical: compute_indicators)
     ─▶ Interpret (agent, guided: "explain notable setups, cite indicator values")
     ─▶ Analyst review (person: choice card per setup) ─▶ Record decisions (mechanical)
```

### What it demands
- **Managed environments:** the core builds the Python environment from the plugin's declaration and runs it in a sandbox. The plugin never manages the sandbox.
- **Ad hoc analysis:** "why did this underperform its sector?" makes the agent ask the core for a sandbox with the plugin's environment, write Polars code, and run it. The code and results go into the step record. Analysis that keeps recurring is proposed as a new tool.
- **Pages over the domain:** the "Screen results" page queries the cases and instruments directly.

---

## Scenario 4: A long-running release loop

> Steve Ruiz's release loop (see [05 §1](05-workflows-and-steps.md)).

What this shows:
- A workflow that **never finishes**. It cycles through waiting, building and releasing.
- Mostly mechanical states, with **one agent state** (the fixer) and **one human state** (needs a person).
- **Every failure has an explicit path**, with timeouts as transitions.
- The live diagram is the monitor.
- It ran for a month with about two restarts. That's the reliability bar.

---

## Scenario 5: Swapping a CRM

> The business moves from CRM A to CRM B.

1. Install the CRM B plugin. It provides the same `crm.contacts` capability.
2. **Bind** it. The agent proposes mappings from CRM B's schema to the domain's existing `Customer` entity. Field ownership moves from CRM A to CRM B.
3. Identity resolution links CRM B records to existing customers.
4. Impact analysis: no workflow changes, because workflows reference `Customer` and not CRM A. Two pages read only domain queries, so nothing changes there either.
5. Uninstall CRM A once the cut-over is verified.

This is the payoff of P6 (the domain owns the model) and of declaring dependencies by capability.
