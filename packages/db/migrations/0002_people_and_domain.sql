-- Phase 2: people, roles and actors (D32), domain tables and row rules (D31), uploads,
-- explanations, chat anchors, rate limits (PHASE 2 CONTRACT, docs/memwise/19-phase-2-interfaces.md).
-- Domain tables themselves are generated at index by syncEntityTables (schema `domain`), and
-- their row rules by compileRls; this file holds everything that does not depend on definitions.

-- ------------------------------------------------------------------ people and roles (19 §2)

create table mw.people (
  id             text primary key,               -- person_<ulid>
  name           text not null,
  email          text not null unique,           -- stored lower-cased
  password_hash  text,                           -- scrypt$N$r$p$salt$hash; null: no password sign-in
  disabled       boolean not null default false,
  created_at     timestamptz not null default now()
);

-- Synced from domain/roles.yaml at index. person_roles has no foreign key to it on purpose:
-- a role removed from the file must not fail the sync or silently strip people.
create table mw.roles (
  id           text primary key,
  title        text not null,
  description  text
);

create table mw.person_roles (
  person_id  text not null references mw.people(id) on delete cascade,
  role_id    text not null,
  primary key (person_id, role_id)
);
create index person_roles_role on mw.person_roles (role_id);

-- Personal sign-in tokens, stored as sha256 (hex); the token itself is shown once.
create table mw.auth_tokens (
  token_hash    text primary key,
  person_id     text not null references mw.people(id) on delete cascade,
  label         text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz
);
create index auth_tokens_person on mw.auth_tokens (person_id);

-- ------------------------------------------------------------------ inbox, explanations, chat (19 §4, §6)

