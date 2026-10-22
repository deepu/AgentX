---
title: Email the digest
performer: system
strictness: strict
reads: [case.recipients, case.subject, case.digest]
tools:
  allowed:  [email.send]
  required: [email.send]
map:
  email.send:
    to:      case.recipients
    subject: case.subject
    body:    case.digest
outcomes: [sent]
---
Email the digest to the team.
