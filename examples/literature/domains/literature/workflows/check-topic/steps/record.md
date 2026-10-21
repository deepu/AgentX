---
title: Put the AI's decisions on the topic
performer: system
strictness: strict
reads: [case.topic, case.screening, case.answer]
tools:
  allowed:  [literature.screening.create, literature.topic.update]
  required: [literature.screening.create, literature.topic.update]
map:
  literature.screening.create:
    each:       case.screening
    topic:      case.topic
    article:    item.article
    decision:   item.decision
    reason:     item.reason
    confidence: item.confidence
    year:       item.year
    phase:      item.phase
    by:         ai
  literature.topic.update:
    id:           case.topic
    answer:       case.answer
    last_checked: { now: true }
    next_check:   { today: 7 }
outcomes: [done]
---
Make one screening per paper on the topic with the screener's decision, write what the papers say
so far onto the topic, and set the next check for a week from today.
