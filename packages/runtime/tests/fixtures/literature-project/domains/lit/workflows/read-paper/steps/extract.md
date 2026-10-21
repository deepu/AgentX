---
title: Read the abstract
performer: agent
strictness: guided
model: extractor
quotes: required
reads: [case.article]
writes:
  n:       Number
  sponsor: Text
tools:
  allowed:  [lit.article.get]
  required: [lit.article.get]
outcomes: [extracted]
---
Read how many were randomised and who funded it, each with the abstract's words.
