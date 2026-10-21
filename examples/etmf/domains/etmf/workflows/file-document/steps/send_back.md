---
title: Mark it sent back
performer: system
strictness: strict
reads: [case.document]
tools:
  allowed:  [etmf.document.transition]
  required: [etmf.document.transition]
map:
  etmf.document.transition:
    id:         case.document
    transition: send_back
outcomes: [done]
---
Mark the document as sent back, so it is not filed. "Fix a rejected document" takes it from here.
