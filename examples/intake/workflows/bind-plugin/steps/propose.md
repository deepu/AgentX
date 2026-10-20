---
title: Propose a binding
performer: system
strictness: strict
reads: [case.plugin]
tools:
  allowed:  [plugins.propose_binding]
  required: [plugins.propose_binding]
map:
  plugins.propose_binding: { plugin: case.plugin }
outcomeFrom: { tool: plugins.propose_binding, field: outcome }
writes:
  draft:        { type: Text, from: { tool: plugins.propose_binding, field: draft } }
  unclassified: { type: Text, from: { tool: plugins.propose_binding, field: unclassified } }
  gaps:         { type: Number, from: { tool: plugins.propose_binding, field: gaps } }
  summary:      { type: Text, from: { tool: plugins.propose_binding, field: summary } }
  version:      { type: Text, from: { tool: plugins.propose_binding, field: version } }
outcomes: [classified, unclassified]
---
Propose how the plugin binds into this domain, without a model: tool classes from the plugin's
own declarations, else its MCP hints; its entities, fields and roles matched to the domain's by
name and type; each capability it needs from the only provider; its record sources mapped with
identity keys from identifier and email fields. The proposal goes into a binding draft; what it
could not decide goes into the summary. A tool nobody classified goes to the binder first.
