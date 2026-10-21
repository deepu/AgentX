---
title: Sign the reply
performer: person
assignee: lead
strictness: strict
reads: [case.question, case.reply, case.references, case.evidence]
writes:
  reply:        Text
  sign_comment: Text
sign: "Approved as the reply to this enquiry"
outcomes: [signed, sent_back]
---
Read the doctor's question beside the reply and its references. Correct the reply if it needs it,
then sign it to send it; or send it back, saying what should change.

Your name, the time and the meaning of your signature are stored with the reply.
