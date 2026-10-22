---
title: Rewrite the page
performer: agent
strictness: guided
model: writer
reads: [case.page, case.reason]
writes:
  body:         Text
  title:        Text
  label:        Text
  change_title: Text
  plus:         Text
  left_out:     List<LeftOut>
tools:
  allowed:  [page.get]
  required: [page.get]
budget: { modelCalls: 20 }
outcomes: [written]
---
Read the page (`page.get`): the question it answers, its body now, and when it was last refreshed.
Rewrite the body for the question as things stand now. Keep its layout: the headline paragraph
first, then its sections, tiles, charts and tables. Change only what is new or no longer true;
when nothing is new, write the body back unchanged.

A page that sums up its sub-pages (`sums_children`) gets its headline from its kept sub-pages
(`children`), one sentence for each that matters. Drafts (`drafts_left_out`) are not in the summary.

Every number keeps its source: a link, or in a table a quote of the sentence it came from.

Also write, when the answer changed: `label`, what was found, in a few words ("1 new trial");
`change_title`, what changed, for the page's history ("ATTAIN-MAINTAIN added"); `plus`, when the
headline stays, the one sentence the change adds; and `left_out`, what you looked at and left
out, each with why.
