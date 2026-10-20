// A small two-domain project for the Phase 6 flow tests (24 §7, §8, §10): triggers of every
// kind, the four block states, entity state timers. No step files: every state is a wait or a
// block, so the tests drive the runs with events and never need a model.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'workspace.yaml': `workspace: Flow test CRO
storm_limit: 5
roles:
  study_manager: { title: Study manager }
  tmf_specialist: { title: TMF specialist }
  data_manager: { title: Data manager }
`,

  // ---------------------------------------------------------------- etmf
  'domains/etmf/domain.yaml': `domain: etmf
name: eTMF
owner: study_manager
accepts_from: [edc]
intake: { address: etmf }
`,
  'domains/etmf/entities/site.yaml': `entity: Site
title: "{site_number} · {name}"
fields:
  site_number: Text
  name: Text
relationships:
  expected_documents: { many: ExpectedDocument, via: site }
calculated:
  start_up_pack_complete: { percent: expected_documents, where: "status = 'filed'" }
lifecycle:
  initial: selected
  states:
    selected:   { on: { picked: activating } }
    activating: { on: { approved: open }, after: { 1s: { remind: study_manager } } }
    open:       { on: { closed_down: closed }, after: { 1s: { transition: closed_down } } }
    closed:     {}
  transitions:
    picked:      { by: [role:study_manager, system] }
    approved:    { by: [step, system] }
    closed_down: { by: [system] }
`,
  'domains/etmf/entities/expected_document.yaml': `entity: ExpectedDocument
fields:
  name: Text
relationships:
  site: one Site
lifecycle: [missing, filed]
`,
  'domains/etmf/entities/person.yaml': `entity: Person
fields:
  name: Text
  cv_expires: Date
`,
  'domains/etmf/entities/contact.yaml': `entity: Contact
fields:
  name: Text
`,

  'domains/etmf/workflows/activate-site/workflow.yaml': `workflow: activate-site
version: 1
title: Activate a site
owner: study_manager
case: ./case.yaml
start: collect_pack
starts_on:
  - entered: Site.activating
    with: { site: record }
steps:
  collect_pack:
    wait_until: { record: case.site, condition: "start_up_pack_complete = 100%" }
    on: { met: approve }
    wait: { timeout: 60d → needs_person }
  approve:
    on: { done: end }
  needs_person:
    on: { resolved: end }
`,
  'domains/etmf/workflows/activate-site/case.yaml': `case: activate_site
fields:
  site: Ref<Site>
`,

  'domains/etmf/workflows/quick-wait/workflow.yaml': `workflow: quick-wait
version: 1
title: Wait briefly for a site
owner: study_manager
case: ./case.yaml
start: collect_pack
steps:
  collect_pack:
    wait_until: { record: case.site, condition: "start_up_pack_complete = 100%" }
    on: { met: approve }
    wait: { timeout: 2s → needs_person }
  approve:
    on: { done: end }
  needs_person:
    on: { resolved: end }
`,
  'domains/etmf/workflows/quick-wait/case.yaml': `case: quick_wait
fields:
  site: Ref<Site>
`,

  'domains/etmf/workflows/watch-expiries/workflow.yaml': `workflow: watch-expiries
version: 1
title: Chase an expiring CV
owner: study_manager
case: ./case.yaml
start: chase
starts_on:
  - before: { field: Person.cv_expires, by: 30d }
    with: { person: record }
steps:
  chase:
    on: { done: end }
`,
  'domains/etmf/workflows/watch-expiries/case.yaml': `case: watch_expiries
fields:
  person: Ref<Person>
`,

  'domains/etmf/workflows/fortnightly/workflow.yaml': `workflow: fortnightly
version: 1
title: Fortnightly TMF review
owner: study_manager
case: ./case.yaml
start: review
starts_on:
  - every: 2w
    with: { note: "scheduled review" }
steps:
  review:
    on: { done: end }
`,
  'domains/etmf/workflows/fortnightly/case.yaml': `case: fortnightly
fields:
  note: Text
`,

  'domains/etmf/workflows/welcome-contact/workflow.yaml': `workflow: welcome-contact
version: 1
title: Welcome a contact
owner: study_manager
case: ./case.yaml
start: hello
starts_on:
  - created: Contact
steps:
  hello:
    on: { done: end }
`,
  'domains/etmf/workflows/welcome-contact/case.yaml': `case: welcome_contact
fields:
  contact: Ref<Contact>
`,

  'domains/etmf/workflows/route-message/workflow.yaml': `workflow: route-message
