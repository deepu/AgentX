---
title: Receive the document
performer: system
strictness: strict
reads: [case.original, case.sender, case.received_at]
tools:
  allowed:  [etmf.document.create]
  required: [etmf.document.create]
map:
  etmf.document.create:
    file:        case.original
    sender:      case.sender
    received_at: case.received_at
writes:
  document: { type: Ref<Document>, from: { tool: etmf.document.create, field: id } }
outcomes: [done]
---
Save the file exactly as it arrived, with who sent it and when. The file is stored with a fingerprint,
so anyone can prove later that it hasn't changed. The original file is never changed.
