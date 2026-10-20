---
title: Client fills in the intake form
performer: external
assignee: staff                # staff can still fill the form for the client
strictness: strict
writes:
  client_name:     { type: PersonName, from: person }
  client_email:    { type: Email, from: person }
  pan:             { type: Identifier(PAN), from: person }
  gstin:           { type: Identifier(GSTIN), from: person }
  annual_turnover: { type: Money, from: person }
  documents:       { type: List<Document>, from: person }
extract:
  tool: intake.extract_fields
  documents: documents
  fields: [pan, gstin, client_name]
  min_confidence: 0.8
outcomes: [submitted]
---
Enter your details and upload your PAN card and GST certificate. Once a document is uploaded,
the form can read your PAN and GSTIN from it for you to check.
