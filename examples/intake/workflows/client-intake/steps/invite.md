---
title: Send the client a link to the form
performer: system
strictness: strict
reads: [case.client_name, case.client_email, case.client_phone, case.contact_by, case.client_message]
tools:
  allowed:  [external.invite]
  required: [external.invite]
map:
  external.invite:
    step:  fill
    name:  case.client_name
    email: case.client_email
    phone: case.client_phone
    via:   case.contact_by
    note:  case.client_message
outcomes: [sent]
---
Send the client a single-use link to the intake form, by email or WhatsApp as the case says.
When the check asked the client to fix something, the message and the form show what.

A member of staff or a manager sees the exact message and approves it before it goes.
