---
name: crm-etiquette
description: How to work with contacts in the sample CRM without making a mess of it.
---
# CRM etiquette

- Look a company up with `list_contacts` before creating it: the same company is often there under a
  slightly different name ("Pvt Ltd" or not).
- Match on the GST number first, then the email, then the name.
- When you create a contact, pass an `idempotency_key`, so a retry never makes a second one.
- Never invent a GST number; leave it out when you don't have it.
