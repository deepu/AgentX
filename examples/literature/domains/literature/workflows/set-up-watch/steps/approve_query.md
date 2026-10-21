---
title: Approve the search
performer: person
assignee: lead
strictness: strict
reads: [case.topic, case.query, case.inclusion, case.found_count, case.sample]
writes:
  query:         Text
  inclusion:     Text
  query_comment: Text
outcomes: [approved, redo]
---
You see the search the searcher drafted, how many papers it finds and the first five. Change the
search or the inclusion rules if you need to, then approve it: the topic becomes active and is
searched every week from today.

Choose **redo** to send it back to the searcher, and say in the comment what is wrong, for example
"too wide: only randomised trials" or "add semaglutide tablets".
