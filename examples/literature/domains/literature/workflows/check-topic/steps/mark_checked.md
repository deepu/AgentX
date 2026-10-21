---
title: Note the check
performer: system
strictness: strict
reads: [case.topic]
tools:
  allowed:  [literature.topic.update]
  required: [literature.topic.update]
map:
  literature.topic.update:
    id:           case.topic
    last_checked: { now: true }
    next_check:   { today: 7 }
outcomes: [done]
---
Nothing new this week: note when the topic was checked and set the next check for a week from today.
