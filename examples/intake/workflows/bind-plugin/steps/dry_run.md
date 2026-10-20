---
title: Dry-run the binding
performer: system
strictness: strict
reads: [case.draft]
tools:
  allowed:  [plugins.dry_run]
  required: [plugins.dry_run]
map:
  plugins.dry_run: { draft: case.draft }
outcomeFrom: { tool: plugins.dry_run, field: outcome }
writes:
  checked_hash:    { type: Text, from: { tool: plugins.dry_run, field: hash } }
  report:          { type: Text, from: { tool: plugins.dry_run, field: summary } }
  errors:          { type: Number, from: { tool: plugins.dry_run, field: errors } }
  examples_failed: { type: Number, from: { tool: plugins.dry_run, field: examples_failed } }
outcomes: [passed, failed]
---
Try the binding draft without changing anything live: the domain's checks with the binding
applied (the plugin's workflows resolved into the domain's terms included), the plugin's example
cases run through it, its mappings applied to sample records read from each mapped source, and,
for an upgrade, how each of its workflows changes. A clean dry run goes to review; anything
failing goes back to staff with the report.
