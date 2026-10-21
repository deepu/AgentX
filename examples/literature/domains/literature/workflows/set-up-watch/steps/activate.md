---
title: Start the weekly watch
performer: system
strictness: strict
reads: [case.topic, case.query, case.inclusion]
tools:
  allowed:  [literature.topic.update, literature.topic.transition]
  required: [literature.topic.update, literature.topic.transition]
map:
  literature.topic.update:
    id:         case.topic
    query:      case.query
    inclusion:  case.inclusion
    next_check: { today: 0 }
  literature.topic.transition:
    id:         case.topic
    transition: activate
outcomes: [done]
---
Write the approved search and inclusion rules onto the topic, make it active, and set its first
check for today: "Check a topic" starts within the minute.
