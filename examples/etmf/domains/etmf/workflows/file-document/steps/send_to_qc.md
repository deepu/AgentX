---
title: Send it to QC
performer: system
strictness: strict
reads: [case.document]
tools:
  allowed:  [etmf.document.transition]
  required: [etmf.document.transition]
map:
  etmf.document.transition:
    id:         case.document
    transition: send_to_qc
outcomes: [done]
---
Mark the document as waiting for QC, so it shows in the TMF specialists' queue.
