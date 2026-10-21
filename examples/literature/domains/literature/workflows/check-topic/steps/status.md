---
title: Check the topic is active
performer: system
strictness: strict
reads: [case.topic]
tools:
  allowed:  [literature.topic.get]
  required: [literature.topic.get]
map:
  literature.topic.get: { id: case.topic }
outcomeFrom: { tool: literature.topic.get, field: status }
outcomes: [draft, active, paused, closed]
---
Read the topic. Only an active topic is searched; a paused or closed one ends the case here.
