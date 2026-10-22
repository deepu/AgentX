---
title: Put the draft on the enquiry
performer: system
strictness: strict
reads: [case.enquiry, case.reply, case.references, case.pages]
tools:
  allowed:  [literature.enquiry.update, literature.enquiry.transition]
  required: [literature.enquiry.update, literature.enquiry.transition]
map:
  literature.enquiry.update:
    id:         case.enquiry
    reply:      case.reply
    references: case.references
    pages:      case.pages
  literature.enquiry.transition:
    id:         case.enquiry
    transition: draft
outcomes: [done]
---
The draft goes on the enquiry, which now waits for the medical lead.
