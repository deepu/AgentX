---
title: Check the plugin can be bound
performer: system
strictness: strict
reads: [case.plugin]
tools:
  allowed:  [plugins.install_check]
  required: [plugins.install_check]
map:
  plugins.install_check: { plugin: case.plugin }
outcomeFrom: { tool: plugins.install_check, field: outcome }
writes:
  summary: { type: Text, from: { tool: plugins.install_check, field: summary } }
  version: { type: Text, from: { tool: plugins.install_check, field: version } }
outcomes: [ok, missing]
---
Check that the plugin is installed, that every capability it requires has a provider among the
plugins already bound (or is optional), and that none of its tool names is taken. Say what it can
reach: its tools by effect class, its servers and the network it needs. Anything missing goes to
a manager.
