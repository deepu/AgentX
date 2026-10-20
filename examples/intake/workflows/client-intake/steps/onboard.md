---
title: Create the customer
performer: system
strictness: strict
reads: [case.client_name, case.client_email, case.gstin, case.pan]
writes:
  customer: { type: Ref<Customer>, from: tool crm.create_customer }
tools:
  allowed:  [crm.create_customer]
  required: [crm.create_customer]
outcomes: [done]
---
Create the customer from the approved case. (Mechanical steps run in Phase 2.)
