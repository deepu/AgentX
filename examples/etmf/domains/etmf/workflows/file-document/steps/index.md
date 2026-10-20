---
title: Write the index onto the document
performer: system
strictness: strict
reads: [case.document, case.artifact, case.study, case.site, case.about, case.document_date, case.version, case.expected_document]
tools:
  allowed:  [etmf.document.update, etmf.document.transition]
  required: [etmf.document.update, etmf.document.transition]
map:
  etmf.document.update:
    id:            case.document
    artifact:      case.artifact
    study:         case.study
    site:          case.site
    about:         case.about
    document_date: case.document_date
    version:       case.version
    fills:         case.expected_document
  etmf.document.transition:
    id:         case.document
    transition: index
outcomes: [done]
---
Put the index values the agent read onto the document's record, and mark it indexed.
