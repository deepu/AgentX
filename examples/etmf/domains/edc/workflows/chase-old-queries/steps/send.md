---
title: Send the reminders
performer: system
strictness: strict
reads: [case.reminders]
tools:
  allowed:  [email.send]
  required: [email.send]
map:
  email.send:
    each:    case.reminders
    to:      item.to
    subject: item.subject
    body:    item.body
outcomes: [sent]
---
Email each site's coordinator their reminder. Every email is outgoing, so each one waits for a
person to approve its exact text first.
