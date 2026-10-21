---
title: Record the screenings
performer: system
strictness: strict
reads: [case.topic, case.screening]
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
  literature.topic.update:
    id:           case.topic
    last_checked: { now: true }
    next_check:   { today: 7 }
outcomes: [done]
---
Make one screening per paper on the topic, as the reviewer decided, and set the next check for a
week from today.
