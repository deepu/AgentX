# 05 · Workflows and steps

## 1. Workflows are statecharts *(Proposed: a DAG is a special case)*

A workflow is a **state machine**, more precisely a statechart. That means:
- **States** are steps (domain checkpoints), plus waiting states.
- **Transitions** fire on **domain events or step outcomes**: "verified", "client submitted", "red", "timed out", "Invoice became Overdue".
- **Guards** are conditions on transitions: "amount > ₹5L → manager approval".
- **Context** is the **case**.
- **Parallel regions** hold independent branches that run at the same time.
- **Nested states** group sub-steps under one checkpoint.

### Why not a DAG
AgentX's task runner (the Conductor) runs a DAG: nodes with `depends_on`, run once, then done. Real processes don't look like that. They:
- **loop**: send back to the client, fix then re-check, retry after review,
- **wait**: for a person, an external event, or a date,
- **live a long time**: a release loop or a monthly close runs for weeks or forever,
- **route failures explicitly**: "timed out → Needs a person".

A DAG is just a statechart with no cycles, so existing `task.yaml` plans convert directly. Each node becomes a state, and each `depends_on` becomes an "on done" transition.

### Why not prose
A skill or markdown playbook *can* describe a process, but nothing enforces it: no checkpoints, no state you can inspect, and nothing to validate. Prose belongs **inside** states, as instructions, not as the structure.

### Reference example
Steve Ruiz's release loop, which ran for a month with about two restarts:

```
Waiting for commits ──new commit──▶ Gate ──green──▶ TestFlight build ──released──▶ Waiting
        │                             │ red                 │ failed
   promote (manual)                   ▼                     ▼
        ▼                         Fixer agent (opens PR) ◀──┘
 Production promotion                 │ PR opened
   (manual) ──verified──▶ Waiting     ▼
                                  Land fix ──merged──▶ Gate
                                      │ needs review / red / timed out / stalled
                                      ▼
                                Needs a person ──clear──▶ Waiting
```

Most of its states are mechanical (gate, build). One is an agent (the fixer), one is a person, and every failure has an explicit path. That's the shape MemBase workflows should take.

## 2. Steps are domain checkpoints *(Agreed)*

A step is something a domain expert recognises as **worth verifying, approving or handing off**: "Gather documents", "Assess risk", "Manager approval", "Notify client".

Computation, rule checks and tool calls are **not** steps. They happen inside a step. A domain expert never sees "call GST API" as a step. They see "Compute tax", which may involve several tool calls.

### Anatomy of a step

```yaml
- id: compute_tax
  title: Compute tax
  performer: agent            # agent | person | external | system
  instructions: |
    Calculate GST using the rate table for the client's state. Apply exemption
    categories from the client profile. Round per CBIC rule 32.
  strictness: strict          # strict | guided | open
  tools: [lookup_gst_rate, compute_gst]
  required_tools: [compute_gst]
  inputs:  { invoice: case.invoice, client: case.customer }
  outputs:
    gst_amount: { type: Money, provenance: tool }   # must come from a tool result
    notes:      { type: Text,  provenance: any }
  checkpoint:
    validate: [gst_amount >= 0]
    approval: none
  timeout: 10m
  on:
    done: review_invoice
    failed: needs_person
    timeout: needs_person
```

| Part | Purpose |
|---|---|
| **Performer** | Who carries out the step: an agent, an internal person, an external participant (a client or vendor), or the system (mechanical, with no agent) |
| **Instructions** | Written by the domain expert in their own language |
| **Strictness** | How much the agent may improvise (§3) |
| **Tools** | What may be called. `required_tools` must actually be called for the step to count as done. |
| **Inputs / outputs** | Typed reads from and writes to the case, with provenance requirements |
| **Checkpoint** | Validators, approval rules, or both, run before the step's outcome counts |
| **Transitions** | Where to go on each outcome, including failure and timeout |

## 3. Instructions and strictness *(Agreed)*

The real dial is how strict the instructions are, not what type the step is:

| Strictness | Meaning | Enforcement |
|---|---|---|
| **Strict procedure** | "Do exactly this, using these tools." | Required tool calls. Output fields marked `provenance: tool` must equal a tool result, and values the agent typed itself are rejected. No other tools. |
| **Guided** | "Review the documents, flag anything unusual, use the checklist." | Allowed-tools list, output schema validation, and a checklist that must be completed |
| **Open** | "Investigate why the totals don't match." | Output schema, a budget (tokens and time), and a reviewed checkpoint |

### Mechanical steps run without an agent *(Agreed)*
If a step's instructions are fully mechanical (a fixed sequence of tool calls with known inputs), the runtime runs it **directly, with no LLM**. The domain expert sees the same step. It's just faster, cheaper and deterministic.

The authoring meta workflow detects this case and proposes compiling the step to a mechanical one. This is principle P1: judgment at design time, code at run time.

## 4. Human and external steps *(Agreed)*

People are first-class performers.

| Kind | Example | Mechanics |
|---|---|---|
| **Approval** | "Manager approves onboarding" | An approval card in the inbox: approve, reject, or send back with comments |
| **Input** | "Client fills in the intake form" | A form component bound to the case type's fields (see [06](06-pages-and-ui.md)) |
| **Review** | "Partner reviews the risk memo" | A document component with comments. Comments feed back as repair context. |
| **Attention** | "Needs a person" | A generic hand-off when something fails, times out or is unclear |

