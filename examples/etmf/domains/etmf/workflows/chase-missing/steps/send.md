---
title: Send, wait 5 days, remind again
performer: system
strictness: strict
reads: [case.site, case.email_to, case.email_cc, case.email_subject, case.email_body]
tools:
  allowed:  [etmf.reminder.create]
  required: [etmf.reminder.create]
map:
  etmf.reminder.create:
    site:    case.site
    sent_to: case.email_to
    subject: case.email_subject
    body:    case.email_body
    sent_at: { now: true }
outcomes: [sent]
---
Send the approved reminder to the site and keep it on the site's record, so the next round knows how
many reminders came before. Then the site has 5 days to upload; the next reminder goes out unless
the start-up pack is complete by then.
