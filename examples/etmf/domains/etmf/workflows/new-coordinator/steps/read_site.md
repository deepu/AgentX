---
title: Read the site
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
  site_number:       { type: Text, from: { tool: etmf.site.get, field: site_number } }
  study:             { type: Ref<Study>, from: { tool: etmf.site.get, field: study } }
  coordinator:       { type: PersonName, from: { tool: etmf.site.get, field: coordinator } }
  coordinator_email: { type: Email, from: { tool: etmf.site.get, field: coordinator_email } }
  coordinator_since: { type: Date, from: { tool: etmf.site.get, field: coordinator_since } }
outcomes: [done]
---
Read the site as it is now: its number, study and the coordinator EDC names for it, with their
email and start date. The coordinator comes from EDC (Medidata Rave), read through the link.
