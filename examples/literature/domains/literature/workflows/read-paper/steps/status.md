---
title: Check it isn't read yet
performer: system
strictness: strict
reads: [case.article]
tools:
  allowed:  [literature.article.get]
  required: [literature.article.get]
map:
  literature.article.get: { id: case.article }
outcomeFrom: { tool: literature.article.get, field: status }
outcomes: [found, read]
---
Read the paper's record. A paper another page's refresh has already read keeps what was read from
it, so the case ends here: each paper is read once.
