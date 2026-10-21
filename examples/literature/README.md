# Sample project: a literature watch for medical affairs

The literature proof of concept (docs/memwise/25-literature-poc.md). Meridian Medical Affairs keeps up with
the published evidence on the questions its medical team follows. Each question is a **topic**: PubMed is
searched for it every week, every new paper is read once, a literature reviewer screens what was found, and
findings asked for in chat are kept as **evidence** and checked by a reviewer. Pages chart it all.

```
memwise check examples/literature
memwise test  examples/literature
```

- `workspace.yaml`: Meridian Medical Affairs, its roles (Literature reviewer, Medical affairs lead) and the
  house rule for every domain (nothing irreversible).
- `domains/literature/`: the Literature domain, owned by the medical affairs lead. It isn't regulated.
  `policy.yaml` names its model roles: `searcher`, `screener`, `extractor` and `verifier`.
- `plugins/claude__pubmed/1.0.0/`: Anthropic's PubMed connector, installed as a Claude plugin (its
  `.claude-plugin/plugin.json` as published, one HTTP MCP server, `https://pubmed.mcp.claude.com/mcp`).
  `memwise-plugin.yaml` is the manifest the installer wrote, with the seven tools it found on the server
  (`PubMed.search_articles`, `PubMed.get_article_metadata`, …), their input schemas and their read-only hints.
- `domain/bindings/claude__pubmed.yaml`: PubMed bound for the workspace, every tool `read` (bindings are
  read from `domain/bindings/` only for now, so this folder is the only thing in the default domain).
- `plugins/claude__data/1.1.0/`: Anthropic's data plugin (Apache-2.0, `LICENSE` kept), installed for its
  skills (`data:create-viz`, `data:build-dashboard`, `data:validate-data`, …), which chat offers once read.
  Its `.mcp.json` lists warehouse servers that don't matter here; it is **not bound**, so none of them is
  reached.

The domain's tools are `literature.topic.create`, `literature.article.get`, `literature.screening.list` and so
on; PubMed's are `PubMed.*`.

## Entities (`domains/literature/entities/`)

- **Topic**: a question the team follows: its name, the question in plain words, the PubMed `query`, the
  `inclusion` rules a reviewer screens by, when it was last checked and when the next weekly check is due.
  draft → active ⇄ paused → closed; a step activates it, the lead pauses, resumes or closes it. Calculated:
  papers included and excluded, evidence kept and reviewed. Its page shows them as tiles (`kpis:`), a bar
  chart of included papers by year, a forest-style chart of the effects kept as evidence (`chart: { kind:
  interval }`, rejected ones left out), the evidence and screenings, and a **chat** block: "Ask about this
  topic" opens a chat beside the page, anchored to the topic.
- **Article**: one paper, **keyed by its PMID** (`key: [pmid]`): storing a paper another topic already found
  gives back the same record (`existed: true`). Its DOI, PMC id, title, journal, date, publication types,
  authors and abstract come from PubMed; its study type, phase, size (`n`), sponsor, intervention and condition
  are read from the abstract. found → read. Its page is split: the abstract on the left (`viewer: abstract`)
  with the words each value was read from lit, the facts and related records on the right.
- **Screening**: one paper for one topic: include or exclude, why, how sure, and the paper's year and phase
  copied when it was screened (for charts). A reviewer reconsiders by changing the decision on its page.
- **Evidence**: one finding from one paper, kept for a topic: population, intervention, comparator, outcome,
  timepoint, the effect with its 95% confidence interval and unit, the p value, and the paper's own words
  (`quote`, `quote_of: article.abstract`: a quote that isn't in the abstract flags the record "Quote not found
  in the source"). `keep_from_chat: true` lets a chat about a topic keep rows ("Keep as evidence"), each one
  confirmed by the person. kept → reviewed or rejected, by a reviewer.

`views/` holds the included papers by topic and the evidence waiting for review; `pages/literature.yaml` is the
dashboard across topics: topics watched, papers read and included, evidence to review, included papers by year
and by phase, the effects kept as evidence, and the evidence to review.

## Playbooks (`domains/literature/workflows/`)

- `set-up-watch` (**Set up a watch**): starts when a topic is created. The `searcher` turns the question into
  a PubMed search, tries it (`PubMed.search_articles`, `PubMed.get_article_metadata`) and writes the inclusion
  rules, how many papers it finds and the first five; the lead edits and approves it (or sends it back with a
  note); `activate` writes the search onto the topic, makes it active and sets its first check for today
  (`next_check: { today: 0 }`).
- `check-topic` (**Check a topic**): a date trigger on the topic's `next_check` (one case per topic per date;
  "Check now" is setting it to today). `status` ends the case unless the topic is active. `search` searches
  PubMed by entry date from the last check (`datetype: edat`), stores each paper (keyed, so never twice) and
  writes the papers this topic hasn't screened yet; `read_all` calls "Read a paper" for each (`for_each`);
  the `screener` suggests include or exclude with a reason; the reviewer screens them in a table; `record`
  makes one screening per row (`each: case.screening`) and sets the next check a week later
  (`last_checked: { now: true }`, `next_check: { today: 7 }`). With nothing new, the check is only noted.
- `read-paper` (**Read a paper**): a paper already read (by another topic's check) ends at once. Otherwise
  the `extractor` reads the abstract and writes the study type, phase, size, sponsor, intervention and
  condition, each with the words it was read from (`quotes: required`): a quote that isn't in the abstract
  fails the step's check and is sent back for repair. `save` puts the facts on the article and marks it read.

Example cases seed the records they need (`records:`), stub PubMed's answers (`tools:`), script the model roles
and answer the people (`submit:`). `read-paper/quote-not-in-the-abstract` shows a made-up quote sent back.

## The papers

Only **ATTAIN-2** is a real paper: Horn DB et al., "Orforglipron, an oral small-molecule GLP-1 receptor agonist,
for the treatment of obesity in people with type 2 diabetes (ATTAIN-2): a phase 3, double-blind, randomised,
multicentre, placebo-controlled trial." *Lancet* 2025;406(10522):2927-2944, PMID 41275875,
[doi:10.1016/S0140-6736(25)02165-8](https://doi.org/10.1016/S0140-6736(25)02165-8), according to PubMed. Its
abstract here is PubMed's background, methods and main results and its funder line; the rest is left out.

Every other paper is made up for testing: "Example Trial A", "Example Review B" and "Example Trial C", with PMIDs
starting 99000 and DOIs under `10.0000/example.`. The fake PubMed server the tests use
(`packages/runtime/tests/fixtures/fake-pubmed-http.ts`) answers from the same papers.