-- Reminders and other notes for a role or a person; the inbox shows the unread ones.
create table mw.notifications (
  id           text primary key,
  run_id       text not null,
  step_run_id  text,
  role         text,
  person_id    text,
  kind         text not null,                    -- reminder | …
  text         text not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index notifications_unread on mw.notifications (created_at) where read_at is null;
create index notifications_run on mw.notifications (run_id);

create table mw.explanations (
  id           text primary key,
  step_run_id  text not null,
  question     text not null,
  answer       text not null,
  cites        jsonb not null default '[]'::jsonb,
  grounded     boolean not null,
  model        jsonb,                            -- { provider, model, usage }
  by           text,                             -- who asked (person id)
  at           timestamptz not null default now()
);
create index explanations_step on mw.explanations (step_run_id, at);

-- A chat session opened from a case or a step ("Ask about this step").
create table mw.chat_anchors (
  chat_id      text primary key,
  anchor_kind  text not null,                    -- case | step
  anchor_id    text not null,
  person_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index chat_anchors_anchor on mw.chat_anchors (anchor_kind, anchor_id);

-- ------------------------------------------------------------------ uploads (19 §5)

-- Metadata only; the bytes live content-addressed in the object store (<dir>/<sha256>).
create table mw.files (
  id          text primary key,                  -- file_<ulid>
  name        text not null,
  mime        text not null,
  size        bigint not null,
  sha256      text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index files_sha on mw.files (sha256);

-- ------------------------------------------------------------------ rate limits (19 §7)

-- One row per counted tool call; the gateway counts rows inside the window.
create table mw.rate_events (
  tool   text not null,
  scope  text not null,                          -- the domain (or another counting scope)
  at     timestamptz not null default now()
);
create index rate_events_window on mw.rate_events (tool, scope, at);

-- ------------------------------------------------------------------ additions to Phase 1 tables

alter table mw.step_runs add column assignee text;     -- role that does or decides a person/external step
alter table mw.step_runs add column decided_by text;   -- person id that submitted it
alter table mw.step_runs add column comment text;      -- the person's comment (a send-back's reason)
create index step_runs_waiting on mw.step_runs (status, assignee) where status = 'waiting';

-- Fields whose current value came from untrusted content (a quarantined read).
alter table mw.cases add column tainted_fields text[] not null default '{}';

-- ------------------------------------------------------------------ the app role (19 §2)

-- People and step tokens act as memwise_app (withActor: `set local role memwise_app`); RLS
-- reads the mw.* settings. Roles are cluster-wide and many databases share a test cluster,
-- so creation is guarded (and tolerant of a concurrent create).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'memwise_app') then
    create role memwise_app nologin;
  end if;
exception when duplicate_object or unique_violation then null;
end $$;

-- The connecting user must be able to `set role memwise_app` (superusers always can).
do $$
begin
  if not pg_has_role(current_user, 'memwise_app', 'member') then
    execute format('grant memwise_app to %I', current_user);
  end if;
exception when others then
  raise warning 'could not grant memwise_app to %: %', current_user, sqlerrm;
end $$;

create schema if not exists domain;
create schema if not exists domain_read;

grant usage on schema mw, domain, domain_read to memwise_app;

grant select, insert, update on
  mw.cases, mw.case_events, mw.runs, mw.transitions, mw.timers, mw.inbox,
  mw.step_runs, mw.step_journal, mw.effects, mw.approvals,
  mw.notifications, mw.explanations, mw.chat_anchors, mw.files, mw.person_roles
  to memwise_app;
grant select on mw.definitions, mw.definition_refs, mw.roles to memwise_app;
grant select, insert on mw.rate_events to memwise_app;
-- Never the password hash; tokens are verified by the kernel itself (system actor).
grant select (id, name, email, disabled, created_at) on mw.people to memwise_app;

-- ------------------------------------------------------------------ actor settings, for RLS

create or replace function mw.actor_kind() returns text
  language sql stable as $$ select nullif(current_setting('mw.actor_kind', true), '') $$;

create or replace function mw.actor_person() returns text
  language sql stable as $$ select nullif(current_setting('mw.person', true), '') $$;

create or replace function mw.actor_has_role(role text) returns boolean
  language sql stable as $$
    select coalesce(role = any (string_to_array(nullif(current_setting('mw.roles', true), ''), ',')), false)
  $$;

-- The case a step token is bound to; null for anyone else.
create or replace function mw.token_case() returns text
  language sql stable as $$ select (nullif(current_setting('mw.step_token', true), '')::jsonb) ->> 'caseId' $$;

-- The step run a step token is bound to.
create or replace function mw.token_step_run() returns text
  language sql stable as $$ select (nullif(current_setting('mw.step_token', true), '')::jsonb) ->> 'stepRunId' $$;

-- ------------------------------------------------------------------ row rules on kernel tables (19 §3)

-- The owner (the kernel, as system) is not subject to these; memwise_app is. compileRls
-- re-states the same policies at index (idempotently), so the two never need to differ.
alter table mw.cases enable row level security;
alter table mw.runs enable row level security;
alter table mw.step_runs enable row level security;

create policy mw_person_all on mw.cases for all to memwise_app
  using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person');
create policy mw_step_own_case on mw.cases for all to memwise_app
  using (mw.actor_kind() = 'step' and id = mw.token_case())
  with check (mw.actor_kind() = 'step' and id = mw.token_case());

create policy mw_person_all on mw.runs for all to memwise_app
  using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person');
create policy mw_step_own_case on mw.runs for all to memwise_app
  using (mw.actor_kind() = 'step' and case_id = mw.token_case())
  with check (mw.actor_kind() = 'step' and case_id = mw.token_case());

create policy mw_person_all on mw.step_runs for all to memwise_app
  using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person');
create policy mw_step_own_case on mw.step_runs for all to memwise_app
  using (mw.actor_kind() = 'step' and case_id = mw.token_case())
  with check (mw.actor_kind() = 'step' and case_id = mw.token_case());

-- ------------------------------------------------------------------ change notifications (19 §8)

-- One channel, small JSON payloads; listeners re-read what they show. pg_notify folds
-- identical payloads within a transaction, so a commit touching a run many times sends one.
create or replace function mw.notify_run_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object(
    'kind', 'run', 'runId', new.id, 'caseId', new.case_id, 'workflowId', new.workflow_id)::text);
  return null;
end $$;

create or replace function mw.notify_step_run_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object(
    'kind', 'run', 'runId', new.run_id, 'caseId', new.case_id, 'workflowId', new.workflow_id)::text);
  if new.status = 'waiting' or (tg_op = 'UPDATE' and old.status = 'waiting') then
    perform pg_notify('mw_changes', '{"kind":"inbox"}');
  end if;
  return null;
end $$;

create or replace function mw.notify_inbox_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', '{"kind":"inbox"}');
  return null;
end $$;

create trigger runs_notify after insert or update on mw.runs
  for each row execute function mw.notify_run_change();
create trigger step_runs_notify after insert or update on mw.step_runs
  for each row execute function mw.notify_step_run_change();
create trigger approvals_notify after insert or update on mw.approvals
  for each row execute function mw.notify_inbox_change();
create trigger notifications_notify after insert or update on mw.notifications
  for each row execute function mw.notify_inbox_change();
