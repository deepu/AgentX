---
title: Store the papers
performer: system
strictness: strict
reads: [case.rows]
tools:
  allowed:  [lit.article.create]
  required: [lit.article.create]
map:
  lit.article.create:
    each:     case.rows
    pmid:     item.pmid
    title:    item.title
    abstract: item.abstract
    year:     item.year
writes:
  articles: { type: List<Text>, from: { tool: lit.article.create, field: id } }
outcomes: [done]
---
One Article per row; a paper stored before is found by its PubMed id.