Every human step has:
- **an assignee**: a role, a person, or an external participant,
- **a deadline and reminders**,
- **an escalation path**: after N days, notify the lead, or go to a different state, and
- **a channel**: the in-app inbox, email, or Telegram/WhatsApp through channel plugins.

**Questions from agents become human steps.** When an agent step can't proceed without information, it doesn't fail silently and doesn't stall. It moves to a designed "needs input" transition that creates an input or attention step. *(AgentX today treats an unattended subtask that asks a question as failed. The decision model's turn-outcome check does this, in `TaskRunner.ts` via `classifyNodeOutcome`.)*

## 5. Data flow between steps

- Steps read from and write to the **case**, never free text passed between steps. This fixes AgentX's current model, where each subtask receives earlier subtasks' final replies as text.
- Values are typed, and each carries **provenance**.
- Agent steps can still produce narrative outputs (a memo, notes), stored as `Text` or `Document` fields.
- Steps can read linked **entities** through the domain (for example the customer's history), subject to access policy.

## 6. Triggers

A workflow run starts from:
- **a person**: a "Start intake" button, or chat ("start an intake for Acme"),
- **a schedule**: cron, through the core scheduler,
- **a domain event**: an entity's lifecycle change ("Invoice → Overdue"), or a case reaching a state in another workflow,
- **an external event**: a webhook or new email, through a connector plugin,
- **another workflow**: as a sub-workflow, which is how composition works ("Onboard customer" calls "Create connector" or "Collect KYC").

Triggers can carry a **semantic condition** that a small classifier model evaluates ("only if the email is a quote request"). AgentX already has this for automations (`semanticCondition`).

## 7. Composition

- **Sub-workflows:** a state can invoke another workflow and wait for its outcome. The child gets its own case, linked to the parent case.
- **Reusable steps:** a step definition from a plugin, such as "Collect documents", can be dropped into many workflows.
- **Workflows that create workflows:** meta workflows (see [08](08-authoring.md)) use the same machinery.

## 8. Step records *(Agreed)*

Every step execution, whether by an agent, a person or the system, writes a step record:

| Field | Content |
|---|---|
| Identity | Run, case, step ID, attempt number, workflow and instruction **version** |
| Inputs | A snapshot of the case fields and entities it read |
| Environment | Model, tool versions, sandbox environment hash |
| Tool calls | Each call's arguments, result, duration and errors |
| Rules | Each rule or validator evaluated, and its result |
| Rationale | Short reasons at each **decision point**, captured *as the decision is made*, not reconstructed afterwards |
| Outputs | Values written to the case, each with provenance |
| Checkpoint | Validator results, approver, edits made at approval, comments |
| Cost | Tokens, time, money |

The step record does three jobs at once: **audit log**, **context for chat**, and **data for learning**.

## 9. Chat with a step *(Agreed)*

From the run monitor or the case view, a person can open a chat on any step. An agent is loaded with that step's record and linked records. It works the same for steps that ran without an agent.

| Mode | What it does | Changes data? |
|---|---|---|
| **Explain** (default) | "Why is this 18%?" → "Rule X matched because client type is Y (rule v3, evaluated at 10:02)." Answers cite the record, or say "not recorded". | No |
| **Correct** | Change an output. Affected downstream steps re-run through their normal checkpoints and policies. The correction is logged as a learning signal. | Yes, through the checkpoint |
| **What-if** | Re-run the step with changed inputs in a sandboxed copy of the case | No (sandbox only) |

**Guardrails:**
- Explanations must be grounded in the record, because an agent explaining after the fact would make up plausible reasons.
- Chat never changes the case silently.

## 10. Validation of workflow definitions

Machines can be checked in ways prose can't. A workflow can't be frozen until it passes these checks:
- Every state is reachable, and every non-final state has an exit.
- Every waiting or human state has a timeout and an escalation path.
- Every transition target exists, and every guard refers to valid case fields.
- Every step's inputs are produced upstream, or are case inputs.
- Tools referenced are available through the domain's bindings, and permitted by policy.
- Approval steps reference roles that exist.
- **Example cases** (§11) pass.

## 11. Testing and learning

- **Example cases:** a workflow carries a set of sample cases with expected outcomes. Changes to the workflow, its bindings or its calibrated settings must still pass them. This is the workflow equivalent of unit tests.
- **Learning from corrections:** every human edit at a checkpoint is a labelled example. Periodic improvement jobs (workflows themselves) can propose:
  - updated thresholds, such as which extracted fields to pre-fill,
  - better worked examples for agent instructions,
  - new or adjusted rules, and
  - compiling a frequently repeated agent pattern into a tool.

  All of these come as **proposals**, checked against the example cases and approved by a person.

## 12. Agents improving workflows

Agents can propose structural edits too: add a state, re-route a failure, split a step. They are reviewed as **diagram diffs**, with impact analysis, and frozen by a person. For business workflows, fully autonomous rewiring isn't allowed (principle P8).

## 13. Engine *(Open)*

Options are discussed in [11](11-open-questions.md):
- **XState v5**: TypeScript, able to save and restore a run's state, and comes with a visual editor.
- **A small custom engine.**
- **A durable execution engine underneath**: Temporal, or Cloudflare Workflows if hosted there.

The **definition format** is the important decision. The engine can be swapped behind it.
