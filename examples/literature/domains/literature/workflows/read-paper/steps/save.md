---
title: Save what was read
performer: system
strictness: strict
reads: [case.article, case.study_type, case.phase, case.n, case.sponsor, case.intervention, case.condition]
tools:
  allowed:  [literature.article.update, literature.article.transition]
  required: [literature.article.update, literature.article.transition]
map:
  literature.article.update:
    id:           case.article
    study_type:   case.study_type
    phase:        case.phase
    n:            case.n
    sponsor:      case.sponsor
    intervention: case.intervention
    condition:    case.condition
  literature.article.transition:
    id:         case.article
    transition: read
outcomes: [done]
---
Put the facts onto the paper's record and mark it read. Each value keeps the words it was read
from: the paper's page lights them up in the abstract.
