---
title: Staff ask for an engagement letter
performer: person
assignee: staff
strictness: strict
writes:
  client_name:  { type: PersonName, from: person }
  client_email: { type: Email, from: person }
  scope:        { type: Text, from: person }
  fee:          { type: Money, from: person }
  start_date:   { type: Date, from: person }
outcomes: [submitted]
---
A member of staff asks for an engagement letter for a customer we have onboarded: who it is for,
the scope of the work in plain words, the fee and when the engagement starts.
