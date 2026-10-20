---
title: Create the client
performer: system
strictness: strict
reads: [case.client_name, case.client_email, case.gstin, case.pan, case.phone]
tools:
  allowed:  [domain.client.create]
  required: [domain.client.create]
map:
  domain.client.create:
    name:   case.client_name
    email:  case.client_email
    tax_id: case.gstin
    pan:    case.pan
    phone:  case.phone
writes:
  client: { type: Ref<Client>, from: { tool: domain.client.create, field: id } }
outcomes: [done]
---
Create the client from the approved case.
