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
