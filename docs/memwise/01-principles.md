# 01 · Vision and principles

## The problem

Most business processes live in three places:
- people's heads,
- a few SaaS tools, and
- loose documents describing "how we do X".

Traditional software can capture them, but only after a product team designs every screen, field and rule in advance. Agents can now do most of the individual tasks in a process. What's missing is a **structure** that makes agent work reliable, reviewable and reusable in the terms of the domain itself.

| Approach | What goes wrong |
|---|---|
| **Fixed software** (CRMs, ERPs, internal tools) | Rigid and slow to change. Every new need is a feature request. |
| **Prompt-only agents** (skills, markdown playbooks) | Flexible, but nothing holds the shape. No checkpoints, no structured data, no audit trail, and hard to verify. |

## The vision

**A domain expert should be able to turn their process into working software by talking to an agent.** The result should be as dependable as conventional software where that matters, and as flexible as an agent where judgment is needed.

- Their process becomes a **workflow**: a statechart of steps they recognise.
- Their business data becomes a **domain**: entities they define, mapped onto the tools they already use.
- Their screens are **pages and components**, generated rather than built in advance.
- Capabilities arrive as **plugins**.
- All of it can be created and changed through **chat**, by hand, or from the CLI, with people approving whatever matters.

## Agents aren't apps

The architecture starts from what is different about agent work. An app backend (Supabase, Firebase, a Rails app) assumes the left column. Agent work is the right column, and every row creates a need the runtime has to meet.

| An app backend assumes | Agent work is actually | So the runtime needs |
|---|---|---|
| A developer wrote every path | The agent chooses its path as it goes | Checkpoints and policy around each step |
| Same input, same output | Usually right, sometimes wrong, never identical twice | Validation, example cases, learning from corrections |
| Requests last milliseconds | A step lasts minutes; a process waits days for a person | Durable sessions that journal every call |
| Inputs come from trusted code | The agent reads emails, uploads and web pages that may carry hidden instructions | A trust boundary: taint tracking and quarantined reading |
| Computation is nearly free | Every model call costs money and time | One model gateway with budgets and metering |
| The program carries its own knowledge | The agent knows only what it's given | Recorded context assembly and recall tools |
| The user is the actor | The agent acts on someone's behalf, often while they're away | Identity and delegation: step tokens, on-behalf-of |
| Logs are enough to debug | People need to know *why* it did what it did | Step records and traces you can talk to |
| Behaviour changes only with a release | It should improve from every correction | Proposals tested against example cases |

That is why the **agent runtime** sits at the centre of MemWise, not the data API. See [03 · Architecture](03-architecture.md).

## Principles

### P1. Judgment at design time, code at run time
When something can be decided once, an agent decides it while the thing is being authored, a person approves it, and it's stored as deterministic code or data: a field mapping, a calculation, a form layout. At run time it runs without a model. Agents work at run time only where real judgment is needed.

### P2. Steps are domain checkpoints, not units of computation
A step is something a domain expert would recognise as worth verifying, approving or handing off. Calculations, rule checks and tool calls happen *inside* steps. See [05](05-workflows.md).

### P3. Structure is explicit; behaviour inside it can be prose
The *shape* of a process is an explicit, checkable statechart: states, transitions, waits, timeouts and hand-offs. *Inside* a step, natural-language instructions are fine, from strict procedures to open investigation.

### P4. The run is the centre, not the session
In today's Craft Agents code the centre of everything is a chat session saved as files. In MemWise the centre is a **run**: a case moving through steps, stored in Postgres. A session becomes *how one step gets done*, or a chat anchored to something. See [13](13-from-craft-agents.md).

### P5. People are first-class participants
Approvals, form inputs, reviews and escalations are states in the workflow, not failures or side channels. An agent that needs an answer moves to a designed hand-off, never a silent stall.

### P6. Every effect is known before it happens
Every tool declares its **effect class** (read, draft, write, outbound, irreversible). Approvals, previews, budgets and earned autonomy all follow from it. See [06](06-plugins-and-tools.md).

### P7. Nothing is done twice, nothing is lost
Every model call and tool call inside a workflow step is journaled. A crash or a week-long wait resumes the agent mid-thought, and an email is never sent twice. See [07](07-agent-runtime.md).

### P8. Policy only tightens
Policy is layered: plugin defaults, then domain, then workflow, then step. Each layer may only narrow the one above. Loosening a rule means changing the layer that set it, through change control. See [08](08-policy-and-control.md).

### P9. Small trusted core, everything else is a plugin
Anything that enforces trust stays in the core, because a plugin can't police itself. Connectors, domain packs, dashboards and the authoring tools themselves are plugins.

### P10. The workspace's model, not the platform's model
There is no global business schema. Each domain owns its entity model and each plugin maps into it once. Only small value types (money, dates, addresses) are standardised. See [04](04-domain-and-data.md).

### P11. Definitions are files; runtime data is rows
Workflows, steps, case types, entity types, policies and plugin manifests are plain files in a project folder, so chat, the app and the CLI all edit the same thing and every change has a reviewable diff. Postgres indexes them and holds everything that happens at run time.

### P12. Everything leaves a record you can talk to
Every step leaves a step record: what it saw, what it called, why it decided, who approved. Anyone can open a chat on a step, a case or a workflow, and the answers are grounded in the record.

### P13. Proposals, not silent changes
Agents may propose changes to workflows, mappings, policies or models. Live definitions change only through a proposal, an impact analysis and an approval.

### P14. Ad hoc first, trusted later
Anything can start as a throwaway in chat and mature: **ad hoc → saved → reviewed and versioned → packaged as a plugin**. Only the later stages need full validation.

## What success looks like

- A person with no engineering background describes a process. Within a session they have a running workflow with a form, an agent step, an approval and a dashboard, on their own data.
- A month later it's still running. For any case, the record answers "why did this happen?" Every change went through a reviewable proposal.
- They swap one CRM for another and only a mapping changes. Their workflows don't.
- It runs on a laptop with no cloud account, on their own server, or on the hosted service, unchanged.
