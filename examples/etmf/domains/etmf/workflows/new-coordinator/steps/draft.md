---
title: Add their documents and draft the request
performer: agent
strictness: guided
model: requester
reads: [case.site, case.site_number, case.study, case.coordinator, case.coordinator_email, case.coordinator_since]
writes:
  subject: Text
  body:    Text
tools:
  allowed:  [etmf.site.get, etmf.person.list, etmf.person.create, etmf.expected_document.list, etmf.expected_document.create]
  required: [etmf.expected_document.create]
budget: { modelCalls: 10 }
outcomes: [drafted, no_change]
---
EDC names a new study coordinator for this site. If the site has no coordinator now, or this person
is already on the site's staff with both documents expected or filed, finish with **no_change**.

Otherwise add them to the site's staff (a Person with the role Study Coordinator), and add two
expected documents to the site, both in the conduct phase and about this study: "CV, <name>
(coordinator)" and "GCP training, <name> (coordinator)". Leave out one the site already has.

Then write the email to the coordinator: welcome them to the study by its number, and ask for a
signed and dated CV and their GCP training certificate, sent to the eTMF address. Keep it short and
friendly, and sign it "The TMF team". Finish with **drafted**.
