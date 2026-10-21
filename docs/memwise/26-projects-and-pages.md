# 26 · Projects, pages and apps

The simplified app, agreed with Sandeep on 21 October 2026 while working through design mocks, and the plan to turn today's app into it. It changes what people see and three things underneath (projects, pages, the shell). The kernel, playbooks, records, policy and regulated mode stay as built in Phases 0–6 and the Literature track ([25](25-literature-poc.md)). It isn't Phase 7, which stays unstarted.

Decisions D87–D98 ([15](15-decisions.md)). Where this doc says **Decided**, Sandeep agreed it on a mock; **Proposed** is design detail for the build to confirm.

## Mocks

- **Canvas, interactive:** [MemWise projects](https://claude.ai/artifact/UGzrYBEgkjLy17GwJEN7fU) (36 screens; every link clicks through). It opens on the project switcher.
- **Screenshots in the repo:** [`mocks/projects/screens/`](mocks/projects/screens/), one PNG per screen at 1440×900. They're named as listed below.
- **Source:** [`mocks/projects/source/`](mocks/projects/source/). It holds the Python that writes each screen (`screens1.py`–`screens7.py`, `build_lib.py`), the canvas files (`project/*.dc.html`, `canvas.json`) and the Playwright renderer (`engine.js`, `phone.js`). Run `NODE_PATH=$(npm root -g) node engine.js Main LHome` from a copy of the folder with `project/` and `render/` beside it.
- Earlier steps on the way, for history: the first simplification of today's UI ([canvas](https://claude.ai/artifact/TGVNRJk7SrygzpvxcNf29K)) and the Literature ask-first mock ([canvas](https://claude.ai/artifact/15YBo45Dvx9Q9W8qieeKHJ)).

| Row on the canvas | Screens |
|---|---|
| Every day in Study MW-301 (eTMF) | `Main` home, `Ask` a page from a question, `Waiting` Waiting for you, `Sign` a signature |
| Pages and records | `TmfBoard` a page changed by chat, `Sites` records as a list, `Documents` records as cards, `Site` a record page, `Document` a regulated record |
| Playbooks and runs | `Playbook`, `Run`, `Upload` (the site's phone view) |
| Setting up a project | `NewProject` (New study), `Settings` (project settings), `Sidebar`, `XSwitch` (the project switcher, open) |
| Literature search | `LHome`, `LAsk`, `LTopic` (a parent page), `LBoard` (a kept page), `LChange` (review an answer change), `LPlaybook`, `LRun`, `LLibrary` (papers), `LPaper`, `LSettings` |
| eTMF stress test | `EIndex` TMF index, `EInspection` inspection readiness, `EInspector` the inspector's view, `EChange` change control, `EAudit` audit trail, `EPortfolio` the eTMF app home |
| Apps and projects, one switcher | `XWaitingAll` Waiting for you across projects, `XEdcHome` the EDC app, `XQueries` an EDC page from a question, `XSite` one site in two apps |

## 1. The model in one picture

```
Workspace (the organisation)           top bar: My Workspace ⌄
 └ App (eTMF, EDC, Literature)         a template: record types, playbooks, page shapes, rules
    └ Project (Study MW-301)           one copy of the app with its own records, pages, people, connections
       ├ Home                          ask a question; the pinned page
       ├ Waiting for you               everything in this project that needs me
       ├ Pages (tree, sub-pages)       live pages, most of them written by chat from a question
       ├ Playbooks                     work that repeats or leaves the building
       ├ Records                       the project's own data (sites, documents, papers)
       └ Project settings              people, connections, rules, template version
```

| People see | Code says | Note |
|---|---|---|
| App | domain (a definition used as a template) | `domains/<id>/`. A Phase 6 domain becomes an app. |
| Project | project (new) | One copy of an app. |
| Page | page (`mw.pages`), dashboard (`pages/*.yaml`), record page | One word for all of them in the UI. |
| Playbook | workflow | Already "playbook" in the UI. |
| Run | case | |
| Waiting for you | inbox | |
| Records | entity records | |

Code names don't change. Phase 0 showed what renaming stable identifiers costs.

## 2. The shell *(Decided, D89)*

Mocks: `Main`, `Sidebar`, `XSwitch`, `Waiting`, `LHome`.

- **Top bar:** the workspace switcher, as today.
- **The left sidebar** has these parts, top to bottom:
  - **The project switcher:** the app name small above the project name. It opens a menu with:
    - "Waiting for you, all projects" and its total;
    - every project grouped by app, each with its waiting count;
    - the app home under each app ("All studies");
    - "+ New project" and "+ Add an app".
  - Below the switcher: Home, Waiting for you (with a count), PAGES (a tree with ▸/▾ carets, a ↻ on kept pages, a Draft tag), PLAYBOOKS (with a short tag: `upload`, `Fri`, `email`), RECORDS (with counts).
  - At the bottom: Project settings, and the person.
  - There is no app rail; it was tried and dropped (D88).
- **Two columns on every screen:**
  - **Left: the chat about what's on the right.** It's anchored to it ([09](09-chat.md)): project, page, playbook, run, record. It's about 488px wide and stays short and conversational: a few sentences, a list at most.
  - **Right: the page.** It holds the detail: tables, charts, the full answer, history.
  - Opening something on the right switches the chat to that thing's chat. It is continued if one exists.
- **What chat changes shows up on the page.** The chat leaves a chip ("Added 2 columns to the trials table · Undo"), and the changed section of the page is marked "Changed from chat · Undo".
- **Only buttons on the page act:** Sign, Approve and send, Accept change, Keep. Chat can draft and change; it never signs or sends without the page's button or the permission prompt.
- **Home** is the ask box, "What do you want to know about Study MW-301?", with "Try asking", recent chats (each with its page), and the pinned page on the right.
- **Waiting for you** is one built-in page for every playbook in the project:
  - signatures, approvals and reviews of a page change;
  - each item says where it came from ("From Chase missing documents, step 3");
  - the chat on the left orders it ("What needs me first?").

## 3. Projects inside apps *(Decided D87; storage Proposed D92, D93)*

Mocks: `XSwitch`, `NewProject`, `Settings`, `EPortfolio`, `XWaitingAll`.

**What a project is.** A project is one copy of an app with its own records, pages, runs, chats, people and connections.
- A study is a project in eTMF, because each study has its own sites, people and sign-offs.
- In Literature, one project serves the whole team, so the paper library is shared and a paper read once serves every page.
- An **app home** is a page across the app's projects ("TMF across studies": status per study, who is the bottleneck). It replaces "All projects".

**Storage (Proposed, D92).**
- `mw.projects (id, app, name, status draft|active|archived, from jsonb, template_version, study, settings jsonb, created_by, created_at)`. `from` records the source: `{ template: 'phase3', version: 4 }` or `{ project: 'prj_mw301' }`.
- App tables stay named by app (`etmf__site`, D72). Each table gains `project text not null`, with an index on it. Records, cases, inbox items, pages, notes, mentions, chat anchors and views all carry the project too.
- **Migration:** existing rows go into one project per domain (`<domain>`), named after the domain. Nothing else moves.
- **Access:**
  - A grant gains `project`. `mw.grants (person_id, role_id, domain, project, scope)`.
  - RLS filters every app table by the projects the person holds a grant in. The record `scope` from Phase 6 still narrows inside a project.
  - App-home pages read across the projects the person can see.
- **App-scoped entities.** An entity may say `scope: app` for records shared by every project of the app, such as Sponsor, or a Person who is PI on several studies. Their table has no project column, and a project's records link to them like any other `Ref`. Everything else is `scope: project` (the default).
- *Considered and rejected:* one domain per project, copying the folder per study. It gives dozens of tables per study, no app-home page without unions, and template updates by hand.

**Definitions (Proposed, D93).**
- The app is today's `domains/<id>/` folder plus `app.yaml` (title, version, description, the template cards shown in New project).
- A project is `projects/<id>/project.yaml`: app, version taken from, name, study key, people and roles, connections. It can also hold `overrides/`: whole files that replace the template's (a changed `workflows/chase-missing/…`, a stricter `policy.yaml`).
- The indexer resolves a project's effective definitions as the template plus its overrides. Runs pin the project and the definition versions, as they pin versions today.
- Overrides are whole files, not merges, at first. A step-level merge waits until whole files hurt.
- **A template update** is a new app version. Each project on that app gets a "Review template update" item in Waiting for you, which shows:
  - what changes;
  - what the project already overrides ("This project already does that, so nothing changes here");
  - a test run on one record before it's taken (mock `Settings`).
  A project never changes without that review.
- **Save as template:** a project's effective definitions become a new app version or a new app, with no records copied.
- **New project** has these choices:
  - pick a template card (Phase 3 study, Phase 1 study);
  - copy a project ("Start from MW-301");
  - describe it in chat.
  The draft shows its pages, playbooks, records and people, and nothing runs until "Start study" (mock `NewProject`). Describing it in chat is a run of a "create a project" meta playbook, built like create-playbook.
- **Connections:** plugins stay installed once per workspace. Bindings ([22](22-phase-4-interfaces.md)) move from per domain to per project, falling back to the app's binding. Credentials never get re-entered for a new project.

## 4. Pages *(Decided D90, D91; storage Proposed)*

Mocks: `Ask`, `TmfBoard`, `LAsk`, `LTopic`, `LBoard`, `LChange`, `EInspection`, `XQueries`.

**One kind of thing, in four shapes:**
- a **written page** (Literature's "page the chat wrote", [25](25-literature-poc.md) commit 5bde62b);
- a **dashboard** (`pages/*.yaml`);
- a **record page** (generated from the entity's `page:`, D73);
- a **built-in page** (Waiting for you, a playbook, a run).

In the sidebar's PAGES tree, people see written pages and dashboards. Record pages hang under their records, and built-in pages under their places.

**Built from a question (D91).**
1. Asking on Home, or anywhere, answers in chat at once and writes a **draft page** for that question on the right. The page is composed for the question, not filled into a fixed template: it holds the headline answer, tiles, charts, tables and sources.
2. **Keep** makes it a kept page with a refresh schedule ("Keep watching, daily until 28 Oct" or "Refreshes every Monday").
3. A **refresh** rewrites the page from what's new. When the answer changes, Waiting for you gets "Review an answer change", with before and after, the new section and what was left out, and Accept or Send back. A refresh that finds nothing new adds one history line, "nothing new".
4. Every number on a page links to the sentence it came from (D81, D82). A page lists its history ("1 June, ATTAIN-MAINTAIN added, accepted by Leah").

**Sub-pages.** A page may have a parent. A parent page sums up its **kept** sub-pages, and drafts are left out (mock `LTopic`). Refreshing a child marks the parent for a summary refresh.

**Changed by chat.** "Add how long each trial ran" changes the page, and the section is marked "Changed from chat · Undo". Undo goes back one version.
- Columns added from chat become fields on the records' type when other pages could use them ("The columns are now on the Papers list too"). They go through the draft path: in a normal project they're applied with Undo; in a regulated one they become a change request (§8).

**Storage (Proposed).**
- `mw.pages` (0006) gains these columns:
  - `project`;
  - `parent` (page id);
  - `status draft|kept|archived`;
  - `question` (text);
  - `chat_id` (the chat that made it);
  - `refresh jsonb`, for example `{ every: 'mon', until?: date, playbook: 'refresh-page' }`;
  - `pinned bool`;
  - `sums_children bool`.
- `mw.page_versions` gains `via` (`chat:<id>`, `run:<id>`, `person:<id>`) and `reason`.
- `mw.page_changes (id, page_id, from_version, to_version, run_id, status pending|accepted|sent_back, reviewed_by, at)` feeds "Review an answer change".
- **The body stays markdown** with fenced blocks:
  - `chart` (exists, D84);
  - `tiles`;
  - `table`, holding written rows with links;
  - `records`, a live query (`entity`, `filter`, `columns`), recomputed whenever the page opens;
  - `subpages`.
  Written blocks are frozen at the last refresh or edit; live blocks are recomputed.
- **Chat tools** (session tools, acting as the person): `page_create`, `page_update`, `page_get`. Today's `record_update` into a markdown field is replaced by `page_update`. Each update is a new version with `via: chat`.
- **"Refresh a page"** is a built-in playbook per app:
  1. an agent step gets the page's question, its last body, the project's tools and what is new since the last refresh, and writes a new body;
  2. a system step compares the two bodies (headline, numbers, sections);
  3. if anything material changed, a person step "Review an answer change" runs for the page's owner or the role the app names.
  An app can supply its own refresh steps (Literature searches PubMed since the last refresh and reads new papers into Papers first).

## 5. Playbooks, runs and records each have a page

Mocks: `Playbook`, `Run`, `Sites`, `Documents`, `Site`, `Document`, `Sign`, `LPlaybook`, `LRun`, `LLibrary`, `LPaper`.

- **Playbook page:** when it starts, its steps, this week's runs. It also shows a draft from chat ("Draft from chat: 1 change · test run passed", Discard / Send for review) and where it came from ("From the Phase 3 study template, version 4 · this project changed it: wait 5 days instead of 3"). Playbooks are for work that repeats or leaves the building (answering a doctor, a monthly digest, chasing documents), not for keeping a page current.
- **Run page:** the step timeline with the waiting step open in place (the email with Edit / Approve and send), and "Changed from chat · Undo" on what chat changed.
- **Records:** each record type has a list with a **List | Cards** toggle (cards by status, drag to move it on; dropping on a signed state asks for a signature). Chat filters show as a chip ("Below 80% · from chat ×") with "Save as a page".
- **Record page:** what's missing, its runs, the pages it's on, "Open in EDC" when the record is shared with another app (§9). A regulated record shows the AI checks with quotes, the signature, versions and the audit trail.
- **Sign:** the review on the right with the signature block (meaning, password, "Signing records your name, the time and this meaning, and locks this version"). Chat on the left is for questions ("Anything I should push back on?").

## 6. Literature on the new model *(Decided, D94)*

Mocks: the Literature row. It is set in early June 2026, and its numbers are real PubMed data.

- **One project, "Literature search",** for the medical affairs team. The paper library (Papers) is shared across every page in it.
- **Topics are pages with sub-pages:**
  - GLP-1, with sub-pages Weight loss, Type 2 diabetes and Side effects (a draft);
  - Heart failure;
  - Pipeline watch.
  There are no Topic, Screening or Evidence types in the example any more.
- **The question is the page.** Keep makes it refresh weekly, and you review changes to the answer, not every paper screened (mock `LChange`).
- **Records:**
  - Papers: `Article`, keyed by PMID, read once, with columns grown on demand (People, Weeks, Weight change);
  - Enquiries.
- **Playbooks:**
  - Answer an enquiry: email in → find the evidence (pages first, then PubMed) → draft the reply with references → a medical lead signs → send;
  - Monthly digest;
  - Evidence pack.
- **What carries over from [25](25-literature-poc.md):** keyed records, checked quotes, record chat, the chart kit, the `memwise:ask` handler, the PubMed binding and the playbook model choice. The Topic-centred playbooks (Set up a watch, Check a topic, Read a paper) become the Literature app's "Refresh a page" steps and a "Read a paper" step inside them.

## 7. eTMF *(Decided, D95)*

Mocks: the first four rows and the eTMF stress test row.

- **One project per study.** The app home "TMF across studies" reads across studies (filed %, missing, waiting for QC, the next milestone) and shows who is the bottleneck.
- **TMF index:** a live page with one sub-page per zone, built from the TMF Reference Model and the study plan.
- **Inspection readiness:** a page built from one sentence ("The MHRA is inspecting MW-301 on 16 to 18 Nov. Get us ready."). Keeping it attaches "Get ready for an inspection" and sets up the inspectors' read-only access.
- **Site upload by link, no account** (Phase 5 relay, mock `Upload`).

## 8. Regulated projects *(Decided, D95)*

Mocks: `EChange`, `EInspector`, `EAudit`, `Document`, `Sign`.

- **Record types and lifecycles are fixed by the template.** Regulated record pages keep the template's layout; pages people write are free.
- **A chat edit to a playbook or rule becomes a change request** (CR-014). The request holds:
  - what changes, with strikeouts;
  - the reason;
  - a validation run on past records (41 of 42, then 42 of 42 after a fix);
  - sign-offs (the person who raised it, then QA).
  It goes live as a new version when QA signs, and the old version keeps running until then. This builds on Phase 3 drafts and Phase 6 signatures.
- **Inspectors get a different view:**
  - read only, with every view and download logged;
  - filed documents, signatures and the audit trail only;
  - no drafts, chats or AI suggestions;
  - their questions go to people ("Ask the study team").
  It is an external link (Phase 5) with a read-only role and an end date.
- **The AI is in the audit trail like a person.** An entry names the model and the sentence it relied on ("Flagged v1: 'Protocol version 2.0' does not match 3.0"). The trail is append-only, each entry is chained to the one before (D77), and the export is signed.

## 9. A study across apps; EDC *(Proposed, D96)*

Mocks: `XEdcHome`, `XQueries`, `XSite`, `Site` ("Open in EDC").

- **EDC is a connected app.** Data entry stays in Medidata Rave (or Veeva CDMS). MemWise reads it, builds pages from questions ("Old queries by site") and runs playbooks like "Chase old queries".
- **Projects with the same study key are linked across apps.** MW-301 in eTMF and MW-301 in EDC share sites, site staff and visit dates through D71's linked entities: one source per shared field, read through, never copied.
- **One app owns each fact.** A record page tags each fact with its owner (EDC or eTMF), and the other app shows it read only with a jump back ("Open in eTMF" and "Open in EDC").
- **Changes flow into playbooks.** When Rave records a new coordinator, eTMF asks the site for the CV and GCP training.
- **"Also in other apps"** is a block on the project home.

## 10. What leaves the main navigation *(Proposed, D97, D98)*

Today's Craft-era navigation is in `AppShell.tsx`: All sessions, the status filters, Flagged, Archived, Labels, Sources, Skills, Craft "projects" (session groups), Automations, Plugins, Cases and the domain sidebar. In the new shell:

| Today | Goes to |
|---|---|
| All sessions, statuses, flagged, archived, labels | Chats live on their anchors (a page, a playbook, a run). There's no chat list in the main navigation; an "All chats" list sits under Project settings › Advanced. |
| Sources, Skills | Project settings › Connections (sources), and the app's skills under App settings |
| Craft "projects" (session groups, `nav:projects`) | Hidden in MemWise mode. The word "project" now means §3, so its UI strings are renamed to "chat groups" wherever they're still shown. |
| Automations | A playbook's "Starts when" on its page; scheduled page refreshes on the page |
| Cases | Runs on each playbook's page; the run page |
| Inbox | Waiting for you (per project, and all projects) |
| Plugins | "+ Add an app" and Project settings › Connections |
| Domains sidebar (Pages tree, Workflows, Entities, House rules) | The project sidebar; entities and house rules under Project settings |

The code stays. The chat screen (`ChatDisplay`) is reused as the left column, unchanged inside ([13](13-from-craft-agents.md), Phase 2 risk).

## 11. The build, in six stages

Each stage gets:
- its own thread and a short branch, with a PR into `new-primitives`;
- a background review on the strongest model before the merge;
- a merge only when Sandeep says "merge".

**The quality bar:** a stage is not "ready to try" until its whole flow has been run end to end with the real model, and screenshots have been checked against the mocks. For Sandeep's own testing, use dev mode on his Mac (`electron:dev` from the repo); the full packaged build is only for handover.

```
Stage 1  Shell                      the new sidebar and two columns; each domain shows as a project
Stage 2  Pages                      ask → draft page → Keep → refresh → review an answer change; Literature rebuilt on it
Stage 3  Projects inside apps       projects, project-scoped data and access, templates, New project, app homes
Stage 4  Everything has a page      playbook, run and record pages with chat; List | Cards; chat filters
Stage 5  Regulated projects         change requests, the inspector's view, the audit trail with AI entries
Stage 6  EDC and studies across apps  a Rave connector, linked projects, one owner per fact
```

**Order:** 1 → 2 → 3 → 4. Stages 5 and 6 come after 3 and can run side by side.
- Pages created in Stage 2 carry a `project` column from the start (set to the domain id), so Stage 3 adds no second migration for them.
- Stage 3's storage design can start beside Stage 2.
- Merging today's separate desktop installs ("MemWise Intake", "MemWise eTMF", the Literature dev build) into one workspace comes after Stage 3. It needs a migration of its own, and it must carry connections across: Sandeep never re-adds a connection.

### Stage 1 · Shell (branch `shell`)

- **Sidebar.** A MemWise-mode sidebar (new component beside `LeftSidebar.tsx`) with the project switcher, Home, Waiting for you, PAGES, PLAYBOOKS, RECORDS and Project settings.
- **Projects for now:** each domain is one project (project id = domain id), grouped by a placeholder app of the same name. No storage changes.
- **Switcher menu:** projects grouped by app, waiting counts, "Waiting for you, all projects". "+ New project" is shown but disabled until Stage 3.
- **Two columns:** a `ChatPagePane` layout used by every MemWise route. The chat is about 488px with a 400px minimum, and the page takes the rest. Opening a page opens its anchored chat (anchors exist: project/home, page, workflow, case, record).
- **Screens:**
  - Home generalises `DomainHome.tsx` (ask box, try asking, recent chats with their pages, pinned page right);
  - Waiting for you restyles the inbox (`InboxItemView.tsx`);
  - the PAGES tree is `mw.pages` plus dashboards plus the record tree;
  - PLAYBOOKS lists workflows with their start tag;
  - RECORDS lists entities with counts.
- **Navigation:** the old items move as in §10. UI strings change via i18n keys: Inbox → Waiting for you, Cases → Runs, Domain → App.
- **Exit test** (Playwright, desktop app on the eTMF and Literature examples):
  - a person goes Home → asks → Waiting for you → opens and signs an item → opens a page → a playbook → a record, and never sees a chat list or a Craft menu;
  - screenshots match `Main`, `Waiting`, `Sidebar`, `XSwitch` and `LHome` in layout;
  - the existing tests and the Literature exit test still pass.

### Stage 2 · Pages (branch `pages`)

- **Migration `0008_pages`:** the `mw.pages` columns and `mw.page_changes` (§4), plus the fenced blocks `tiles`, `table`, `records` and `subpages` in the page renderer. One renderer serves chat and pages, using the chart kit (D84).
- **Chat tools:** `page_create`, `page_update`, `page_get`. The domain `home:` ask becomes a project ask: it makes a draft page, not a draft record.
- **Keep:** sets the refresh schedule, a schedule trigger (D76) starting "Refresh a page".
- **Refresh a page:** the built-in playbook with a compare step and "Review an answer change" in Waiting for you (before/after, new section, left out, Accept / Send back).
- **Also in this stage:** sub-pages with the parent's summary block (kept children only), version history with Undo, and the history line on the page.
- **Literature rebuilt on pages** (§6):
  - the example drops Topic, Screening and Evidence;
  - Papers (`Article`, keyed) and Enquiries stay;
  - the Literature refresh searches PubMed since the last refresh, reads new papers into Papers, then rewrites the page;
  - playbooks: Answer an enquiry (built), Monthly digest (built), Evidence pack (stub);
  - `25-literature-poc.md` gets an "As rebuilt on pages" section.
- **Exit test** (real model, real PubMed, plus a kernel test `literature-pages-exit.test.ts` on fixtures):
  1. "How often do people stop oral GLP-1s because of side effects?" answers in chat in under a minute. Numbers link to their sentences, and a draft page appears on the right under GLP-1.
  2. Keep it, and it refreshes weekly.
  3. A refresh with a fixture paper added makes "Review an answer change". Accepting it updates the page and its history.
  4. "Add how long each trial ran" changes the trials table with Undo, and Undo restores the previous version.
  5. GLP-1's summary leaves the draft sub-page out.
  6. Screenshots match `LAsk`, `LTopic`, `LBoard` and `LChange`.

### Stage 3 · Projects inside apps (branch `projects`)

- **Migration `0009_projects`:** `mw.projects`, the `project` column on app tables and every per-project table (§3), the backfill into one project per domain, grants with `project`, and RLS by project. Add `scope: app` for entities.
- **Definitions:** `app.yaml`, `projects/<id>/project.yaml` with `overrides/`, the indexer resolving template plus overrides, and runs pinning the project. `memwise check` gains `override-unknown-file`, `project-unknown-app`, and `app-scope-ref` (an app-scoped entity may not `Ref` a project-scoped one).
- **Bindings:** per project, falling back to the app's binding.
- **The switcher becomes real:** "+ New project" (template card, copy, or describe in chat; a draft until "Start"), app homes (`EPortfolio`), and Waiting for you across projects (`XWaitingAll`).
- **Template updates:** a new app version makes "Review template update" per project (§3), with a test run; also "Save as template".
- **Exit test** (kernel test plus Playwright, eTMF example with MW-301 and MW-207 from a "Phase 3 study" template):
  1. A person granted only MW-301 never sees MW-207's records, pages, runs or chats; this is tested in SQL as that person.
  2. MW-301 changes "Chase missing documents" to wait 5 days.
  3. Template version 5 is published. MW-207 gets "Review template update"; MW-301's review says it already does that.
  4. MW-310 is copied from MW-301 and starts with no records.
  5. "TMF across studies" shows both running studies.
  6. Today's single-domain examples still load as one project each.

### Stage 4 · Everything has a page (branch `every-page`)

- **Playbook page:** starts when, steps, runs this week, and a draft from chat with a test run on one record and Send for review (Phase 3 drafts behind it).
- **Run page:** a step timeline with the waiting step open in place.
- **Record lists** with List | Cards (the `kanban` components), drag to move on, and chat filter chips with "Save as a page".
- **Record pages with their chat on the left** (D83, generalised from Literature to every entity).
- **The Sign page** layout.
- **Exit test:** screenshots match `Playbook`, `Run`, `Sites`, `Documents`, `Site`, `Document` and `Sign`. Then:
  - chat changes Chase missing documents ("also copy the CRA on the second reminder") into a draft with a test run on site 104, and it goes for review;
  - a chat filter becomes a saved page.

### Stage 5 · Regulated projects (branch `regulated`)

- **Change requests.** In a regulated project, a chat edit to a playbook, rule or record type is a change request page holding:
  - what changes;
  - the reason;
  - a validation run against a chosen set of past records;
  - sign-offs, with QA's signature making it live.
- **Inspector view:** an external link with a read-only role, an end date, view logging and questions to people.
- **Audit trail page:** record versions, signatures and step records, with AI entries naming the model and the quoted sentence; signed export.
- **TMF index** with zone sub-pages.
- **Exit test:** screenshots match `EChange`, `EInspector`, `EAudit` and `EIndex`. Then:
  - a CR fails validation once, is fixed from chat and passes;
  - QA signs, and the new version runs while old runs finish on the old one;
  - an inspector link shows no drafts or chats;
  - the export verifies its chain.

### Stage 6 · EDC and studies across apps (branch `edc`)

- **An EDC app template** connected to Medidata Rave through a plugin: read-only Rave Web Services, with a fake Rave server for tests (like the PubMed fake, D86). Its records are Subjects, Sites and Queries, read through, plus pages from questions and "Chase old queries" (outbound email to sites).
- **Study links:** `project.yaml` `study:` links projects across apps; linked entities by key (D71); the owner tag per field on record pages; the "Also in other apps" block; jump buttons both ways.
- **Exit test:** screenshots match `XEdcHome`, `XQueries` and `XSite`. Then:
  - Site 104 shows EDC-owned and eTMF-owned facts;
  - a new coordinator in the Rave fixture makes eTMF ask the site for a CV.
- **Needs Sandeep:** a Rave (or Veeva CDMS) sandbox for a real check.

**As built (Part A, before Stage 3's projects).**
- **Where:** EDC lives in the eTMF example (`examples/etmf/domains/edc`), not a new example: a study across apps needs both apps in one workspace, and the `edc` domain and eTMF's link to its Site were already there (D114).
- **The fake Rave** (`packages/runtime/tests/fixtures/fake-rave-http.ts`) serves RWS paths with Basic sign-in, GET only. Study MW-301 has 12 sites, 186 subjects and 142 open queries, 23 of them older than 14 days (104: 9, 109: 8, 102: 3, 106: 2, 111: 1); 91% of pages are verified; site 104's coordinator has been Lena Hoffmann since 2 Sep. MW-207 sits beside it. `setCoordinator` (or `POST /__fake/coordinator`) changes a site's coordinator during a test, and `bun packages/runtime/tests/fixtures/fake-rave-http.ts --port 4790` runs it on its own.
- **The plugin** `examples/plugins/medidata-rave` (`memwise/medidata-rave`) has nine `read` tools on builtin routes `rave.rws.*` (`packages/server-core/src/memwise/rave`) and record sources for study, site, subject and query. Settings `RAVE_URL`, `RAVE_USER`, `RAVE_PASSWORD` and `RAVE_STUDY` (optional) come from the connection: the secret store, else the environment. No tool takes them as arguments, so nobody types them again (D111).
- **Records:** the binding maps Rave onto `edc.Study`, `edc.Site`, `edc.Subject` and `edc.Query`, all owned by the plugin. Subjects and queries hang off their site through `transform: [{ link: site }]` (D112). Sites roll up randomised, open queries and queries older than 14 days. Views: Old queries, Open queries, Sites; page: Enrolment.
- **Read through, as a read-only copy (D110, a deliberate deviation from "never copied"):** the binding's `sync: { every: 15m }` reads Rave again on a kernel sweep and refreshes only the plugin-owned fields. Every such field shows Rave as its source with "as of <time>" (`source.asOf`), and no person or step can edit it. The copy's real job is to turn Rave changes into change events.
- **Changes flow into playbooks (D113):** a refreshed coordinator is a `changed` event on `edc.Site`. eTMF's Site follows `coordinator`, so the link consumer announces the change on the paired eTMF Site, and eTMF's **Ask a new coordinator for their documents** (`starts_on: changed: { entity: Site, fields: [coordinator] }`) adds her to the site's staff, expects her CV and GCP training, and emails her once approved.
- **Chase old queries** (`edc`, every Monday 08:00): an agent drafts one reminder per site with old queries; a system step sends them with `each:`, and each email waits for its own approval.
- **Screens** (`components/memwise/edc`):
  - `EdcHomeScreen({ projectId })` is XEdcHome: Rave read only and when it was synced; randomised against target and plan; open and old queries; pages verified; what waits; randomised by site; Also in other apps.
  - `AlsoInOtherApps({ projectId })`.
  - `OwnerTag`, `OpenInAppButton` and `RecordFactsByAppView`. On a record page in more than one app, they show "One record, each fact owned by one app", with "Open in eTMF" / "Open in EDC".
  - RPC: `memwise:edc:home`, `memwise:study:apps`, `memwise:records:linked`.
  - Until projects land, a project id is read as the study key ("MW-301").
- **Tests:**
  - `rave-tools.test.ts` covers the fake and the tools.
  - `edc-exit.test.ts` runs end to end against Postgres and the fake: the sync, read-only Rave facts, the study home, site 104 in both apps, a new coordinator asking for a CV, and Chase old queries with five approvals.
  - `edc-render.test.tsx` covers the screens.
  - `memwise test examples/etmf` runs the playbooks' examples, including `two-sites-behind`, `nothing-old` and `asks-for-cv`.
- **Not yet:**
  - XQueries ("Old queries by site" as a page from a question) needs Stage 2's pages on this branch.
  - `project.yaml` `study:` and per-project bindings need Stage 3.
  - Screenshots against the mocks.
- **Needs Sandeep: a Rave (or Veeva CDMS) sandbox.** The client speaks RWS paths with the fake's JSON bodies; a real Rave answers ODM XML and clinical views. `packages/server-core/src/memwise/rave/client.ts` is the one file to check against it.

## 12. Risks

| Risk | Where it shows | If it goes wrong |
|---|---|---|
| The new shell breaks the mature chat | Stage 1 | `ChatDisplay` stays untouched inside the left column; only how it's opened changes |
| The project column migration loses or leaks data | Stage 3 | Backfill tested on copies of real projects; RLS tests as a person per project; old access paths kept until the exit test passes |
| Template plus overrides gets complicated | Stage 3 | Whole-file overrides only; a step-level merge only when it hurts |
| AI-written pages drift or make things up | Stage 2 | Quotes checked in code (D81, D82); every material change reviewed; drafts never feed parent summaries |
| Four columns don't fit a 13-inch screen | Stage 1 | Collapsible sidebar; chat minimum 400px; the page can close when chat is enough |
| The word "project" clashes with Craft's session projects | Stage 1 | Hidden in MemWise mode; renamed "chat groups" wherever still shown |
| Merging today's separate installs | After Stage 3 | Its own migration; connections carried over, never re-entered |

## 13. Open

- **App first or study first.** These mocks put the app on top (eTMF › MW-301). Study first (MW-301 › eTMF, EDC, Safety) may suit teams that work one study at a time. The storage in §3 supports both, because the study key links projects, so the choice is mostly the switcher's grouping. Decide before Stage 3's switcher.
- **Whether a chat list survives** anywhere beyond Settings › Advanced (power users, developers).
- **Seeing waiting items in other projects.** Without the rail, you only see them by opening the switcher. If that matters, add a dot on the switcher.
- Bindings per project or per app by default.
- Whether app homes are fixed per app or written by chat like other pages.
- Pricing per project for the hosted version (Phase 7).
