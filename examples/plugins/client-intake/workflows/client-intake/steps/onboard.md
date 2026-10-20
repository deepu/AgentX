---
title: Create the client
performer: system
strictness: strict
reads: [case.client_name, case.client_email, case.gstin, case.pan]
tools:
  allowed:  [domain.client.create]
  required: [domain.client.create]
map:
  domain.client.create:
    name:   case.client_name
    email:  case.client_email
    tax_id: case.gstin
    pan:    case.pan
writes:
  customer: { type: Ref<Client>, from: { tool: domain.client.create, field: id } }
outcomes: [done]
---
Create the client from the approved case: their name, email, GSTIN and PAN go into the
domain's client records, and the case keeps a link to the new client.
