---
title: Update the page
performer: system
strictness: strict
reads: [case.change]
tools:
  allowed:  [page.accept_change]
  required: [page.accept_change]
map:
  page.accept_change: { change: case.change }
outcomes: [done]
---
The accepted change becomes the page's current version, with a history line naming who accepted it.
