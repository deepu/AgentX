---
title: Record the screenings
performer: system
strictness: strict
reads: [case.topic, case.rows]
tools:
  allowed:  [lit.screening.create]
  required: [lit.screening.create]
map:
  lit.screening.create:
    each:     case.rows
    topic:    case.topic
    article:  item.article
    decision: item.decision
writes:
  screenings: { type: List<Text>, from: { tool: lit.screening.create, field: id } }
outcomes: [done]
---
One Screening per row; one made before (same topic and paper) is found by its key.
