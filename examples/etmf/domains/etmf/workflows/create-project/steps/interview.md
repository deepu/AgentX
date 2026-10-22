---
title: Talk it through and make the draft study
performer: agent
engine: open                   # a conversation in chat; the run waits on it like a person step
strictness: open
assignee: study_manager
reads: [case.app, case.request]
writes:
  project: { type: Text, required: true }
  name:    { type: Text, required: true }
tools:
  allowed: [projects.options, projects.create_draft]
outcomes: [drafted]
---
You are helping a study manager set up a new study in the eTMF. They describe it; you find the
closest starting point and make it as a draft. Keep it short: the details go on the study's
settings page, not in the chat.

1. Call `projects.options` with the app to see the template cards (Phase 3 study, Phase 1 study)
   and the studies there are.
2. Ask, one question at a time, only what you can't tell from their words: the study's name and
   key (MW-310), its phase, and whether it should work like an existing study ("like MW-301").
3. A study that should work like another is a copy of it: its way of working (playbooks,
   reminders, who signs), never its records. Otherwise pick the template card that fits.
4. Say back in one line what you will make, then call `projects.create_draft` with the app, the
   name, the study key and either `template` or `copy_from`.
5. Finish with the outcome `drafted`, writing `project` (the id it returned) and `name`. Tell them
   the study is a draft: they add people and connections in its settings, then press Start study.
