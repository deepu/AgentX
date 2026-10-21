---
title: Release the report
performer: system
strictness: strict
reads: [case.report]
tools:
  allowed:  [qa.report.transition]
  required: [qa.report.transition]
map:
  qa.report.transition:
    id:         case.report
    transition: release
outcomes: [done]
---
Release the signed report.
