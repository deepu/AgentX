---
title: Screen the new papers
performer: person
assignee: reviewer
strictness: strict
reads: [case.topic, case.new_articles, case.screening]
writes:
  screening: List<ScreeningRow>
review: { kind: table, items: case.screening }
outcomes: [done]
---
One row per new paper, with the screener's suggestion and why. Accept the suggestions you agree
with and change the decision where you don't; open a paper to read its abstract. When every row is
decided, finish: the screenings are recorded on the topic.

You can change a decision later on the screening's page.
