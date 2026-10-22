---
title: Compare with the page
performer: system
strictness: strict
reads: [case.page, case.body, case.title, case.label, case.change_title, case.plus, case.left_out, case.reason, case.asked_by]
tools:
  allowed:  [page.compare]
  required: [page.compare]
map:
  page.compare:
    page:         case.page
    body:         case.body
    title:        case.title
    label:        case.label
    change_title: case.change_title
    plus:         case.plus
    left_out:     case.left_out
    reason:       case.reason
    asked_by:     case.asked_by
outcomeFrom: { tool: page.compare, field: outcome }
writes:
  change: { type: Text, from: { tool: page.compare, field: change } }
outcomes: [material, nothing_new]
---
Compare the rewritten page with the page now: its headline, its numbers and its sections. If the
answer changed, the new page waits for review; if not, the page gets one history line, "nothing new".
