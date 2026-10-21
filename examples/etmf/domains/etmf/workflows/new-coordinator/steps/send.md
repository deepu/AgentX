---
title: Ask the site
performer: system
strictness: strict
reads: [case.coordinator_email, case.subject, case.body]
tools:
  allowed:  [email.send]
  required: [email.send]
map:
  email.send:
    to:      case.coordinator_email
    subject: case.subject
    body:    case.body
outcomes: [sent]
---
Email the new coordinator. It is an outgoing message, so a person approves its exact text first.
