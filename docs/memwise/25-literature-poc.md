# 25 · Literature watch (PubMed proof of concept)

A proof of concept built after a client asked for what they had done in Claude: search PubMed with Anthropic's PubMed connector and chart the results with Anthropic's data plugin. In MemWise the same question becomes a **domain** that keeps working: a weekly search per topic, papers read once, a person screening the results, evidence asked for in chat and kept, and pages that chart it all. It sits beside Phase 6 and isn't a phase of [17](17-build-plan.md); Phase 7 is untouched. Decisions D79–D86 ([15](15-decisions.md)).

| Contract | File |
|---|---|
| Example project | `examples/literature/` (workspace "Meridian Medical Affairs", domain `literature`) |
| Definition additions (entity `key`, `quote_of`, page blocks) | `packages/defs/src/types.ts`, `domain-types.ts` |
| Step engine addition (quotes on judgement writes) | `packages/step-engine/src/checkpoint.ts`, `packages/defs/src/contracts.ts` |
| Kernel additions (keyed create, list and date maps in system steps, quote checks, chart data) | `packages/runtime/src/domain-tools.ts`, `records/` |
| App API additions | `packages/shared/src/protocol/memwise.ts` (Literature section) |
| Charts | `packages/ui/src/components/charts/` (one kit for record pages, dashboards and chat) |
| Exit test | `packages/server-core/src/memwise/__tests__/literature-exit.test.ts` |

**Vocabulary.** People read topic, paper, screening, evidence, "Keep as evidence". Code says Topic, Article, Screening, Evidence.

## 1. The two plugins, as verified

