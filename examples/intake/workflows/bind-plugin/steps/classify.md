---
title: Classify the unclassified tools
performer: agent
strictness: guided
reads: [case.plugin, case.version, case.draft, case.unclassified, case.summary]
tools:
  allowed:  [plugins.classify_tools]
  required: [plugins.classify_tools]
model: binder
budget: { tokens: 30k, time: 10m, modelCalls: 8 }
outcomes: [proposed, needs_person]
---
## What to do

The plugin's tools listed under `unclassified` have no effect class yet, so until a binding
gives them one they count as irreversible. Propose a class for every one of them with
`plugins.classify_tools`, writing the binding draft named in `draft`, with one plain reason per
tool.

Decide from what the tool says about itself: its name, its description, its MCP hints
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) and its arguments.

- `read`: only looks something up or lists records; changes nothing anywhere.
- `draft`: prepares something nobody sees until a person sends it.
- `write`: creates or changes a record in a system the business owns, and can be undone there.
- `outbound`: reaches someone outside (an email, a message, a filing, a payment request).
- `irreversible`: deletes, pays, or does anything that cannot be taken back.

When you are unsure between two classes, choose the stricter one: a person can loosen it in the
review, and a class that is too loose lets an effect through without anyone seeing it. A tool
that is described as read-only but takes arguments that could change something is not `read`.

Then finish with `proposed`. If a tool's description says too little to decide even the
stricter class with any confidence, still classify it as `irreversible`, say why, and finish with
`needs_person`.
