---
title: Check the client's answers
performer: agent
reads: [case.client_name, case.client_email, case.gstin]
writes:
  gstin_ok: { type: Boolean, from: { tool: gst.validate_gstin, field: valid } }
tools:
  allowed:  [gst.validate_gstin, email.send]
  required: [gst.validate_gstin]
model: checker
outcomes: [checked, needs_info]
---
Validate the GSTIN. If anything is missing, email the client and finish with `needs_info`.