- **PubMed** (`anthropics/life-sciences`, `pubmed/.claude-plugin/plugin.json`): one HTTP MCP server, `https://pubmed.mcp.claude.com/mcp`, declared inline as `mcpServers` in `plugin.json`. Checked from a Mac on 2026-10-21: no auth, stateless (no `mcp-session-id`), answers with `structuredContent`. Seven read tools: `search_articles` (PMIDs only, `total_count`, `has_more`, `query_translation`; `datetype: edat` filters by entry date), `get_article_metadata` (title, abstract, journal, date, authors, MeSH, article types, DOI, PMC id), `get_full_text_article` (PMC open access only), `find_related_articles`, `lookup_article_by_citation`, `convert_article_ids`, `get_copyright_status`. Results must be credited to PubMed with DOI links.
- **Data** (`anthropics/knowledge-work-plugins`, `data`, Apache-2.0): ten skills of guidance (analyze, explore-data, create-viz, build-dashboard, validate-data, …). create-viz writes Python; build-dashboard writes HTML with Chart.js from a CDN. Its warehouse MCP servers don't matter here.
- MemWise already imports the PubMed plugin as is (`importClaudePlugin` reads inline `mcpServers`; the kernel's MCP route speaks streamable HTTP). Its tools come in as `PubMed.search_articles` and so on, unclassified until bound.

## 2. The domain (D79)

```
examples/literature/
  workspace.yaml                   Meridian Medical Affairs; roles reviewer, lead
  domain/bindings/claude__pubmed.yaml   PubMed bound, every tool `read` (bindings are workspace-wide for now)
  plugins/claude__pubmed/1.0.0/    the PubMed plugin with its discovered tools
  domains/literature/
    domain.yaml                    name Literature, owner lead
    policy.yaml
    entities/topic.yaml article.yaml screening.yaml evidence.yaml
    workflows/set-up-watch/ check-topic/ read-paper/
    pages/literature.yaml          the cross-topic dashboard
    views/included.yaml evidence-to-review.yaml
```

**Entities**

- **Topic**: `name`, `question` (the plain question), `query` (PubMed syntax), `inclusion` (rules for screening), `last_checked` (DateTime), `next_check` (Date). Lifecycle `draft → active ⇄ paused → closed` (`activate` by step; `pause`, `resume`, `close` by role lead). Relationships `screenings` (many Screening), `evidence` (many Evidence). Calculated: `included` (count of screenings with `decision = 'include'`), `excluded`, `evidence_kept`, `evidence_reviewed`. Page: sidebar (§5).
- **Article**: one paper, keyed by `pmid` (`key: [pmid]`, §3). `pmid`, `doi`, `pmc_id`, `title`, `journal`, `published` (Date), `year` (Number), `article_types`, `authors`, `abstract`, and the facts "Read a paper" fills: `study_type`, `phase`, `n` (Number), `sponsor`, `intervention`, `condition`. Lifecycle `found → read`. Page: split, the abstract on the left with the quotes lit, facts and related on the right.
- **Screening**: one paper for one topic. `topic`, `article`, `decision` (`include | exclude`), `reason`, `confidence`, plus `year` and `phase` copied from the article when it is made (for charts). `parent: topic`. No lifecycle: a reviewer changes `decision` on the page to reconsider. Title `{article}`.
- **Evidence**: one finding in one paper, kept for a topic. `topic`, `article`, `population`, `intervention`, `comparator`, `outcome`, `timepoint`, `effect` (Number), `ci_low`, `ci_high`, `unit`, `p_value` (Text), `quote` (`quote_of: article.abstract`, §4). `parent: topic`. Lifecycle `kept → reviewed | rejected` (role reviewer).

A weekly run is a case of "Check a topic", not an entity: the case keeps its date, the query used and the counts. Sponsor, drug and investigator stay fields until they need pages of their own.

**Playbooks**

- **Set up a watch** (`set-up-watch`): `starts_on: created: Topic` (with `topic: record`).
  - `draft_query` (agent, role `searcher`): turns `question` into a PubMed query, tests it with `PubMed.search_articles` and `PubMed.get_article_metadata`, writes `query`, `inclusion`, `found_count`, `sample` (`List<SampleArticle>`: pmid, title, year).
  - `approve_query` (person, lead): sees the sample, edits `query`/`inclusion`; `approved` or `redo` (back to `draft_query` with the comment).
  - `activate` (system): `literature.topic.update` (`query`, `inclusion`, `next_check: { today: 0 }`) and `literature.topic.transition` (`activate`).
- **Check a topic** (`check-topic`): `starts_on: before: { field: Topic.next_check, by: 0d }` (one case per topic per date; "Check now" = set `next_check` to today). 
  - `status` (system): `literature.topic.get`, `outcomeFrom: { tool: literature.topic.get, field: status }`; `active` goes on, any other status ends the case.
  - `search` (agent, `searcher`): `PubMed.search_articles` with the topic's query, `datetype: edat` and `date_from` = `last_checked` (none the first time), paged up to 50; `PubMed.get_article_metadata` for the new PMIDs; `literature.article.create` for each (keyed by `pmid`, so a paper already stored comes back with `existed: true`). Writes `new_articles: List<Ref<Article>>` (only those this topic hasn't screened) and `found_count`.
  - `read_all`: `for_each: { items: case.new_articles, as: article, call: { workflow: read-paper, with: { article: item } }, join: all }`.
  - `suggest` (agent, `screener`): reads each new article's facts and the topic's `inclusion`; writes `screening: List<ScreeningRow>` (article, title, year, decision include|exclude, reason, confidence).
  - `screen` (person, reviewer): table review of `screening` (§11 of 24); `done`.
  - `record` (system): `literature.screening.create` once per row (`each: case.screening`, §3), then `literature.topic.update` with `last_checked: { now: true }` and `next_check: { today: 7 }`.
- **Read a paper** (`read-paper`): case field `article: Ref<Article>`.
  - `extract` (agent, `extractor`, `quotes: required`): `literature.article.get`; writes `study_type`, `phase`, `n`, `sponsor`, `intervention`, `condition`, each with the quote it was read from (§4). A paper already `read` ends with `already_read`.
  - `save` (system): `literature.article.update` with the extracted values and `literature.article.transition` (`read`). The Article page finds each value's quote through the step that wrote it: the record version's `via` names the `save` step run, whose case values carry the `extract` step's provenance.

