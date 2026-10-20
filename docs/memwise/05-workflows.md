# 05 · Workflows and steps

## 1. Workflows are statecharts *(Decided)*

A workflow is a statechart:
- **States** are steps (domain checkpoints) and waiting states.
- **Transitions** fire on step outcomes, domain events or timers: "checked", "client submitted", "timed out", "Invoice became Overdue".
- **Guards** are conditions on transitions: "turnover > ₹5 Cr → partner sign-off".
- **Context** is the case.
- **Parallel regions** and **nested states** are allowed.

A DAG is a statechart without cycles, so today's Conductor `task.yaml` plans convert directly: each node becomes a state and each `depends_on` becomes an "on done" transition.

Real processes loop (send back, fix, re-check), wait (for a person, an event, a date), run for a long time (a monthly close, a release loop) and route failures explicitly ("timed out → Needs a person"). Prose can describe that but can't enforce it, so prose belongs **inside** steps.

## 2. One definition, many views *(Decided)*

A workflow is a folder of plain files. Everything else is a view of those files.

```
workflows/client-intake/
  workflow.yaml        # the shape: steps, transitions, waits, timeouts
  steps/
    prepare.md
    fill.md
    check.md           # typed front matter + instructions in prose
    verify.md
    onboard.md
  case.yaml            # the case type
  policy.yaml          # workflow-wide policy
  components/          # forms, approval cards
  examples/            # example cases with expected outcomes
```

- **The shape is small and strict** (`workflow.yaml`), so it can be checked by machine.
- **Each step is its own Markdown file**: typed front matter on top, instructions in the domain expert's own words underneath. Experts edit prose without touching structure.
- Chat, the app and the CLI all write these files. No view owns any data.

### The shape

```yaml
# workflow.yaml
workflow: client-intake
version: 4
case: ./case.yaml
start: prepare
steps:
  prepare: { on: { sent: fill } }
  fill:
    on: { submitted: check }
    wait: { remind: 3d, timeout: 7d → needs_person }
  check:
    on:
      checked:    verify
      needs_info: fill
      failed:     needs_person
  verify:
    on: { approved: onboard, sent_back: fill }
  onboard: { on: { done: end } }
  needs_person: { on: { resolved: check } }
policy: ./policy.yaml
```

### A step

```markdown
---
title: Check the client's answers
performer: agent            # agent | person | external | system
strictness: guided          # strict | guided | open
reads:  [case.pan, case.gstin, case.annual_turnover, case.documents]
writes:
  gstin_ok: { type: Boolean, from: tool gst.validate_gstin }
  flags:    List<Flag>
tools:
  allowed:  [gst.validate_gstin, intake.extract_fields, recall.customer_history]
  required: [gst.validate_gstin]
model: checker              # a model role, not a model name
budget: { tokens: 40k, time: 10m }
checkpoint: [every flag cites a document]
outcomes: [checked, needs_info, failed]
---
## What to do
Compare what the client typed with what was extracted from their documents.
Flag any mismatch, and say which document it came from.
```

| Part | Purpose |
|---|---|
| **Performer** | Agent, internal person, external participant, or system (mechanical, no model) |
| **Strictness** | How much the agent may improvise (§3) |
| **Reads / writes** | Typed access to the case and linked entities; writes carry provenance rules |
| **Tools** | Picked from tools bound to the domain; `required` must actually be called |
| **Model and budget** | A model role and limits, applied by the model gateway |
| **Checkpoint** | Validators and approvals run before the outcome counts |
| **Outcomes** | Named results; the shape decides where each one goes |
| **Instructions** | Prose, versioned with the step |

## 3. Strictness *(Decided)*

| Strictness | Meaning | Enforcement |
|---|---|---|
| **Strict** | "Do exactly this, with these tools." | Required tool calls. Outputs marked `from: tool` must equal a tool result. No other tools. Runs on the step engine. |
| **Guided** | "Review the documents, flag anything unusual." | Allowed-tool list, output schema, checklist. Runs on the step engine. |
| **Open** | "Investigate why the totals don't match." | Output schema, budget and a reviewed checkpoint. May run on the open engine. |

**Mechanical steps run without a model.** If a step is a fixed sequence of tool calls with known inputs, the runtime runs it directly. The authoring meta workflow spots this and proposes compiling the step (P1).

## 4. People in the workflow

| Kind | Example | Mechanics |
|---|---|---|
| **Approval** | "Manager approves onboarding" | Approval card: approve, approve with edits, reject, send back with comments |
| **Input** | "Client fills in the intake form" | A form generated from the step's declared writes |
| **Review** | "Partner reviews the risk memo" | Document component with comments; comments become repair context |
| **Attention** | "Needs a person" | A generic hand-off when something fails, times out or is unclear |

Every human step has an assignee (role, person or external participant), a deadline with reminders, an escalation path and a channel (inbox, email, WhatsApp, Telegram).

**Questions from agents become human steps.** An agent that can't continue without information takes a designed `needs_info` outcome, which creates an input or attention item. It never fails silently and never stalls. (Today's Conductor counts an unattended subtask that asks a question as failed.)

