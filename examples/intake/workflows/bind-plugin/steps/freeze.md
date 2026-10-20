---
title: Freeze the binding
performer: system
strictness: strict
reads: [case.draft, case.checked_hash]
tools:
  allowed:  [plugins.freeze]
  required: [plugins.freeze]
map:
  plugins.freeze: { draft: case.draft, hash: case.checked_hash }
outcomeFrom: { tool: plugins.freeze, field: outcome }
writes:
  binding_version: { type: Number, from: { tool: plugins.freeze, field: version } }
outcomes: [frozen, stale]
---
Freeze the approved binding draft as the next binding version, recording who approved it. Its
tools are bound and its workflows run from now on. If the draft changed after its dry run,
nothing is frozen and it is dry-run again.
