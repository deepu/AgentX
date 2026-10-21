---
title: Save what was read
performer: system
strictness: strict
reads: [case.article, case.n, case.sponsor]
tools:
  allowed:  [lit.article.update]
  required: [lit.article.update]
map:
  lit.article.update:
    id:      case.article
    n:       case.n
    sponsor: case.sponsor
outcomes: [done]
---
Put what was read onto the paper.
