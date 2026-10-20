---
title: Record the engagement
performer: system
strictness: strict
reads: [case.engagement_title, case.start_date]
tools:
  allowed:  [domain.engagement.create]
  required: [domain.engagement.create]
map:
  domain.engagement.create:
    title:   case.engagement_title
    started: case.start_date
writes:
  engagement: { type: Ref<Engagement>, from: { tool: domain.engagement.create, field: id } }
outcomes: [done]
---
Record the approved engagement, so the case keeps a link to it.
