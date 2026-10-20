-- Our tables. Statechart state lives here, not in DBOS (decision D24 / 07 §2).
create schema if not exists mw;

-- One row per run: the persisted XState snapshot plus a sequence number used as an
-- optimistic-concurrency guard (compare-and-set) for every transition.
create table if not exists mw.runs (
  id            text primary key,
  workflow      text not null,                 -- 'intake'
  version       int  not null default 1,
  state         text not null,                 -- snapshot.value, denormalised for queries
  status        text not null,                 -- 'active' | 'done'
  snapshot      jsonb not null,                -- machine.getPersistedSnapshot(snapshot)
  seq           int  not null default 0,       -- number of events applied so far
  entered_seq   int  not null default 0,       -- seq at which the current state was entered
  driver_wf_id  text not null,                 -- DBOS workflow id of the run driver
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Append-only log: one row per event consumed by the run (accepted or ignored).
-- The primary key (run_id, seq) makes a double transition impossible.
create table if not exists mw.transitions (
  run_id       text not null references mw.runs(id),
  seq          int  not null,
  from_state   text not null,
  to_state     text not null,
  event        jsonb not null,
  source       text not null,                  -- 'step' | 'external' | 'timer'
  accepted     boolean not null,               -- false: ignored (not handled in this state, or stale)
  note         text,                           -- why it was ignored
  step_wf_id   text,                           -- DBOS workflow id of the step that produced the event
  at           timestamptz not null default now(),
  primary key (run_id, seq)
);

-- Durable timers from XState delayed transitions (`after`), with an absolute deadline.
create table if not exists mw.timers (
  run_id      text not null references mw.runs(id),
  timer_id    text not null,                   -- XState send id, e.g. xstate.after.approvalTimeout.intake.approve
  armed_seq   int  not null,                   -- seq of the transition that armed it
  event       jsonb not null,                  -- event to deliver when it fires
  fire_at     timestamptz not null,
  status      text not null,                   -- 'pending' | 'fired' | 'cancelled'
  primary key (run_id, timer_id, armed_seq)
);

-- External events (human approvals) as written by the app; the same transaction also
-- sends the DBOS message, so the two cannot disagree.
create table if not exists mw.inbox (
  run_id     text not null references mw.runs(id),
  idem_key   text not null,
  event      jsonb not null,
  at         timestamptz not null default now(),
  primary key (run_id, idem_key)
);

-- Fake side effects done by steps, one row per *execution*, so duplicates are visible.
create table if not exists mw.effects (
  id         bigserial primary key,
  run_id     text not null,
  step_wf_id text not null,
  name       text not null,
  pid        int  not null,
  at         timestamptz not null default now()
);
