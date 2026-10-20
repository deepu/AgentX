---
title: Client fills in the intake form
performer: external
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
(The form and the external link arrive in Phases 2 and 5.)
