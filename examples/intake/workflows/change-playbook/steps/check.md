---
title: Check the draft
performer: system
strictness: strict
reads: [case.draft]
tools:
  allowed:  [playbooks.check_draft]
  required: [playbooks.check_draft]
map:
  playbooks.check_draft: { draft: case.draft }
outcomeFrom: { tool: playbooks.check_draft, field: outcome }
writes:
  checked_hash:    { type: Text, from: { tool: playbooks.check_draft, field: hash } }
  report:          { type: Text, from: { tool: playbooks.check_draft, field: summary } }
  errors:          { type: Number, from: { tool: playbooks.check_draft, field: errors } }
  examples_failed: { type: Number, from: { tool: playbooks.check_draft, field: examples_failed } }
outcomes: [passed, failed]
---
Check the draft as it is now: the structure and policy checks, its example cases, recent cases of
the live version replayed on it, and what publishing it would change. A draft with errors or a
failing example case goes back to the chat with the report; a clean one goes to review, and the
content that was checked is the only content that can be published.
