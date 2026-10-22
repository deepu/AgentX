---
title: Write the digest
performer: agent
strictness: guided
model: writer
reads: [case.recipients]
writes:
  subject: Text
  digest:  Text
tools:
  allowed:  [page.list, page.get]
  required: [page.list]
budget: { modelCalls: 12 }
outcomes: [written, nothing]
---
List the project's kept pages (`page.list`) and read the ones whose answer changed in the last
month (their `last_refresh` was accepted then), with `page.get`. Write one digest for the medical
affairs team: a line for each page that changed, saying what changed and linking the papers, then
the pages where nothing changed, in one line. Plain words, no promotion. Write the email's subject
("Literature digest, June 2026").

Finish with **nothing** when no page is kept yet.