version: 1
title: Route an incoming message
owner: study_manager
case: ./case.yaml
start: route
starts_on:
  - message: { address: etmf }
    with: { sender: message.from, subject: message.subject, documents: message.attachments }
    as: tmf_specialist
steps:
  route:
    on: { done: end }
`,
  'domains/etmf/workflows/route-message/case.yaml': `case: route_message
fields:
  sender: Text
  subject: Text
  documents: List<Document>
`,

  'domains/etmf/workflows/file-document/workflow.yaml': `workflow: file-document
version: 1
title: File a document
owner: tmf_specialist
case: ./case.yaml
start: work
steps:
  work:
    on: { filed: end, rejected: end, give_up: stuck }
  stuck:
    on: { resolved: end }
`,
  'domains/etmf/workflows/file-document/case.yaml': `case: file_document
fields:
  document: Text
  note: Text
  filed_id: Text
`,

  'domains/etmf/workflows/send-for-filing/workflow.yaml': `workflow: send-for-filing
version: 1
title: Send a document for filing
owner: study_manager
case: ./case.yaml
start: file_it
steps:
  file_it:
    call: { workflow: file-document, with: { document: case.document, note: "please file" }, returns: { filed_id: filed_id } }
    on: { filed: filed, rejected: needs_person, failed: needs_person }
  filed:
    on: { ok: end }
  needs_person:
    on: { resolved: end }
`,
  'domains/etmf/workflows/send-for-filing/case.yaml': `case: send_for_filing
fields:
  document: Text
  filed_id: Text
`,

  'domains/etmf/workflows/hand-on/workflow.yaml': `workflow: hand-on
version: 1
title: Hand a document on
owner: study_manager
case: ./case.yaml
start: start_fix
steps:
  start_fix:
    start: { workflow: file-document, with: { document: case.document } }
    on: { started: after }
  after:
    on: { ok: end }
`,
  'domains/etmf/workflows/hand-on/case.yaml': `case: hand_on
fields:
  document: Text
`,

  ...fanOut('fan-all', 'all', 'call'),
  ...fanOut('fan-any', 'any', 'call'),
  ...fanOut('fan-two', '2', 'call'),
  ...fanOut('fan-start', 'all', 'start'),

  'domains/etmf/workflows/ask-edc/workflow.yaml': `workflow: ask-edc
version: 1
title: Ask data management
owner: study_manager
case: ./case.yaml
start: ask
steps:
  ask:
    call: { workflow: edc-check, with: {} }
    on: { checked: end, failed: end }
`,
  'domains/etmf/workflows/ask-edc/case.yaml': `case: ask_edc
fields:
  note: Text
`,

  // ---------------------------------------------------------------- edc
  'domains/edc/domain.yaml': `domain: edc
name: EDC
owner: data_manager
`,
  'domains/edc/workflows/edc-check/workflow.yaml': `workflow: edc-check
version: 1
title: Check the data
owner: data_manager
case: ./case.yaml
start: check
steps:
  check:
    on: { checked: end }
`,
  'domains/edc/workflows/edc-check/case.yaml': `case: edc_check
fields:
  note: Text
`,
  'domains/edc/workflows/edc-files/workflow.yaml': `workflow: edc-files
version: 1
title: File from EDC
owner: data_manager
case: ./case.yaml
start: file_it
steps:
  file_it:
    call: { workflow: file-document, with: { document: case.document } }
    on: { filed: end, rejected: end, failed: end }
`,
  'domains/edc/workflows/edc-files/case.yaml': `case: edc_files
fields:
  document: Text
`,
};

function fanOut(id: string, join: string, mode: 'call' | 'start'): Record<string, string> {
  return {
    [`domains/etmf/workflows/${id}/workflow.yaml`]: `workflow: ${id}
version: 1
title: Fan out (${mode} ${join})
owner: study_manager
case: ./case.yaml
start: fan_out
steps:
  fan_out:
    for_each: { items: case.documents, as: document, ${mode}: { workflow: file-document, with: { document: item } }, join: ${join} }
    on: { ${mode === 'start' ? 'started: review' : 'done: review, failed: needs_person'} }
  review:
    on: { ok: end }
  needs_person:
    on: { resolved: end }
`,
    [`domains/etmf/workflows/${id}/case.yaml`]: `case: ${id.replace(/-/g, '_')}
fields:
  documents: List<Text>
`,
  };
}

/** Writes the project to a fresh temp folder and returns its path. */
export function flowProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'mw-flow-')), 'project');
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}
