---
title: File it in the TMF
performer: system
strictness: strict
reads: [case.document, case.expected_document]
tools:
  allowed:  [etmf.document.transition, etmf.expected_document.transition]
  required: [etmf.document.transition, etmf.expected_document.transition]
map:
  etmf.document.transition:
    id:         case.document
    transition: file
  etmf.expected_document.transition:
    id:         case.expected_document
    transition: filed
outcomes: [filed]
---
File the original with its index and the specialist's signature, and tick it off the study's
expected documents.
