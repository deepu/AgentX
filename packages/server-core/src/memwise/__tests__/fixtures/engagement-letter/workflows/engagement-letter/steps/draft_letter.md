---
title: Draft the letter
performer: agent
strictness: guided
model: drafter
reads: [case.client_name, case.client_email, case.scope, case.fee, case.start_date]
writes:
  letter:           Text
  engagement_title: Text
outcomes: [drafted]
---
## What to do

Draft the engagement letter for the customer from the scope, the fee and the start date: who we
are working for, what we will do and what we will not, the fee and when it is billed, and when
the work starts. Keep it to one page, in plain words.

Give the engagement a short title (the work and the period, e.g. "Statutory audit FY 2026-27").

If the partner sent the letter back, their comment is on the case: change what they asked for and
nothing else.
