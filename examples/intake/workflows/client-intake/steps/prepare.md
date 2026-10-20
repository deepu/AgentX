---
title: Say who the client is
performer: person
assignee: staff
strictness: strict
writes:
  client_name:  { type: PersonName, from: person, required: true }
  client_email: { type: Email, from: person }
  client_phone: { type: Phone, from: person }
  contact_by:   { type: "Enum[email, whatsapp]", from: person }
outcomes: [send_link, fill_for_client]
---
Enter the client's name and how to reach them: their email address, their phone number, or
both, and which one to use.

Choose **send link** to send the client a link to the intake form by email or WhatsApp. Choose
**fill for client** to fill in the form yourself, for example when the client is with you.
