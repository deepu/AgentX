# Sample project: Literature search for medical affairs

The Literature app, rebuilt on pages (docs/memwise/26-projects-and-pages.md §6; the first version is
docs/memwise/25-literature-poc.md). Meridian Medical Affairs asks what the published literature says. **Each
question becomes a page**: the chat answers it and writes the page as it goes, every number in a table cell
linked to the sentence of the abstract it came from. Keep the page and it refreshes from PubMed every Monday;
a refresh that changes the answer waits as "Review an answer change" until the page's owner or the medical
affairs lead accepts it. Papers are read once into **Papers**; doctors' questions emailed in become
**Enquiries**, answered from the kept pages first.

```
memwise check examples/literature
memwise test  examples/literature
```

- `workspace.yaml`: Meridian Medical Affairs, its roles (Literature reviewer, Medical affairs lead) and the
  house rule for every domain (nothing irreversible).
- `domains/literature/`: the Literature domain (and project), owned by the medical affairs lead. It isn't
  regulated. `domain.yaml` has a `home:` with no entity (a question makes a draft page), `pages:` naming its own
  refresh (`refresh-literature-page`), who reviews answer changes (`lead`) and the default schedule (`mon`),
  and `intake: { address: enquiries }`. `policy.yaml` names its model roles: `searcher`, `extractor`, `writer`
  and `verifier`.
- `plugins/claude__pubmed/1.0.0/`: Anthropic's PubMed connector, installed as a Claude plugin (its
  `.claude-plugin/plugin.json` as published, one HTTP MCP server, `https://pubmed.mcp.claude.com/mcp`).
  `memwise-plugin.yaml` is the manifest the installer wrote, with the seven tools it found on the server
  (`PubMed.search_articles`, `PubMed.get_article_metadata`, …), their input schemas and their read-only hints.
- `domain/bindings/claude__pubmed.yaml`: PubMed bound for the workspace, every tool `read` (bindings are
  read from `domain/bindings/` only for now, so this folder is the only thing in the default domain).
- `plugins/claude__data/1.1.0/`: Anthropic's data plugin (Apache-2.0, `LICENSE` kept), installed for its
  skills, which chat offers once read. It is **not bound**, so none of its servers is reached.

The domain's tools are `literature.article.create`, `literature.enquiry.update` and so on; PubMed's are
`PubMed.*`; the kernel's page tools are `page.get`, `page.list`, `page.compare`, `page.accept_change` and
`page.send_back_change`.

## Records (`domains/literature/entities/`)

- **Article** (Papers): one paper, **keyed by its PMID** (`key: [pmid]`): storing a paper another page's
  refresh already found gives back the same record (`existed: true`). Its DOI, PMC id, title, journal, date,
  publication types, authors and abstract come from PubMed; its study type, phase, size (`n`), length
  (`weeks`), sponsor, intervention and condition are read from the abstract. found → read. Its page is split:
  the abstract on the left with the words each value was read from lit, the facts on the right.
- **Enquiry**: a doctor's question emailed in: who asked, the question, the reply as signed, its references
  and the pages it drew on. received → drafted → sent (a step moves it; "redraft" sends it back).

There are no Topic, Screening or Evidence types any more: the question is the page, and a page's tables carry
the evidence with its quotes. `pages/literature.yaml` is a dashboard of Papers and Enquiries.

## Playbooks (`domains/literature/workflows/`)

- `refresh-literature-page` (**Refresh a page**, the Literature's own, named in `domain.yaml`): `search`
  searches PubMed by entry date from the page's last refresh (`datetype: edat`), stores each paper in Papers
  and writes the ones not read yet; `read_new` calls "Read a paper" for each (`for_each`); `write` rewrites
  the page from its question, its body and the papers; `compare` (`page.compare`) decides whether the answer
  changed; `review` ("Review an answer change", routed by the kernel to whoever kept the page or the lead)
  accepts it (`page.accept_change`) or sends it back. A page that sums up its sub-pages searches nothing and
  sums up its kept sub-pages only.
- `read-paper` (**Read a paper**): a paper already read ends at once. Otherwise the `extractor` reads the
  abstract and writes its facts, each with the words it was read from (`quotes: required`).
- `answer-enquiry` (**Answer an enquiry**): starts when an email reaches the enquiries address. `record`
  keeps it as an Enquiry; `find` reads the kept pages first (`page.list`, `page.get`), then PubMed; `draft`
  writes the reply with its references; the lead signs it (`sign:`) or sends it back; `send` emails it
  (`email.send`, after the platform's approval of outbound messages) and marks the enquiry sent.
- `monthly-digest` (**Monthly digest**): on the 1st, the writer reads the kept pages and what changed on
  them and the digest is emailed to the team.
- `evidence-pack` (**Evidence pack**): a stub; a person puts the pack together for now.

Example cases seed the records they need (`records:`), stub PubMed's and the pages' answers (`tools:`),
script the model roles and answer the people (`submit:`, `approvals:`).

## The papers

Only **ATTAIN-2** is a real paper: Horn DB et al., "Orforglipron, an oral small-molecule GLP-1 receptor agonist,
for the treatment of obesity in people with type 2 diabetes (ATTAIN-2): a phase 3, double-blind, randomised,
multicentre, placebo-controlled trial." *Lancet* 2025;406(10522):2927-2944, PMID 41275875,
[doi:10.1016/S0140-6736(25)02165-8](https://doi.org/10.1016/S0140-6736(25)02165-8), according to PubMed. Its
abstract here is PubMed's background, methods and main results and its funder line; the rest is left out.

Every other paper is made up for testing: "Example Trial A" to "Example Trial D" and "Example Review B", with
PMIDs starting 99000 and DOIs under `10.0000/example.`. ATTAIN-MAINTAIN in the refresh example and the other
papers the walkthrough seed stores (`packages/server-core/src/memwise/seed-literature.ts`) are condensed from
the mocks' text, with placeholder PMIDs starting 99001. The fake PubMed server the tests use
(`packages/runtime/tests/fixtures/fake-pubmed-http.ts`) answers from the same papers.
