---
title: Keep the page as it is
performer: system
strictness: strict
reads: [case.change]
tools:
  allowed:  [page.send_back_change]
  required: [page.send_back_change]
map:
  page.send_back_change: { change: case.change }
outcomes: [done]
---
The change was sent back: the page keeps what it says, and its history says so.
