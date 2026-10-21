---
title: Find the missing documents for the site
performer: system
strictness: strict
reads: [case.site]
tools:
  allowed:  [etmf.site.get]
  required: [etmf.site.get]
map:
  etmf.site.get:
    id: case.site
writes:
  missing_documents: { type: Number, from: { tool: etmf.site.get, field: missing_documents } }
  reminders_sent:    { type: Number, from: { tool: etmf.site.get, field: reminders_sent } }
  coordinator_email: { type: Email, from: { tool: etmf.site.get, field: coordinator_email } }
  cra_name:          { type: PersonName, from: { tool: etmf.site.get, field: cra_name } }
  cra_email:         { type: Email, from: { tool: etmf.site.get, field: cra_email } }
outcomes: [found]
---
Read the site's record: how many expected documents it still owes, how many reminders it has had,
and who its coordinator and CRA are.
