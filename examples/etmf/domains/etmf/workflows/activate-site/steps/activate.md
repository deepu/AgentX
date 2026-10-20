---
title: Open the site
performer: system
strictness: strict
reads: [case.site]
tools:
  allowed:  [etmf.site.transition]
  required: [etmf.site.transition]
map:
  etmf.site.transition:
    id:         case.site
    transition: approved
outcomes: [done]
---
Move the site to Open. The move is refused while the start-up pack isn't complete.
