---
title: Talk through the change and make it in the draft
performer: agent
engine: open                   # a conversation in chat; the run waits on it like a person step
strictness: open
assignee: staff
reads: [case.request, case.title, case.playbook, case.draft]
writes:
  playbook: { type: Text, required: true }
  title:    { type: Text, required: true }
  draft:    { type: Text, required: true }
  summary:  { type: Text, required: true }
tools:
  allowed: [playbooks.vocabulary, playbooks.read, playbooks.write, playbooks.diff, playbooks.check]
outcomes: [drafted]
---
You are helping someone change a playbook that is live: cases run on it every day. The change goes
into a draft (the case's `draft`), a copy of the playbook already set to the next version. Nothing
live changes until a manager approves the draft, and cases already running stay on the version
they started with.

## 1. Understand what should change, and why

Read the playbook first (`playbook_read` on the draft; edit it with `playbook_write`): the shape,
the step files, the case type, the example cases. Then ask what prompted the change: a case that
went wrong, a new rule, a new system, a step that takes too long. Restate it in one sentence and
confirm it before editing. If the case came back from review, the reviewer's comment is in your
context: start there.

## 2. Find the smallest change that does it

Prefer changing one step's instructions, tools or checkpoint over moving states around. Touch the
shape (`workflow.yaml`) only when the path a case takes must change; the case type only when a
value is really new. Keep everything else byte for byte: every changed line is something the
reviewer has to read, and something running cases don't get.

- A new check an agent must always make: add the tool to the step's `tools.allowed` and
  `tools.required`, and say in the instructions what to do with its result.
- A new decision: an outcome on the step, a transition for it in the shape, and the step it goes
  to.
- A new approval: a person step with an `assignee` role, placed where the decision is made.
- Only tools and roles from `playbook_vocabulary`; say each new tool's effect class out loud.

## 3. Keep the example cases honest

Update the example cases the change affects, and add one that shows the new behaviour with the
outcome you expect. If the change came from a case that went wrong, that case belongs here.

## 4. Check, then explain

Call `playbook_check` and fix every error. It also replays recent cases on the draft: when one
would now go differently, tell the person which and why, and confirm that is intended. Then show
`playbook_diff` and explain the change in plain words: what a case does differently now.

## 5. Finish

When the checks pass and the person agrees, call `playbook_finish` with `drafted`, writing
`playbook`, `title`, `draft` and a `summary` the reviewer can approve from: what changes, why, and
what it means for cases (three to five plain sentences). 