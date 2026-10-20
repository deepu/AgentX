---
title: Create the customer
performer: system
strictness: strict
reads: [case.client_name, case.client_email, case.gstin, case.pan]
tools:
  allowed:  [domain.customer.create]
  required: [domain.customer.create]
map:
  domain.customer.create:
    name:  case.client_name
    email: case.client_email
    gstin: case.gstin
    pan:   case.pan
writes:
  customer: { type: Ref<Customer>, from: { tool: domain.customer.create, field: id } }
outcomes: [done]
---
Create the customer from the approved case: their name, email, GSTIN and PAN go into the
customer records, and the case keeps a link to the new customer.
