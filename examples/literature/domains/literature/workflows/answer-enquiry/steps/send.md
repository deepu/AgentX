---
title: Send the signed reply
performer: system
strictness: strict
reads: [case.enquiry, case.sender, case.subject, case.reply]
tools:
  allowed:  [email.send, literature.enquiry.update, literature.enquiry.transition]
  required: [email.send, literature.enquiry.update, literature.enquiry.transition]
map:
  email.send:
    to:      case.sender
    subject: case.subject
    body:    case.reply
  literature.enquiry.update:
    id:    case.enquiry
    reply: case.reply
  literature.enquiry.transition:
    id:         case.enquiry
    transition: send
outcomes: [sent]
---
Email the signed reply to the doctor who asked and mark the enquiry sent.
