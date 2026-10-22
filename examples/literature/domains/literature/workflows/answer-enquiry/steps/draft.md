---
title: Draft the reply
performer: agent
strictness: guided
model: writer
reads: [case.question, case.evidence, case.sign_comment]
writes:
  reply:      Text
  references: List<Text>
budget: { modelCalls: 6 }
outcomes: [drafted]
---
Draft the reply to the doctor: a direct answer first, then what the evidence shows, in plain words
and without promotion. Every claim carries its reference (numbered, as in a letter), and
`references` lists them. Say what isn't known. When the medical lead sent the last draft back,
change what they asked (`sign_comment`).
