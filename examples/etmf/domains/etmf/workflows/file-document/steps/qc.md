---
title: QC and sign
performer: person
assignee: tmf_specialist
strictness: strict
reads: [case.document, case.artifact, case.study, case.site, case.about, case.document_date, case.version]
writes:
  artifact:      Text
  site:          Ref<Site>
  about:         Ref<Person>
  document_date: Date
  version:       Text
  qc_comment:    Text
review: { kind: document, record: case.document }
sign: "Reviewed and approved for filing"
outcomes: [approved, sent_back]
---
You see the document next to the index the agent filled in and the checks. Correct anything that is
wrong, then approve and sign, or send it back to the site with a note.

Send it back when it isn't fit to file: not signed or dated where the artifact needs it, a CV signed
more than two years ago, an old version, or not legible. Your note goes to the site, so write it for
them.

Your name, the time and the meaning of your signature are stored with the document and can't be
changed later.
