---
title: Set the weekly check
performer: system
strictness: strict
reads: [case.topic]
tools:
  allowed:  [literature.topic.update]
  required: [literature.topic.update]
map:
  literature.topic.update:
    id:         case.topic
    next_check: { today: 7 }
outcomes: [done]
---
Set the topic's next weekly check a week from today; the first check starts now.
