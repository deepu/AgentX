---
title: Link records
performer: system
strictness: strict
reads: [case.plugin]
tools:
  allowed:  [identity.resolve]
  required: [identity.resolve]
map:
  identity.resolve: { plugin: case.plugin }
writes:
  linked:     { type: Number, from: { tool: identity.resolve, field: linked } }
  candidates: { type: Number, from: { tool: identity.resolve, field: candidates } }
outcomes: [done]
---
For each record source the binding maps, link the plugin's records to the domain's: a match on an
identity key (a GSTIN, an email) links at once, a close name goes to a person in the inbox, and a
record that matches nothing is created or left unlinked, as the binding says.