## 5. Data between steps

- Steps read and write the **case**, never free text passed along. (Today each subtask receives earlier subtasks' final replies as text.)
- Values are typed and carry provenance.
- Narrative outputs (a memo, a draft email) are `Document` fields on the case, linked from the step record.
- Linked entities are read through the domain, subject to policy.

## 6. Triggers and composition

A run starts from a person (a button or chat), a schedule, a domain event (an entity's lifecycle change), an external event (a webhook or email through a connector), or another workflow. Triggers may carry a **semantic condition** evaluated by the decision service ("only if the email is a quote request"), as automations already do.

- **Sub-workflows:** a state can invoke another workflow and wait for its outcome. The child gets its own case, linked to the parent.
- **Reusable steps:** a step file from a plugin ("Collect documents") can be used in many workflows.

## 7. How it runs *(Decided)*

```
files ──check──▶ compiled statechart (XState v5) ──▶ run on DBOS
                                    │                    │
                                    │      each step = one DBOS workflow
                                    │      inside it, every model and tool call = one DBOS step
                                    ▼
                    policies compiled into the tool gateway and Postgres RLS
```

- **Our own format, XState underneath.** The format keeps performer, strictness, tools and checkpoints first-class. XState v5 executes the shape and is checkable; it stays swappable behind the format.
- **Statechart state lives in our tables**, with one DBOS workflow per step execution. Timers and waits are DBOS durable sleeps and events, so "remind in 3 days" survives restarts.
- See [07](07-agent-runtime.md) for the engines and journal.

## 8. Checks before anything goes live

A workflow can't be published until it passes:
- every state is reachable, and every non-final state has an exit,
- every waiting or human state has a timeout and an escalation,
- every transition target exists, and every guard refers to valid case fields,
- every step's reads are produced upstream or are case inputs,
- every tool is bound in the domain and permitted by policy,
- no step loosens a policy set above it,
- approval steps reference roles that exist,
- the example cases pass.

Checks run continuously while editing, so problems show as you type.

## 9. Views *(Decided)*

| View | For | Notes |
|---|---|---|
| **Playbook** | Domain experts (the default view) | The workflow read as a document: numbered steps, who does each, instructions, and what happens on failure. Editing a paragraph edits that step's instructions. |
| **Map** | Seeing the shape and monitoring | The statechart drawn left to right, failure paths below. Drawn as SVG with a small layered layout of our own while it is view only (D50); React Flow and ELK when it becomes editable. Mermaid export. Three modes: **design**, **live** (cases per step, one case's path highlighted) and **proposed change** (a diff: added in green, changed in amber). **View only at first**; shape changes go through chat or the editor. |
| **Step editor** | Changing a step | One card: instructions with strictness, reads and writes, tools (with effect class and source plugin), effective policy (each rule labelled with the layer it came from), checkpoint and outcomes. Chat sits beside it. |

The notation borrows a few ideas from BPMN (performer lanes, timer events, error paths) without its complexity.

## 10. Editing by hand or by chat *(Decided)*

- Every edit, by hand or by chat, goes into a **draft**. The live version never changes in place.
- A chat edit shows in the editor as **highlighted changes** (an instruction sentence, a new output, a new required tool) with the check and example-case results. The person keeps or discards it.
- The agent can only offer what's available: tools bound in the domain and fields in the case type. If something is missing, the chat proposes installing a plugin or adding a case field as part of the same change.

### From draft to live

```
Draft ─▶ Checked (structure, types, tools, policy) ─▶ Tested (example cases) ─▶ Approved ─▶ Published as vN
```

Cases already running stay on the version they started with unless the change includes an approved migration.

## 11. Step records and chat with a step

Every step execution writes a step record:

| Field | Content |
|---|---|
| Identity | Run, case, step, attempt, workflow and instruction version |
| Context | Exactly what was assembled for the agent, including recall results |
| Environment | Model role and model, tool versions, sandbox hash |
| Calls | Each journaled model and tool call: arguments, result, duration, errors, effect class |
| Rules | Each rule or validator evaluated, with its result |
| Rationale | Short reasons captured at each decision point, as the decision is made |
| Outputs | Values written to the case, with provenance |
| Checkpoint | Validator results, approver, edits at approval, comments |
| Cost and taint | Tokens, time, money; whether the session was tainted and by what |

A chat on a step can **explain** (grounded in the record, or "not recorded"), **correct** (an output changes and downstream steps re-run through their checkpoints) or run a **what-if** in a sandboxed copy. Chat never changes a case silently. See [09](09-chat.md).

## 12. Testing and learning

- **Example cases** live in `examples/` and run on every change to the workflow, its bindings, its policies or the model behind a role.
- **Every correction** at a checkpoint is a labelled example, and can be saved as a new example case.
- **Improvement workflows** propose better instructions, thresholds, rules, or compiling a repeated pattern into a tool. They arrive as proposals checked against the example cases.
- **Shadow runs** try a new version beside the old one, without effects.
- Agents may propose structural edits too, reviewed as map diffs. Business workflows are never rewired autonomously (P13).
