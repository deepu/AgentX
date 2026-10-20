---
title: Publish the new version
performer: system
strictness: strict
reads: [case.draft, case.checked_hash]
tools:
  allowed:  [playbooks.publish_draft]
  required: [playbooks.publish_draft]
map:
  playbooks.publish_draft: { draft: case.draft, hash: case.checked_hash }
outcomeFrom: { tool: playbooks.publish_draft, field: outcome }
writes:
  version: { type: Number, from: { tool: playbooks.publish_draft, field: version } }
outcomes: [published, stale]
---
Publish the approved draft as the playbook's next version, recording who approved it. If the
draft changed after it was checked, nothing is published and it is checked again. Cases already
running stay on the version they started with; new cases start on this one.
