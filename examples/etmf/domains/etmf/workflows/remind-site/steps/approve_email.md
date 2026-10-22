---
title: Approve the email
performer: person
assignee: study_manager
strictness: guided
reads: [case.site, case.missing_documents, case.reminders_sent, case.email_to, case.email_cc]
writes:
  email_subject: Text
  email_body:    Text
outcomes: [approved, escalate]
---
Read the reminder before it goes to the site. Change the subject or the wording if you want to, then
approve it. Choose **escalate** when reminding again won't help and the CRA should raise it at the
next visit.