## 3. Keyed records (D80)

- An entity may declare `key: [field, …]` (Text, Number or Ref fields, required). The store adds a unique index on the key columns (nulls not allowed).
- `<domain>.<entity>.create` with a key that already exists returns `{ id, existed: true }` and changes nothing; otherwise it creates the record and returns `{ id, existed: false }`. Two creates racing on the same key both get the one record; the existing record is looked up as the system, so the creator's column grants can't hide it. `memwise check`: `key-unknown-field`, `key-field-not-required`, `key-field-restricted` (a key field may not have `access:`).
- `.get` accepts `{ key: { pmid: "…" } }` as well as `{ id }`.

**System steps map over lists and dates.** A system step's `map` for a tool may say `each: case.<List field>`: the tool is called once per item, in order, with `item.<path>` available beside `case.<path>`, and each call's idempotency key is `${stepRunId}:${tool}:${index}`. A step run again (re-entered after a person) is a new step run, so it calls again from the first item: an entity created once per item needs a `key:` to find the records made the first time (Screening is keyed `[topic, article]`; `memwise check` warns `each-target-not-keyed` otherwise). A step that writes from such a tool gets the list of results. Argument sources gain `{ today: <days> }` (a Date: the step run's start date plus that many days, in the local time zone of the process running the kernel; there is no workspace time zone) and `{ now: true }` (a DateTime).

## 4. Quotes (D81, D82)

**On step writes.** `step.finish` takes an optional `quotes: { <field>: "<exact words>" }` beside `writes`. A judgement write with a quote stores it on its provenance (`judgement` gains `quote?`). Before the step finishes, the engine checks every quote **deterministically**: after normalising both sides (Unicode NFKC, whitespace collapsed, case folded, `·` and `.` treated alike), the quote must be a substring of the text of some tool result the step saw (its strings, and the strings inside JSON text; numbers are values, not text). A quote that isn't found fails the structural check `writes.<field>: the quote is in a source`, which gives the model its repair round like any structural failure. A step may require quotes: `quotes: required` in the step's front matter makes a write without one fail the same way. A quote on a write that comes from a tool fails the same rule ("this value comes from a tool; quote only judgement writes").

**On records.** A Text field may say `quote_of: <ref field>.<text field>` (Evidence: `quote_of: article.abstract`). On every create and update the kernel checks, with the same normalisation, that the value appears in that field of the referenced record, and raises a flag on the record "Quote not found in the source" when it doesn't (cleared when a later version matches). The check is code, never a model.

**On pages.** A `viewer:` block may name a Text field (Article: `{ viewer: abstract }`). It shows the text and highlights the quotes of the record's values (from the provenance of the step that wrote them) and of its related records' `quote_of` fields. Hovering a highlight names the field; clicking a value's quote scrolls to it.

## 5. Pages and charts (D84)

One chart kit in `packages/ui/src/components/charts/` (hand-drawn SVG, theme colours, no new dependency): `BarChart`, `LineChart`, `DonutChart`, `IntervalChart` (a dot with its confidence interval per row and a reference line at 0, forest style), and `KpiTiles`. Record pages, dashboards and chat use the same components.

- **Record page blocks** gain `kpis: [<calculated or Number fields>]` (tiles with the field labels) and `chart` gains `kind: interval` and `value`/`low`/`high`/`label`/`where`:

  ```yaml
  page:
    layout: sidebar
    header: [title, status, next_check]
    main:
      - kpis: [included, excluded, evidence_kept, evidence_reviewed]
      - chart: { kind: bar, of: screenings, by: year, where: "status = 'included'", title: Included papers by year }
      - chart: { kind: interval, of: evidence, label: "{intervention} vs {comparator}", value: effect, low: ci_low, high: ci_high, unit: unit, where: "status != 'rejected'", title: Effect vs comparator }
      - related: [evidence, screenings]
      - cases
    side: [details, lifecycle, start, chat]
  ```

  `chart.where` filters the related rows (condition language). `chat` is a block with one button, "Ask about this topic", that opens a chat anchored to the record beside the page (§6).
- **Free pages** gain a `chart:` block: `{ kind: bar|line|donut, entity, where?, by, title }` (counts per value of `by`) or `{ kind: interval, entity, where?, label, value, low, high, title }`. `DashboardData` computes the rows in SQL, like the KPIs.
- **Chat** gains a fenced ` ```chart ` block. Its body is JSON: `{ "kind": "bar"|"line"|"donut"|"interval", "title"?, "data": [ { "label", "value", "low"?, "high"? } ], "unit"?, "source"? }`. The system prompt's Structured Data section tells the model to use it for charts instead of Python, Mermaid or HTML, and to put the papers it drew from in `source`.

## 6. Chat anchored to a record, and "Keep as evidence" (D83)

- **Anchor.** `MwOpenChatInput.anchor` gains `{ kind: 'record', entity, id }`. `openChat` builds the context from `kernel.records.page(entity, id, actor)`: the record's values, its related rows (titles and ids) and what the page shows. The chat opens beside the page (`useOpenChatBeside`); the record page's "Ask in chat" and the `chat` block use it.
- **Read tools** for a record chat (session tools, read-only, `safeMode: allow`), acting as the person with their access:
  - `record_get { entity, id }` → the record's values with their sources and quotes;
  - `record_query { entity, filter?, sort?, columns?, limit ≤ 200 }` → rows, under RLS;
  - each answer's text is data, not instructions (it is tagged as untrusted content like any tool result).
- **Keeping.** An entity may say `keep_from_chat: true` (Evidence does). A record chat then has `record_keep { entity, rows: [ { …values } ] }`. It is **not** auto-allowed: the permission prompt that shows the rows is the "Keep" button. Kept rows are created in the entity's initial state (Evidence: `kept`) by the person, with the reason "kept from chat <session>", and their `quote_of` fields are checked (§4). The tool answers per row: the new id, and whether its quote was found. The model is told to keep only rows whose quote it copied exactly from a record it read.
- Reviewing kept evidence is the record's lifecycle (`review`, `reject`) on its page or in the view "Evidence to review"; the Topic's interval chart leaves out rejected rows.

## 7. The data plugin's skills in chat (D85)

- Skills of plugins installed in the project (`plugins/<slug>/<version>/skills/*/SKILL.md`, the newest version of each plugin) become a fourth skill tier after global, workspace and project, named `<plugin>:<skill>` (`data:create-viz`). They are offered to chat the way workspace skills are (read before use).
- A MemWise note is prepended when a skill is read: "In MemWise, draw charts with a ```chart block, and tables with ```datatable; don't write Python or HTML dashboards unless asked." So the data plugin's guidance on choosing and checking charts applies, and its Python and Chart.js recipes don't.
- `examples/literature/plugins/` includes the data plugin (Apache-2.0, with its licence) so the demo has it.

## 8. HTTP MCP, tested (D86)

- A fake PubMed MCP server for tests (`packages/runtime/tests/fixtures/fake-pubmed-http.ts`): streamable HTTP on a local port, stateless like the real one, the seven tools with the real input schemas, answering from fixtures (ATTAIN-2 and a few more papers). `plugin-routes.test.ts` gains an HTTP section: install the PubMed plugin pointed at it, discover the tools, call `search_articles` through the gateway.
- Examples and `memwise test` stub `PubMed.*` with `tools:` results, as before. The exit test uses the fake server.

## 9. Exit test

`literature-exit.test.ts`, real Postgres, scripted models, the fake PubMed server:

1. A lead creates Topic "Oral GLP-1s for weight in T2D". "Set up a watch" drafts the query, tests it (3 found), the lead approves; the Topic is `active` with `next_check` today.
2. The date sweep starts "Check a topic". `search` stores 3 Articles; one PMID already stored for another topic comes back `existed: true` and isn't created twice.
3. `read_all` reads each paper; ATTAIN-2's `n` is 1613 with the quote "1613 (757 [46·9%] female) were randomly assigned". A scripted write whose quote isn't in the abstract fails the structural check and is repaired.
4. `suggest` proposes include/exclude; the reviewer accepts two and rejects one in the table review; `record` makes the three Screenings (`each:`); the topic's `included` is 2, `next_check` is next week.
5. A chat anchored to the Topic calls `record_query` and `record_get`, then `record_keep` with three ATTAIN-2 rows; the permission prompt is answered yes; three Evidence records exist in `kept`, quotes found. A fourth with a made-up quote is kept but flagged "Quote not found in the source".
6. The Topic page's interval chart has three rows; the dashboard's bar chart counts included papers by year.
7. Running `check-topic` again finds nothing new.

## 10. Not in the proof of concept

Full text from PMC, Embase or ClinicalTrials.gov, two reviewers and conflicts, a PRISMA diagram, signed screening (regulated mode works but the example isn't regulated), a Question entity with evidence for and against, standing questions added from chat, per-domain bindings, and a Claude sign-in for agent steps (they still need an API key).

## 11. As built

**Example (`examples/literature`).**
- "Read a paper" starts with a system step that reads the article's status (`outcomeFrom`): `found` goes on to `extract`, `read` ends the case without a model call. Its outcome is `read`, not `already_read`.
- `ScreeningRow` carries `phase` too, so `record` copies it onto the Screening (`item.phase`). Charts filter Screenings on `decision = 'include'` (Screening has no lifecycle).
- "Check a topic" has `mark_checked` for the nothing-new path (only updates the topic) and a `needs_person` state for the lead. "Set up a watch" carries the lead's redo note back to the searcher in `query_comment`.
- The ATTAIN-2 abstract in the fixtures ends with its real last line, "Eli Lilly and Company.", so the sponsor can be quoted under `quotes: required`. Only ATTAIN-2 is real; the other papers (PMIDs 99000…, DOIs `10.0000/example.…`) are made up.
- `plugins/` holds the PubMed plugin (manifest made the way the installer does, tools discovered from the fake server, real URL kept) and the data plugin 1.1.0 (Apache-2.0, not bound: it is there for its skills).

**Kernel.**
- New check codes: `key-unknown-field`, `key-field-not-required`, `key-field-restricted`, `quote-of-not-text`, `quote-of-unknown-field`, `map-each-not-list`, `map-item-without-each`, `each-write-not-list`, `each-target-not-keyed` (warning), `quotes-ignored`, `list-unknown-field`.
- `each:` with an empty or unset list makes no calls and writes `[]`; a value that isn't a list goes to a person. `{ today: n }` uses the step's start time and the kernel process's local time zone (not a workspace setting: a kernel running in UTC moves to the next date at UTC midnight).
- The key index is synced as `<table>__key` (a name over Postgres's 63 bytes keeps its start and ends with a hash of the whole); when existing rows clash, the key is left unenforced and the sync returns a note. A person creating a duplicate key gets a readable error; only steps get `existed: true`.
- The quote normaliser is one function in `packages/defs/src/quotes.ts`, used by the step engine, the records service and the renderer's fallback highlighting. A quote for a field the step didn't write also fails.
- Quote flags are keyed `quote_of:<field>`; a records consumer re-checks when the quoting record or its source text changes.
- Interval chart rows are capped at 200 (with a skipped count). Record page charts are keyed by `mwPageBlockKey(area, index)`.
- An entity may name its records table's default columns with `list: [journal, year, status]` (fields, calculated fields or `status`; anything else is `list-unknown-field`). Without it the table shows up to six short fields (no value over 120 characters, none its `title:` template already shows) and the status. Cells are one line, cut with an ellipsis, the whole value in the tooltip; the Columns menu lists every field whatever the last query asked for.

**Chat.**
- Record chats open in Ask mode when the record's domain has a `keep_from_chat` entity. `record_get` and `record_query` are allowed in Explore; `record_keep` is blocked there and asked in every other mode, never "Always allow". The prompt lists each row with its fields and quote. Results are wrapped as untrusted record data, and so is the record digest in the chat's context (text values cut at 300 characters; `record_get` has them whole). `record_get` gives each value's quote and whether it was found, from the page's text viewers.
- `record_query` returns 1–200 rows (default 50) and cuts long text; `record_get` returns it whole. `record_keep` takes at most 50 rows.
- The record anchor is stored as `anchor_kind = 'record'`, `anchor_id = "<entity>:<id>"`; no migration (the column is plain text).
- Plugin skills: newest version per plugin, named `<plugin>:<skill>`; the MemWise note is added to the "read these skill files" directive and to skill suggestions, not to the Read tool's result.

**Models.** Playbook steps use the default connection when it has an API key, else the first other connection that does, so a Claude subscription can stay the default for chat (`pickPlaybookConnection`, models.ts). On an Anthropic connection they run on the newest `claude-sonnet-*` in pi-ai's catalog, not the connection's chat model (often an Opus); `MEMWISE_PLAYBOOK_MODEL` names another, and the connection's model is the fallback when the catalog has no Sonnet (`pickPlaybookModel`). OpenAI connections keep their own model.

**Open.**
- Charts aren't clickable (interval rows don't open their record; bars don't filter a view), though the data carries `record` and `key`.
- No highlight for values that came through an `each`-mapped argument, or that an agent wrote straight onto a record without a case write of the same name.
- An interval label field with no value renders empty; a record-page chart `of:` a calculated field draws nothing.
- The renderer has no client wrapper for `memwise:records:keep` (chat keeps through the session tool). The handler keeps only from a chat of the workspace anchored to a record.
- `packages/ui/eslint.config.mjs` registers its style plugin as `craft-styles` while the rules are named `memwise-styles/…`, so `bun run lint:ui` can't run as the repo stands.

## 12. As rebuilt on pages

Stage 2 of [26](26-projects-and-pages.md) (§6, D94, D99–D103) rebuilt the example on pages. What this
document describes above is the first version; this is what the example is now.

- **The question is the page.** The Literature home has no entity: asking makes a draft **page** with the
  question, under the page it was asked from, and a chat anchored to it that answers and writes the page
  (`page_update`), every number in a `table` cell carrying the abstract's words it came from. Keep makes it
  refresh every Monday. There are no Topic, Screening or Evidence types: their screening and evidence work is
  the refresh's, and a page's tables carry the evidence with its quotes.
- **Records:** Papers (`Article`, keyed by PMID, read once, with `weeks` added) and Enquiries.
- **Refresh a page** (`refresh-literature-page`, named in domain.yaml as `pages.refresh`) replaces Set up a
  watch and Check a topic: search PubMed by entry date since the page's last refresh and store the papers,
  "Read a paper" for each new one (unchanged), rewrite the page, compare, and "Review an answer change" for
  the page's owner or the lead. A page that sums up its sub-pages searches nothing and sums up the kept ones.
- **Playbooks:** Answer an enquiry (built: email in, the kept pages first then PubMed, a drafted reply with
  references, the lead's signature, the email), Monthly digest (built), Evidence pack (a stub).
- **What carried over:** keyed records, checked quotes, the chart kit (now one renderer with `tiles`, `table`,
  `records` and `subpages`), the PubMed binding and plugin, Read a paper, and the playbook model choice. The
  record chat and "Keep as evidence" (D83) stay in the kernel for other apps; Literature doesn't use them.
- **Tests:** `literature-pages-exit.test.ts` (server-core) runs the exit test on fixtures: the side-effects
  question, Keep, a refresh with a fixture paper added (Example Trial D), the answer change accepted, "Add how
  long each trial ran" with Undo, and GLP-1's summary leaving the draft out. It replaces
  `literature-exit.test.ts`, whose Topic flow is gone. `literature-seed.test.ts` checks the walkthrough seed
  (`seedLiteratureHome`, the LHome state). The runtime's `literature.test.ts` keeps its own fixture project
  and still covers keys, quotes and charts.

