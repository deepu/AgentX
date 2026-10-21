# Sample project: an eTMF for a CRO

A workspace with two domains (docs/memwise/21-domains-and-records.md, 24-phase-6-interfaces.md). Northlight
CRO runs study AST-301 for the sponsor Aster Bio at three sites: DE-104 in Berlin, US-012 in Boston ("Harbor
Oncology, Boston") and FR-201 in Lyon. Every document a site sends ends up filed in the trial master file,
checked and signed by a TMF specialist, and a site opens once its start-up pack is complete.

```
memwise check examples/etmf
memwise test  examples/etmf
```

- `workspace.yaml`: Northlight CRO, its roles (TMF specialist, study manager, CRA, data manager) and the house rules
  for every domain (a person approves every outbound message; nothing irreversible).
- `domains/edc/`: the study's EDC, connected to Medidata Rave (Stage 6, docs/memwise/26 §9): studies,
  sites with their staff, subjects and queries, read only. See "EDC" below.
- `domains/etmf/`: the TMF itself, a **regulated** domain (`domain.yaml`: `regulated: true`, records kept 25
  years). Its intake address is `etmf`: anything emailed there starts "Sort an incoming message".

Every entity type is named by its domain, so the tools are `etmf.document.create`, `etmf.site.transition`,
`edc.site.get` and so on. `domain/` holds only the connector bindings (`domain/bindings/`: Medidata Rave
and the sample email), which are workspace-wide until projects make them per project.

## Entities (`domains/etmf/entities/`)

Sponsor → Study → Site → Person, Document and ExpectedDocument, each naming its `parent`, which makes the
page tree (Aster Bio › AST-301 › Sites › US-012).

- **Site** follows EDC's Site through a link (`links: { edc.Site: { match: [site_number], follow: … } }`):
  its name, address and principal investigator are read from EDC, never copied. `start_up_pack_complete`
  is a rollup: the percent of its expected documents that are filed. Its lifecycle runs selected →
  activating → open → closing → closed; a study manager (or EDC) picks a site, and only a step may open it,
  when the start-up pack is complete (the `approved` transition's guard). A site activating for 60 days
  reminds the study manager.
- **Document** is a received file with its index (artifact, study, site, the person it is about, date,
  version). It moves received → indexed → in QC → filed; `file` needs the specialist's signature on the
  document (`signed: true`). Its page is split: the file on the left, the index, the checks and the rest
  on the right.
- **ExpectedDocument** is what a site must provide (the Investigator CV, the IRB approval, …), missing until
  a document fills it.

`views/` holds shared views (sites as a table and a board, missing documents by site, documents waiting for
QC); `pages/tmf-health.yaml` is the TMF health dashboard under each study: completeness, documents in QC,
CVs expiring this month, a heatmap of the sites' start-up packs and the missing documents.

## Playbooks (`domains/etmf/workflows/`)

- `route-message` (**Sort an incoming message**): starts on every email to the eTMF address
  (`starts_on: message`). The `router` model role says what it is; for documents, a `for_each` block starts
  one "File a TMF document" case per attachment. Questions go to a TMF specialist.
- `file-document` (**File a TMF document**): `receive` (a system step) creates the Document record from the
  file as it arrived; `classify` (model role `classifier`) reads it and proposes the index; `index` and
  `send_to_qc` write the index onto the record and queue it; `qc`, the TMF specialist, reviews it on the
  Document's page in review mode (`review: { kind: document, record: case.document }`) and signs "Reviewed and
  approved for filing" (`sign:`); `file` files it and ticks off the expected document. Sent back, the document
  is marked so and a `start` block starts "Fix a rejected document" with the specialist's note.
- `activate-site` (**Activate a site**): starts when a site enters Activating (`starts_on: entered`). It
  waits on the data, not on other cases: `wait_until` the site's `start_up_pack_complete = 100%`, however the
  last document arrived. Then the study manager approves and the site opens.
- `watch-expiries` (**Watch for expiries**): a date trigger, 30 days before a person's `cv_expires`, asks the
  TMF specialist to request a new CV.
- `fix-rejected-document` (**Fix a rejected document**): the specialist asks the site for a corrected document,
  which comes back by email and is filed by its own case.

Example cases seed the records they need (`records:`, by entity, with fixed ids such as `site_us012`) and
script the model roles (`router`, `classifier`, `verifier`) and the people (`submit:`).

## EDC (`domains/edc/`)

Data entry stays in Medidata Rave; MemWise reads it and chases it (docs/memwise/26 §9, D110–D114).
The Rave plugin (`plugins/memwise__medidata-rave`, from `examples/plugins/medidata-rave`) has only `read`
tools. Its binding maps Rave's studies, sites, subjects and queries onto `edc.Study`, `edc.Site`,
`edc.Subject` and `edc.Query`, and reads them again every 15 minutes (`sync:`). Every Rave field is
owned by the plugin, so it is read only here and shows Rave as its source, with when it was read.

- **Site** rolls up `randomised`, `open_queries` and `old_queries` (open longer than 14 days). eTMF's
  Site follows its name, PI and coordinator.
- `chase-old-queries` (**Chase old queries**, every Monday): the `chaser` drafts one reminder per site
  with old queries to its coordinator. Each email is approved with its exact text before it goes.
- eTMF's `new-coordinator` (**Ask a new coordinator for their documents**): starts when EDC's Site
  changes coordinator (`starts_on: changed`, through the link). It adds them to the site's staff,
  expects their CV and GCP training, and emails them once approved.

To run it against the fake Rave:

```
bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790
RAVE_URL=http://127.0.0.1:4790/RaveWebServices RAVE_USER=rave.reader RAVE_PASSWORD=not-a-real-password
```
