# Sample project: client intake

The project folder the kernel runs against (docs/memwise/17-build-plan.md, Phases 1 and 2): staff fill
the intake form for a client, an agent checks it against the uploaded documents, a manager approves or
sends it back, and the onboard step (a system step, no model) writes the client into `domain.customer`.

```
memwise check examples/intake
memwise test  examples/intake
```

- `domain/roles.yaml`: the roles people have (staff, manager, finance); steps name theirs with `assignee`.
- Tools come from the kernel's sample tool set (`gst.validate_gstin`, `intake.extract_fields`, `email.send`)
  and the domain tools the kernel binds for each entity type (`domain.customer.create`, `domain.customer.get`).
- Example cases stub tool results and script the model roles; `submit:` answers the person steps, and
  `expect.entities` checks the rows written to the domain tables.

## Building and changing playbooks (Phase 3)

Change control is itself two playbooks, run like any other case (docs/memwise/20-phase-3-interfaces.md §3):

- `workflows/create-playbook`: a chat with staff (`interview`, a conversation step: `engine: open`) drafts a new
  playbook in `drafts/<id>/`; `check` runs the checks, its example cases and past cases (`playbooks.check_draft`);
  a manager reviews it; `publish` makes it live as version 1 (`playbooks.publish_draft`).
- `workflows/change-playbook`: the same, starting at `edit` on a copy of a live playbook set to the next version.
  "Send for review" from the editor starts it at `check`.

The `playbooks.*` tools are bound by the kernel when it has a project folder. The example cases stub them and answer
the chat steps and the review from `submit:`.
