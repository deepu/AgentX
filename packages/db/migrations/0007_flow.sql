-- Phase 6, the flow piece: entity events delivered to their consumers, triggers and their
-- firings, incoming messages, hand-offs between cases and entity state timers
-- (PHASE 6 CONTRACT, docs/memwise/24-phase-6-interfaces.md §7, §8, §10).
-- The events themselves are mw.entity_events (0006_domains_and_records.sql).

-- ------------------------------------------------------------------ the dispatcher (24 §7)

-- The exactly-once ledger: one row per event and consumer that handled it. A consumer that keeps
-- failing is given up on after a few tries: its row then holds the error.
create table mw.event_deliveries (
  event_id  text not null,                         -- mw.entity_events.id, or an mw.inbound_events id
  consumer  text not null,                         -- waits | timers | triggers | invariants | links | email-inbound …
  at        timestamptz not null default now(),
  error     text,
  primary key (event_id, consumer)
);

-- ------------------------------------------------------------------ triggers (24 §7)

-- One row per firing. The key says what fired (`entered:<trigger>:<event id>`,
-- `date:<trigger>:<record>:<date>`, `every:<trigger>:<slot>`, `message:<trigger>:<message id>`)
-- and the run id is derived from it, so a firing retried after a crash starts nothing new.
create table mw.trigger_firings (
  key            text primary key,
  trigger_id     text not null,                   -- <workflowId>#<index>
  workflow_id    text not null,
  trigger_index  int not null,
  kind           text not null,                   -- entered | created | changed | date | every | message
  record         text,                            -- the record (entity triggers, date triggers) or message id
  run_id         text,
  case_id        text,
  status         text not null check (status in ('started', 'held', 'discarded', 'failed')),
  message        text,                            -- why it failed, or who released it
  "values"       jsonb not null default '{}'::jsonb,  -- the case values it starts with (a held firing starts them later)
  acts_for       text,                            -- the role the case runs as
  at             timestamptz not null default now(),
  decided_at     timestamptz
);
create index trigger_firings_trigger on mw.trigger_firings (trigger_id, at);
create index trigger_firings_held on mw.trigger_firings (trigger_id) where status = 'held';

-- Schedules' next slot, and the dispatcher's cursor (trigger_id `dispatcher`).
create table mw.trigger_state (
  trigger_id     text primary key,
  next_due       timestamptz,
  last_fired_at  timestamptz,
  cursor         jsonb not null default '{}'::jsonb
);

-- ------------------------------------------------------------------ incoming messages (24 §10)

create table mw.inbound_messages (
  id           text primary key,                  -- msg_<ulid>
  domain       text not null,
  message_id   text not null,                     -- the sender's Message-ID
  from_addr    text not null,
  to_addr      text not null,
  subject      text,
  received_at  timestamptz not null default now(),
  body         jsonb not null default '{}'::jsonb,  -- text and html (attachments are files)
  files        jsonb not null default '[]'::jsonb,  -- DocumentValue[]
  unique (domain, message_id)
);

-- ------------------------------------------------------------------ hand-offs (24 §8)

-- A case a block state started or called. One row per (parent entry, item), so a retried
-- hand-off finds its child instead of making another.
create table mw.case_links (
  parent_run_id   text not null,
  parent_case_id  text not null,
  parent_state    text not null,
  entered_seq     int not null,
  item_index      int not null default 0,
  child_run_id    text not null,
  child_case_id   text,
  child_workflow  text not null,
  kind            text not null check (kind in ('started', 'called')),
  outcome         text,                           -- called: the child's last event, or `failed`
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  unique (parent_run_id, entered_seq, parent_state, item_index)
);
create index case_links_child on mw.case_links (child_run_id);
create index case_links_parent_case on mw.case_links (parent_case_id);
create index case_links_child_case on mw.case_links (child_case_id);

-- Work a run's commit hands to the dispatcher, written in the same transaction: start or call
-- children, evaluate a wait, send a child's outcome to its parent, stop called children.
-- status: pending → done; a wait_until that does not hold yet stays `waiting` (re-checked on the
-- record's events) until it is met or its state is left (`left`).
create table mw.run_outbox (
  id          bigserial primary key,
  run_id      text not null,
  kind        text not null,                      -- start | call | for_each | wait_until | outcome | cascade
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',
  attempts    int not null default 0,
  error       text,
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index run_outbox_pending on mw.run_outbox (id) where status = 'pending';
create index run_outbox_waiting on mw.run_outbox ((payload ->> 'entity'), (payload ->> 'recordId')) where status = 'waiting';
create index run_outbox_run on mw.run_outbox (run_id);

-- Who a triggered case's steps act for (the trigger's `as`, else the workflow owner).
alter table mw.runs add column if not exists acts_for text;

-- ------------------------------------------------------------------ entity state timers (24 §4)

-- `after:` timers of a record's lifecycle state, armed when it enters the state and cancelled
-- when it leaves. `entered_event` is the event that entered it; one timer per (event, index).
create table mw.entity_timers (
  id             text primary key,                -- <entered event id>:<index>
  entity         text not null,
  record_id      text not null,
  state          text not null,
  entered_event  text not null,
  fire_at        timestamptz not null,
  action         jsonb not null,                  -- { afterMs, remind?: role, transition?: name }
  status         text not null default 'pending' check (status in ('pending', 'fired', 'cancelled', 'failed')),
  message        text,
  created_at     timestamptz not null default now()
);
create index entity_timers_due on mw.entity_timers (fire_at) where status = 'pending';
create index entity_timers_record on mw.entity_timers (entity, record_id) where status = 'pending';

-- A reminder about a record has no run.
alter table mw.notifications alter column run_id drop not null;
alter table mw.notifications add column if not exists entity text;
alter table mw.notifications add column if not exists record_id text;

-- ------------------------------------------------------------------ grants and notifications

grant select on mw.trigger_firings, mw.trigger_state, mw.inbound_messages, mw.case_links, mw.entity_timers to memwise_app;

-- The dispatcher wakes on its own work; the Automations screen follows firings.
create or replace function mw.notify_flow_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', '{"kind":"flow"}');
  return null;
end $$;

create or replace function mw.notify_triggers_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', '{"kind":"triggers"}');
  if new.status = 'held' or (tg_op = 'UPDATE' and old.status = 'held') then
    perform pg_notify('mw_changes', '{"kind":"inbox"}');
  end if;
  return null;
end $$;

create trigger run_outbox_notify after insert on mw.run_outbox
  for each row execute function mw.notify_flow_change();
create trigger trigger_firings_notify after insert or update on mw.trigger_firings
  for each row execute function mw.notify_triggers_change();
