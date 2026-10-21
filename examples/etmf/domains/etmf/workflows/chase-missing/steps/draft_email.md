---
title: Draft the reminder email
performer: agent
strictness: guided
model: writer
reads: [case.site, case.missing_documents, case.reminders_sent, case.coordinator_email, case.cra_name, case.cra_email]
writes:
  email_to:      Email
  email_cc:      Email
  email_subject: Text
  email_body:    Text
tools:
  allowed: [etmf.site.get, etmf.expected_document.list]
outcomes: [drafted]
---
Write a short reminder to the site coordinator about the documents the site still owes. List them
with `etmf.expected_document.list` (the site's expected documents whose status is missing) and name
each one plainly. Say what each is for only when it isn't obvious.

Keep it to four or five lines: who it is to, what is missing, by when, and that the upload link needs
no login. Say how many reminders came before, without blaming anyone. Send it to the coordinator
(`email_to`); copy someone else (`email_cc`) only when the study manager asked for it.
