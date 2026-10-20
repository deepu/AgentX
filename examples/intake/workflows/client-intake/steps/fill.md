---
title: Client fills in the intake form
performer: external
assignee: staff                # staff fill the form on the client's behalf until external links arrive
strictness: strict
writes:
  client_name:     { type: PersonName, from: person }
  client_email:    { type: Email, from: person }
  pan:             { type: Identifier(PAN), from: person }
  gstin:           { type: Identifier(GSTIN), from: person }
  annual_turnover: { type: Money, from: person }
  documents:       { type: List<Document>, from: person }
outcomes: [submitted]
---
The client enters their details and uploads their PAN card and GST certificate.
Until clients can be sent a link to the form, a member of staff fills it in for them.
