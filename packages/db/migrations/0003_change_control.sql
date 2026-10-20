-- Phase 3: change control (PHASE 3 CONTRACT, docs/memwise/20-phase-3-interfaces.md §2).
-- Drafts are plain files in the project folder (drafts/<id>/); the database keeps only the
-- version index: which content hash of a playbook was live as which version, and how it got there.

create table mw.workflow_versions (
  workflow_id   text not null,
  version       int not null,                    -- the `version:` in workflow.yaml
  hash          text not null,                   -- the workflow hash (mw.definitions, mw.runs.workflow_hash)
  published_at  timestamptz not null default now(),
  published_by  text,                            -- person id of whoever approved it (source app)
  source        text not null,                   -- app | cli | files
  draft_id      text,
  run_id        text,                            -- the create-playbook / change-playbook run
  primary key (workflow_id, hash)
);
create index workflow_versions_latest on mw.workflow_versions (workflow_id, published_at desc);

-- People read the index; the kernel (as system) writes it, when indexing and publishing.
grant select on mw.workflow_versions to memwise_app;
