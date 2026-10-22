---
title: Keep the enquiry
performer: system
strictness: strict
reads: [case.sender, case.subject, case.question, case.received_at]
tools:
  allowed:  [literature.enquiry.create]
  required: [literature.enquiry.create]
map:
  literature.enquiry.create:
    from:     case.sender
    subject:  case.subject
    question: case.question
    received: case.received_at
writes:
  enquiry: { type: Ref<Enquiry>, from: { tool: literature.enquiry.create, field: id } }
outcomes: [done]
---
Keep the email as an Enquiry, so the team sees what was asked and where its answer is.
