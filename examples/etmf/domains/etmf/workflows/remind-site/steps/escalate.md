---
title: Escalate to the CRA if still missing after 3 reminders
performer: agent
strictness: guided
model: escalator
reads: [case.site, case.missing_documents, case.reminders_sent, case.cra_name]
writes:
  escalation: Text
tools:
  allowed: [etmf.expected_document.list]
outcomes: [escalated]
---
The site has had its reminders and still owes documents. Write a short note to the CRA to raise it
at the next monitoring visit: which documents, how long they have been requested, and how many
reminders went out.
