# Sample project: client intake

The project folder the kernel runs against (docs/memwise/17-build-plan.md): staff say who the client is,
the client is sent a link to the intake form (or staff fill it in for them), an agent checks it against
the uploaded documents, a manager approves or sends it back, and the onboard step (a system step, no
model) writes the client into `domain.customer`.

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

## Binding plugins (Phase 4)

Plugins are installed into `plugins/<slug>/<version>/` (`memwise plugin install <project> <folder>`, or Plugins in the app)
and do nothing until they are bound (docs/memwise/22-phase-4-interfaces.md). Binding is a playbook too:

- `workflows/bind-plugin`: `check` (installed, required capabilities provided, tool names free: `plugins.install_check`),
  `propose` (a deterministic proposal written into a binding draft: `plugins.propose_binding`), `classify` (the `binder`
  model role classifies the tools nobody classified: `plugins.classify_tools`), `dry_run` (checks with the binding applied, the
  plugin's example cases through it, its mappings on sample records: `plugins.dry_run`), `fix` (staff), `review` (a manager),
  `freeze` (the next binding version goes live: `plugins.freeze`) and `link` (identity resolution: `identity.resolve`).
- The frozen binding is `domain/bindings/<slug>.yaml`. Only frozen bindings bind tools; the plugin's workflows run in this
  domain's terms through it. `memwise bind <project> <plugin> --draft` makes a binding draft from a proposal on the command line.

The `plugins.*` and `identity.resolve` tools are bound by the kernel when it has a project folder; the example cases stub them
and script the binder.

## Clients fill the form themselves (Phase 5)

Client intake is at version 2 (docs/memwise/23-phase-5-interfaces.md §10):

- `prepare` (staff): the client's name, email, phone and `contact_by` (email or WhatsApp); then **send link** or
  **fill for client**.
- `invite` (a system step): `external.invite`, the kernel's tool, issues a single-use link to `fill` and sends it by
  the channel the case names. Its preview is the exact message, and staff or a manager approve it before it goes
  (`approvals: { by: [staff, manager] }` in `policy.yaml`). Without a public address the case goes to a person.
- `fill` (external): the client's form, behind the link. Its `extract:` lets the form read the uploaded PAN card and
  GST certificate with `intake.extract_fields` and offer what it found; staff can still fill it in.
- `check` no longer emails the client: when something is missing it writes `client_message` and finishes
  `needs_info`, and `invite` sends a new link with that note. A send-back sends a new link too, with the
  manager's comment on the form.

The example cases run the real `external.invite` (through the sample `email.send`) with links made from
`https://memwise.example`; an external step with an open link is answered through it, as the client.
`examples/plugins/client-intake/` stays at its Phase 4 shape.
