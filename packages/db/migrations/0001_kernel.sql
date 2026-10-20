-- Phase 1 kernel schema (PHASE 1 CONTRACT: every kernel package codes against these tables).
-- Statechart state lives here, not in DBOS (D39). DBOS keeps its own journal in schema "dbos".
-- Later changes go in new numbered files; never edit an applied migration.

create schema if not exists mw;

-- ------------------------------------------------------------------ definitions index (D13)

-- One row per definition per content hash. Files stay the source of truth.
create table mw.definitions (
  kind        text not null,              -- workflow | step | case_type | entity_type | policy
  id          text not null,              -- client-intake, client-intake/check, Customer, domain
  hash        text not null,
  version     int,
  path        text not null,              -- relative to the project root
  body        jsonb not null,             -- parsed definition; for workflows the whole run snapshot
  indexed_at  timestamptz not null default now(),
  primary key (kind, id, hash)
);
create index definitions_latest on mw.definitions (kind, id, indexed_at desc);

-- What each definition refers to, for impact analysis.
create table mw.definition_refs (
  from_kind  text not null,
  from_id    text not null,
  from_hash  text not null,
  to_kind    text not null,               -- a definition kind, or tool | model_role | case_field
  to_id      text not null,
  primary key (from_kind, from_id, from_hash, to_kind, to_id)
);
create index definition_refs_to on mw.definition_refs (to_kind, to_id);

-- ------------------------------------------------------------------ cases (04 §7)

create table mw.cases (
  id             text primary key,
  case_type      text not null,
  workflow_id    text not null,
  workflow_hash  text not null,
  values         jsonb not null default '{}'::jsonb,  -- field -> { value, provenance }
  seq            int not null default 0,              -- number of change events applied
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Append-only: one row per field change (the case's event log).
create table mw.case_events (
  case_id      text not null references mw.cases(id),
  seq          int not null,
  field        text not null,
  value        jsonb,
  provenance   jsonb not null,
  step_run_id  text,
  at           timestamptz not null default now(),
  primary key (case_id, seq, field)
);

-- ------------------------------------------------------------------ runs (D39, from spike S5)

create table mw.runs (
  id                text primary key,
  workflow_id       text not null,
  workflow_version  int not null,
  workflow_hash     text not null,               -- the definition snapshot this run is pinned to (D36)
  case_id           text not null references mw.cases(id),
  state             text not null,               -- snapshot.value, denormalised
  status            text not null,               -- active | done | stopped
  snapshot          jsonb not null,              -- XState persisted snapshot
  seq               int not null default 0,      -- events applied; CAS guard for every transition
  entered_seq       int not null default 0,      -- seq at which the current state was entered
  driver_wf_id      text not null,               -- DBOS workflow id of the run driver
  stop_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index runs_case on mw.runs (case_id);

-- Append-only: one row per event the run consumed (accepted or ignored).
create table mw.transitions (
  run_id       text not null references mw.runs(id),
  seq          int not null,
  from_state   text not null,
  to_state     text not null,
  event        jsonb not null,
  source       text not null,                    -- step | external | timer
  accepted     boolean not null,
  note         text,
  step_run_id  text,
  at           timestamptz not null default now(),
  primary key (run_id, seq)
);

-- Durable timers with an absolute deadline (waits, reminders, timeouts).
create table mw.timers (
  run_id     text not null references mw.runs(id),
  timer_id   text not null,
  armed_seq  int not null,
  event      jsonb not null,
  fire_at    timestamptz not null,
  status     text not null,                      -- pending | fired | cancelled
  primary key (run_id, timer_id, armed_seq)
);

-- Outside events (a person's answer, a client submission). Written in the same transaction
-- that sends the DBOS message; `for_seq` names the state entry being answered.
create table mw.inbox (
  run_id     text not null references mw.runs(id),
  idem_key   text not null,
  event      jsonb not null,
  for_seq    int,
  at         timestamptz not null default now(),
  primary key (run_id, idem_key)
);

-- ------------------------------------------------------------------ step records (05 §11)

create table mw.step_runs (
  id                text primary key,            -- ${runId}/${enteredSeq}/${stepId}; also the DBOS workflow id
  run_id            text not null references mw.runs(id),
  case_id           text not null references mw.cases(id),
  step_id           text not null,
  attempt           int not null default 1,
  workflow_id       text not null,
  workflow_version  int not null,
  workflow_hash     text not null,
  step_hash         text not null,
  performer         text not null,
  status            text not null,               -- running | waiting | completed | needs_person | failed
  outcome           text,
  token             jsonb not null,
  context           jsonb,                       -- AssembledContext: exactly what the agent saw
  outputs           jsonb not null default '{}'::jsonb,
  checkpoint        jsonb not null default '[]'::jsonb,
  rationale         text,
  usage             jsonb not null default '{}'::jsonb,
  tainted           boolean not null default false,
  started_at        timestamptz not null,
  finished_at       timestamptz
);
create index step_runs_case on mw.step_runs (case_id, started_at);
create index step_runs_step on mw.step_runs (workflow_id, step_id, finished_at desc);

-- Every journaled call in a step run (model, policy, tool, approval, checkpoint).
create table mw.step_journal (
  step_run_id  text not null references mw.step_runs(id),
  journal_key  text not null,                    -- the DBOS step name; unique per step run
  kind         text not null,
  name         text not null,
  call_id      text,
  request      jsonb,
  response     jsonb,
  error        text,
  effect       text,
  model        jsonb,                            -- { provider, model, usage, stopReason }
  attempt      int,
  started_at   timestamptz not null,
  duration_ms  int,
  primary key (step_run_id, journal_key)
);

-- ------------------------------------------------------------------ effects and approvals (07 §2, §4)

-- The effect ledger: one row per idempotency key. An effect whose key is `done` never runs again.
create table mw.effects (
  idempotency_key  text primary key,
  step_run_id      text not null,
  tool             text not null,
  effect           text not null,
  args             jsonb,
  status           text not null,                -- pending | done | failed
  result           jsonb,
  error            text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index effects_step on mw.effects (step_run_id);

create table mw.approvals (
  id            text primary key,                -- ${stepRunId}:${callId}
  step_run_id   text not null,
  tool          text not null,
  effect        text not null,
  treatment     text not null,
  args          jsonb,
  preview       jsonb not null,
  status        text not null,                   -- pending | approved | rejected
  decided_by    text,
  comment       text,
  requested_at  timestamptz not null,
  decided_at    timestamptz
);
create index approvals_pending on mw.approvals (status, requested_at);
