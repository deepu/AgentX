# 08 · Policy and control

The control rail runs beside every plane. Nothing in the work plane or the agent runtime is trusted to behave; the rail enforces it.

## 1. Identity and delegation

Today there are no users: the server has one shared token (`CRAFT_SERVER_TOKEN`). MemWise needs:

| Who | What |
|---|---|
| **People** | Signed-in users in an organisation |
| **Roles** | Named responsibilities (manager, partner, finance) that steps and policies refer to |
| **External participants** | Clients and vendors who act through scoped, expiring links |
| **Agent roles** | What an agent is doing ("intake checker"), separate from who it acts for |

**People and roles arrive in the first phase, minimally** *(Decided)*. Approvals and the inbox mean little without at least two roles. Outside participants come with external links.

### Step tokens

Every agent action runs under a short-lived **step token** naming the agent role, run, case, step and the person it acts for. The same token:
- is checked by the tool gateway,
- is read by Postgres row-level security, so the database governs agents as well as people, and
- appears in every journaled call, so every action is attributable.

Sub-agents get a token with a share of the parent's permissions, never more.

## 2. Policy layers *(Decided: tighten only)*

```
Plugin defaults   "extract_fields is rate-limited"      "payments over ₹1L need approval"
      ▼ may only narrow
Domain            "outbound messages need approval"      "bank details are Finance only"
      ▼ may only narrow
Workflow          "no irreversible actions in intake"   "total budget ₹50 per case"
      ▼ may only narrow
Step              "model role checker, 40k tokens, 10m" "only these four tools"
      ▼
Effective policy  what the step actually runs under, shown with the source of every rule
```

- **A layer can never loosen a layer above it.** Loosening a domain rule means changing the domain policy, which is its own proposal with its own approval. The checks in [05 §8](05-workflows.md) reject a step that tries.
- **The editor shows the effective policy** with the layer each rule came from.
- Workspaces can tighten further for their own people.

### What policies cover

- tools a step may call, and required tools,
- effect-class treatment (approval, preview, never automatic),
- data access, down to fields,
- approvals and who may give them,
- budgets: tokens, time, money,
- model roles and which models may see which data,
- where code may run and which network it may reach,
- taint behaviour.

### Compiled, never hand-written

Policy files are compiled into two enforcement points:
- **gateway rules**, evaluated on every tool call and component action, and
- **Postgres RLS and column policies**, keyed on the step token or the person's session.

Nobody writes RLS by hand, so the database rules can't drift from the policy files. Nothing depends on the agent behaving.

Today's permission modes (Explore, Ask, Guarded, Execute), `permissions.json` per source, source policy and page grants become **inputs** to the policy compiler.

## 3. Change control

Every definition (workflows, steps, case and entity types, mappings, bindings, policies, model-role assignments) follows one lifecycle:

```
Draft ─▶ Checked ─▶ Tested on example cases ─▶ Approved ─▶ Live (vN) ─▶ proposal for vN+1 ─▶ …
```

- **Live things change only through proposals.** Agents, plugin upgrades and improvement workflows can all propose; none can change a live definition directly.
- **Impact analysis** comes before approval. It follows references in the index: "renaming `Customer.gstin` affects 3 workflows, 2 pages, 1 policy and 14 open cases".
- **Running cases keep their version** unless the proposal includes an approved migration.
- **History** is the project folder's history plus the version index in Postgres; instance history is the event log.
- Who may approve which kind of change is itself policy.

## 4. Metering and budgets

- Fed by the model gateway and the sandbox runtime: tokens, compute time, money.
- Budgets at every level: step, run, workflow, workspace, organisation. Today there is a per-session token count and a task-level token budget.
- A step that hits its budget takes a designed outcome (usually "needs a person"), not a crash.
- The same meter drives billing in the hosted product.

## 5. Traces and replay

- Every journaled model and tool call, every step record and every event is queryable in Postgres.
- A run can be **replayed** from its journal, to explain what happened or to test a change against what really happened.
- Sensitive values are hidden in traces shown to people without access.
- Today's session JSONL, run logs, automation history and event logger give the starting vocabulary of event shapes.
