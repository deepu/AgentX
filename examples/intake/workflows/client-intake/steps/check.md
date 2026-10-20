---
title: Check the client's answers
performer: agent
strictness: guided
reads:  [case.client_name, case.client_email, case.pan, case.gstin, case.annual_turnover, case.documents]
writes:
  gstin_ok:   { type: Boolean, from: { tool: gst.validate_gstin, field: valid } }
  legal_name: { type: Text, from: { tool: gst.validate_gstin, field: legal_name } }
  flags:      List<Flag>
tools:
  allowed:  [gst.validate_gstin, intake.extract_fields, email.send, recall.step_record, recall.similar_cases]
  required: [gst.validate_gstin]
model: checker
budget: { tokens: 40k, time: 10m, modelCalls: 12 }
checkpoint:
  - every flag names the document it came from
outcomes: [checked, needs_info, failed]
---
## What to do

Validate the client's GSTIN with the GST lookup, and record whether it is valid and the
legal name it is registered to.

Compare what the client typed with what was extracted from their documents. Flag any
mismatch, and say which document it came from.

If anything is missing or doesn't match, email the client at their address on the case.
Say exactly what is missing or wrong, politely and in plain words, then finish with
`needs_info`. If everything matches, finish with `checked`. If the GSTIN is not valid at
all, finish with `failed`.
