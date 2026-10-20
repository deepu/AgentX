# 01 · Vision and principles

## The problem

Most business processes live in three places:
- people's heads,
- a few SaaS tools, and
- loose documents describing "how we do X".

Traditional software can capture them, but only after a product team designs every screen, field and rule in advance. Agents can now do most of the individual tasks in a process. What's missing is a **structure** that makes agent work reliable, reviewable and reusable in the terms of the domain itself.

Today there are two broad approaches, and each fails in its own way:

| Approach | What goes wrong |
|---|---|
| **Fixed software** (CRMs, ERPs, internal tools) | Rigid and slow to change. Every new need is a feature request. |
| **Prompt-only agents** (skills, markdown playbooks) | Flexible, but "like shaping markdown Play-Doh and hoping it holds". No checkpoints, no structured data, no audit trail, and they're hard to verify. |

## The vision

**A domain expert should be able to turn their process into working software by talking to an agent.** The result should be as dependable as conventional software where that matters, and as flexible as an agent where judgment is needed.

Concretely:
- Their process becomes a **workflow**: a state machine of steps they recognise.
- Their business data becomes a **domain**: entities they define, mapped onto the tools they already use.
- Their screens are **pages**, generated on demand instead of built in advance.
- Capabilities arrive as **plugins** that can be mixed and matched.
- All of it is created, inspected and changed through conversation, with people approving whatever matters.

## Principles

These came out of the design discussions and are used throughout the other docs.

### P1. Judgment at design time, code at run time
When something can be decided once, an agent decides it while the thing is being authored, a person approves it, and it's stored as deterministic code or data. Examples are a field mapping, a calculation or a form layout. At run time it runs without an LLM. Agents work at run time only where real judgment is needed.

### P2. Steps are domain checkpoints, not units of computation
A step is something a domain expert would recognise as worth verifying or approving. Calculations, rule checks and tool calls happen *inside* steps, not as separate steps. See [05](05-workflows-and-steps.md).

### P3. Structure is explicit; behaviour inside it can be prose
The *shape* of a process is an explicit, checkable state machine: its states, transitions, waits, timeouts and human hand-offs. *Inside* a state, natural-language instructions are fine, ranging from strict procedures to open investigation.

### P4. People are first-class participants
Approvals, form inputs, reviews and escalations are states in the workflow, not failures or side channels. An unattended agent that stops to ask a question shouldn't be treated as broken. That moment should be a designed hand-off to a person.

### P5. Small trusted core, everything else is a plugin
The core is a microkernel. It does only what must be trusted: running workflows, storing data, enforcing policy, holding secrets, sandboxing code and hosting UI. Connectors, dashboards, domain packs, and even the tools that create plugins are all plugins. See [07](07-core-runtime.md).

### P6. The workspace's model, not the platform's model
There is no global schema every business must follow. Each domain owns its entity model, and each plugin maps into it. Only small value types (money, dates, addresses and so on) are standardised globally. See [03](03-domain-and-data.md).

### P7. Everything leaves a record you can talk to
Every step that runs leaves a structured trace. It records what it saw, what it called, why it decided what it did, and who approved what. People can chat with any step, and the answers are grounded in that record.

### P8. Proposals, not silent changes
Agents may propose changes to workflows, mappings, rules or calibrated settings. Frozen things change only through a proposal, an impact analysis and an approval. Plugin defaults can be tightened by the domain, never loosened by a plugin.

### P9. A fixed shell, generated content
A few surfaces are fixed and polished because everything depends on them:
- the inbox of things waiting on you,
- the case view,
- the run monitor,
- chat with a step, and
- the design system.

Everything shown inside them can be generated.

### P10. Ad hoc first, trusted later
Anything can start as a throwaway created in chat. Useful things mature along a path: **ad hoc → saved → reviewed and versioned → packaged as a plugin**. Only the last stages need full validation and tests.

## What success looks like

- A person with no engineering background describes a process. Within a session they have a running workflow with a form, a few agent steps, an approval and a dashboard, all on their own data.
- A month later the workflow is still running. The audit trail can answer "why did this happen?" for any case. Changes have gone through reviewable proposals.
- They swap one CRM for another, and only a mapping changes. Their workflows don't.
- They install a colleague's plugin and bind it to their domain in one guided conversation.
