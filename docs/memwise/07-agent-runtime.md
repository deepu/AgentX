# 07 · Agent runtime

The agent runtime is the kernel: the part that makes agent work dependable. It treats agent sessions like processes in an operating system: they get context, system calls (tools), permissions and durable state.

## 1. Two engines *(Decided)*

Today's code has two agent backends, the Claude Agent SDK and Pi. Both run their loop **in a subprocess**: the Claude backend calls the SDK's `query()`, which owns the whole loop, and Pi runs as a separate process. The host sees tool calls but never each model call. Per-call journaling is impossible with them.

So MemWise has two engines:

| | Open engine | Step engine |
|---|---|---|
| **What** | The existing Claude SDK and Pi backends | Our own small loop on `pi-ai` (the Pi model library already in the repo, 20+ providers) |
| **Used for** | Chat, open investigation, coding-style steps | Strict and guided workflow steps |
| **Durability** | At the effect boundary: external calls are journaled at the MCP client pool; the model side resumes from the SDK's own session | Every model call and every tool call is a DBOS step, so it resumes mid-thought and replays exactly |
| **Policy and tools** | Same gateway, same policy | Same gateway, same policy |

Strict steps need the step engine, because only a loop we own can guarantee which calls happened and in what order. Open steps may run on either.

## 2. Durable sessions on DBOS *(Decided)*

Making the workflow durable isn't enough. An agent inside a step can run for an hour and send emails along the way. If the process dies halfway, retrying the whole step sends the email twice. So the session itself is durable.

**DBOS** (a library that keeps durable workflow state in Postgres) instead of Temporal: no extra cluster, the journal lives in the same database as everything else, and it fits the "it's just Postgres" packaging.

```
10:02  model → "read the uploaded documents"        journaled
10:02  tool  extract_fields(invoice.pdf) → result    journaled
10:03  tool  send_email(client, key=a91f)            sent once, key stored
10:03  worker crashes
10:04  new worker replays the journal: no model calls, no re-send     resumed mid-thought
10:05  agent needs the manager's answer                               hibernates, costs nothing
+2 days answer arrives, injected into the session                     resumes
```

Rules:
- **One DBOS workflow per step execution.** Inside it, each model call and each tool call is a DBOS step.
- **Statechart state lives in our own tables**, not in DBOS. DBOS runs steps; the run engine owns the shape.
- **Idempotency keys on every external effect**, passed to the provider where it supports them and recorded in the journal, so even an effect whose result was lost isn't repeated blindly.
- **Hibernate on human waits.** A session waiting on a person holds no worker and no model; the answer arrives as a DBOS event.
- **Versioning.** A session resumes on the code version it started with. DBOS's application versioning has to match our definition versions; this is part of the first spike.
- **Bun.** DBOS's TypeScript library must run under Bun, which the server uses today. Also part of the first spike.

## 3. Context and recall *(Decided)*

There is **no separate memory primitive for workflows**. What people mean by memory decomposes into things MemWise already has:

| "Memory" | Where it lives |
|---|---|
| What happened before | Step records and traces |
| What we know about the business | The domain (entities and their history) |
| How we do things | Versioned step instructions and skills |
| What good looks like | Example cases |

Context for a step is assembled from two sources, and **both are recorded**, so "what did it see?" always has an exact answer:

- **Pushed:** what the step file declares: instructions, the case fields it reads, linked entities, tool guides, earlier failed attempts. Kept within a token budget, in a stable order so prompts cache well.
- **Pulled:** **recall tools** the agent calls when it needs more: `recall.similar_cases`, `recall.customer_history`, `recall.step_record`. They're ordinary `read` tools: journaled, policy-checked, and they can be listed as **required** when a step must look something up.

**Chat is different.** A long-running chat does need continuity (summaries, what the person said last week). That stays a chat concern ([09](09-chat.md)), not a workflow primitive.

## 4. Tool and effect gateway

Tool calls are the agent's system calls. Every one, from either engine, goes through one gate that knows who is acting, what kind of effect the call has (see [06 §3](06-plugins-and-tools.md)) and what must happen first.

The code already has the two chokepoints this needs:

```
Agent (step engine, Claude or Pi) decides to call a tool
  → PreToolUse pipeline   packages/shared/src/agent/core/pre-tool-use.ts
       gains: policy, effect class, taint and budget checks
  → MCP client pool       packages/shared/src/mcp/mcp-pool.ts
       gains: journaling, idempotency, previews, secret injection, on-behalf-of identity
```

- **Secrets are injected at the gateway.** The model never sees a key or token.
- **On whose behalf:** each call carries the step token, and uses the person's delegated access where the tool supports it.
- **Previews:** for `draft`, `outbound` and `irreversible`, the gateway can produce exactly what will happen, for the approval card.

## 5. Model gateway *(Decided)*

**Every model call in the system goes through one gateway**, including plugins'. No plugin calls a provider directly.

```
step role "checker" → pick model and settings → check budget (step, run, workspace, org)
  → cache stable prefix → call provider (fall back if down) → meter and record
```

- Models are chosen by **role** ("checker", "extractor", "classifier"), not hard-coded. Changing the model behind a role is a proposal tested against example cases.
- Every call is recorded, which makes replay and evals possible.
- The meter is also what the hosted product bills on.
- It grows from today's per-session LLM connections, the Pi SDK's providers, the Cloudflare AI Gateway option and the usage tracker.

## 6. Trust boundary *(Decided: on by default)*

An agent that holds private data, reads untrusted content and can send messages can be tricked into leaking. The runtime breaks that combination automatically.

```
session reads a client's PDF or email → session tainted → outbound tools need approval
  → a person sees the exact message before it goes
```

- **Taint tracking is on by default.** Workflow authors won't remember to switch it on, and the failure is a data leak.
- **Quarantined reading:** untrusted documents are read by a separate model call with no tools that can only return schema fields. The working agent gets clean values, not raw text. Tools that read untrusted content declare `quarantine: true`.
- Taint is recorded in the step record and inherited by anything derived from tainted content.
- The decision service becomes the risk classifier (today's Guarded mode check).

## 7. Workspaces and sandboxes

- Each run gets a workspace: files, code execution and a browser. Today's session folders, script executor, browser tools and bundled Bun and uv are used as is.
- Workspaces are snapshotted to the object store, and promoted to case files when a step succeeds.
- Managed environments from plugin declarations come later ([06 §7](06-plugins-and-tools.md)).

## 8. Checkpoints and evals

- Outputs are validated against the case type and provenance rules before an outcome counts. Today's verify and repair logic (`VERDICT: PASS/FAIL`, outcome classification, repair scoping) moves into the checkpoint.
- Every human correction is a labelled example; example cases are the tests ([05 §12](05-workflows.md)).
- Shadow runs try a change without effects.

## 9. Interaction

- **Interrupts become inbox items.** When an agent needs a person, the session hibernates and an item appears in the inbox.
- **Steering:** a person can steer a running agent (today's mid-turn steering).
- **Sub-agents** get a share of the parent's budget and permissions, never more.
- **Case leases** stop two agents changing the same case at once.

## 10. What has to exist first

The smallest kernel that runs one trustworthy agent step:
- the step engine on `pi-ai`, with DBOS journaling and idempotency,
- the effect gateway with effect classes, at the two chokepoints,
- a thin model gateway (roles, budgets, recording),
- recorded context assembly and the first recall tools,
- step tokens, and
- output checkpoints.

Then: hibernate and resume for human waits, taint and quarantined reading, example cases as tests. Later: shadow runs, learning proposals, delegated credentials, earned autonomy, case leases.
