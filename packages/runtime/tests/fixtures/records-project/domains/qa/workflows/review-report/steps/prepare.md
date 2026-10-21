---
title: Mark it ready for review
performer: system
strictness: strict
reads: [case.report]
tools:
  allowed:  [qa.report.update]
  required: [qa.report.update]
map:
  qa.report.update:
    id:      case.report
    remarks: Ready for review
outcomes: [done]
---
Mark the report as ready for review.
