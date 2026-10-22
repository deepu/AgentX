-- Stage 5 of "Projects and pages": regulated projects (docs/memwise/26-projects-and-pages.md §7,
-- §8, D95, D115–D119): change requests, the project audit log (one hash chain per project, D77),
-- and inspector links. A project is still a domain here: `project` holds the domain id.

-- ------------------------------------------------------------------ change requests (26 §7)

-- A change to a regulated domain's playbook (and the rules and record types that ride in its
-- draft). The draft holds what changes; the request holds why, the validations run on it and,
-- in mw.signatures (entity `change_request`), the sign-offs that make it live.
create table mw.change_requests (
  id             text primary key,               -- cr_<ulid>
  project        text not null,                  -- the domain id (26 §2: a domain stands in for its project)
  number         int not null,                   -- CR-014
  workflow_id    text not null,                  -- the playbook it changes
  draft_id       text not null,                  -- drafts/<id>/: what changes
  title          text not null,
  reason         text not null default '',
  status         text not null,                  -- open | in_review | published | withdrawn
  validation_set jsonb not null default '{}'::jsonb, -- ValidationSet: the past cases it is tried on
  chat_id        text,                           -- the chat that edits it, once opened
  raised_by      text not null,
  raised_at      timestamptz not null default clock_timestamp(),
  from_version   int,
  from_hash      text,
  to_version     int,                            -- set when QA's signature published it
  to_hash        text,
  closed_at      timestamptz,
  closed_by      text,
  updated_at     timestamptz not null default clock_timestamp(),
  unique (project, number)
);
create index change_requests_project on mw.change_requests (project, status, number desc);
create unique index change_requests_draft on mw.change_requests (draft_id);

-- The next number per project (a project moving off a paper log starts where the log ended).
create table mw.change_request_numbers (
  project  text primary key,
  next     int not null
);

-- One validation run of a request: the draft's content hash it ran on and each case's result.
create table mw.change_request_validations (
  id            text primary key,                -- crv_<ulid>
  cr_id         text not null references mw.change_requests(id),
  draft_hash    text not null,
  set_label     text not null,
  total         int not null,
  passed        int not null,
  check_errors  int not null default 0,          -- the draft's own check errors (they fail it too)
  status        text not null,                   -- passed | failed
  results       jsonb not null default '[]'::jsonb, -- ValidationCaseResult[]
  by            text,
  at            timestamptz not null default clock_timestamp()
);
create index change_request_validations_cr on mw.change_request_validations (cr_id, at desc);

create trigger change_request_validations_append_only before update or delete on mw.change_request_validations
  for each row execute function mw.refuse_history_change();

-- ------------------------------------------------------------------ the audit log (26 §8, D77)

-- One trail per app (Stage 3: a study is a project of the app; its entries carry it as
-- data.inProject, and the trail page and an inspector link show only theirs; entries with none,
-- such as change requests, are the app's and show in each of its projects).
-- One trail per project: record versions, signatures and step records as they happen (written by
-- the triggers below, so no write path skips them), and what the kernel adds (change requests,
-- inspector views and downloads, exports). Each entry's hash covers the previous entry's hash, so
-- an export can be checked offline. Nobody may change or delete a row.
create table mw.audit_log (
  seq          bigserial primary key,
  id           text not null unique,             -- aud_<ulid>
  project      text not null,
  at           timestamptz not null,
  actor_kind   text not null,                    -- person | ai | system | external | inspector | source
  actor        text not null,                    -- person id, step run id, link id, source:<x>, system
  actor_label  text,                             -- the person's or inspector's name when written
  action       text not null,                    -- record.created | record.changed | signature.signed | step.completed | …
  entity       text,                             -- the record it is about (entity key), if any
  record_id    text,
  case_id      text,
  data         jsonb not null default '{}'::jsonb, -- the action's facts (no decimals: kept as text)
  prev_hash    text not null,
  hash         text not null
);
create index audit_log_project on mw.audit_log (project, seq);
create index audit_log_record on mw.audit_log (entity, record_id, seq);
create index audit_log_case on mw.audit_log (case_id, seq) where case_id is not null;
create index audit_log_in_project on mw.audit_log (project, (data ->> 'inProject'), seq);

create trigger audit_log_append_only before update or delete on mw.audit_log
  for each row execute function mw.refuse_history_change();
create trigger audit_log_no_truncate before truncate on mw.audit_log
  for each statement execute function mw.refuse_history_change();

-- Numbers that aren't whole become text, so the canonical JSON of an entry is the same in
-- Postgres and in the export's verifier (jsonb keeps 1.50 as written; JSON readers don't).
create or replace function mw.audit_plain(j jsonb) returns jsonb
  language plpgsql immutable as $$
begin
  case jsonb_typeof(j)
    when 'object' then
      return coalesce((select jsonb_object_agg(k, mw.audit_plain(v)) from jsonb_each(j) as e(k, v)), '{}'::jsonb);
    when 'array' then
      return coalesce((select jsonb_agg(mw.audit_plain(v) order by n) from jsonb_array_elements(j) with ordinality as a(v, n)), '[]'::jsonb);
    when 'number' then
      return case when j::text ~ '^-?[0-9]{1,15}$' then j else to_jsonb(j::text) end;
    else
      return j;
  end case;
end $$;

-- hash = sha256(prev_hash ‖ canonical JSON of { id, project, at (UTC, microseconds), actor_kind,
-- actor, actor_label, action, entity, record_id, case_id, data }).
create or replace function mw.audit_hash(prev_hash text, id text, project text, at timestamptz, actor_kind text, actor text,
                                         actor_label text, action text, entity text, record_id text, case_id text, data jsonb) returns text
  language sql stable as $$
    select encode(sha256(convert_to(prev_hash || mw.canonical_json(jsonb_build_object(
      'id', id, 'project', project, 'at', to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'actor_kind', actor_kind, 'actor', actor, 'actor_label', actor_label, 'action', action,
      'entity', entity, 'record_id', record_id, 'case_id', case_id, 'data', data)), 'UTF8')), 'hex')
  $$;

-- Appends one entry, chained to the project's last one. One lock per project, held to the end of
-- the transaction, so a project's entries from concurrent transactions chain in commit order and
-- two projects never wait on each other.
create or replace function mw.audit_append(p_project text, p_actor_kind text, p_actor text, p_actor_label text, p_action text,
                                           p_entity text, p_record_id text, p_case_id text, p_data jsonb) returns text
  language plpgsql security definer set search_path = mw, pg_temp as $$
declare
  prev text;
  t timestamptz;
  new_id text := 'aud_' || mw.ulid();
  d jsonb := mw.audit_plain(coalesce(p_data, '{}'::jsonb));
begin
  perform pg_advisory_xact_lock(hashtext('mw.audit_log:' || p_project));
  t := clock_timestamp();
  select a.hash into prev from mw.audit_log a where a.project = p_project order by a.seq desc limit 1;
  prev := coalesce(prev, repeat('0', 64));
  insert into mw.audit_log (id, project, at, actor_kind, actor, actor_label, action, entity, record_id, case_id, data, prev_hash, hash)
  values (new_id, p_project, t, p_actor_kind, p_actor, p_actor_label, p_action, p_entity, p_record_id, p_case_id, d, prev,
          mw.audit_hash(prev, new_id, p_project, t, p_actor_kind, p_actor, p_actor_label, p_action, p_entity, p_record_id, p_case_id, d));
  perform pg_notify('mw_changes', json_build_object('kind', 'audit', 'project', p_project)::text);
  return new_id;
end $$;
revoke execute on function mw.audit_append(text, text, text, text, text, text, text, text, jsonb) from public;
grant execute on function mw.audit_append(text, text, text, text, text, text, text, text, jsonb) to memwise_app;

-- The project (domain) a case belongs to: its playbook's domain. A Stage 3 project runs its own
-- copy of the app's playbook (a hash of its own, not indexed): that copy's app is the playbook's.
create or replace function mw.audit_project_of_case(p_case_id text) returns text
  language sql stable security definer set search_path = mw, pg_temp as $$
    select coalesce((select d.body ->> 'domain' from mw.runs r
                      join mw.definitions d on d.kind = 'workflow' and d.id = r.workflow_id and d.hash = r.workflow_hash
                     where r.case_id = p_case_id order by r.created_at limit 1),
                    (select mw.workflow_domain(r.workflow_id) from mw.runs r where r.case_id = p_case_id order by r.created_at limit 1),
                    'domain')
  $$;

-- The project of a record: its entity key's domain (`etmf.Document` → etmf), a case's playbook's
-- domain, or a change request's project.
create or replace function mw.audit_project_of(p_entity text, p_record_id text, p_case_id text) returns text
  language sql stable security definer set search_path = mw, pg_temp as $$
    select case
      when p_entity like '%.%' then split_part(p_entity, '.', 1)
      when p_entity = 'change_request' then coalesce((select c.project from mw.change_requests c where c.id = p_record_id), 'domain')
      when p_case_id is not null then mw.audit_project_of_case(p_case_id)
      else 'domain' end
  $$;

-- Who a record version's `by` is: a person, a step (an agent is `ai`), a source, or the system.
create or replace function mw.audit_actor(p_by text, out kind text, out actor text, out label text)
  language plpgsql stable security definer set search_path = mw, pg_temp as $$
declare
  performer text;
begin
  actor := p_by;
  if p_by is null or p_by = 'system' then
    kind := 'system'; actor := 'system';
  elsif p_by like 'step:%' then
    actor := substr(p_by, 6);
    select s.performer into performer from mw.step_runs s where s.id = actor;
    kind := case performer when 'agent' then 'ai' when 'person' then 'person' when 'external' then 'external' else 'system' end;
  elsif p_by like 'source:%' then
    kind := 'source';
  elsif p_by like 'lnk_%' then
    kind := 'external';
  else
    kind := 'person';
    select p.name into label from mw.people p where p.id = p_by;
  end if;
end $$;

create or replace function mw.audit_record_version() returns trigger
  language plpgsql security definer set search_path = mw, pg_temp as $$
declare
  who record;
  case_id text;
begin
  select * into who from mw.audit_actor(new."by");
  if new.via like 'run_%/%' then
    select s.case_id into case_id from mw.step_runs s where s.id = new.via;
  end if;
  -- An entity key names its domain (`etmf.Document`); a default-domain entity (`Client`) is in `domain`.
  perform mw.audit_append(case when new.entity like '%.%' then split_part(new.entity, '.', 1) else 'domain' end, who.kind, who.actor, who.label,
    case when new.version = 1 then 'record.created' else 'record.changed' end, new.entity, new.record_id, case_id,
    jsonb_strip_nulls(jsonb_build_object('version', new.version, 'changed', to_jsonb(new.changed), 'reason', new.reason,
      'via', new.via, 'status', new."values" ->> 'status', 'versionHash', new.hash, 'inProject', new.project)));
  return null;
end $$;

create trigger record_versions_audit after insert on mw.record_versions
  for each row execute function mw.audit_record_version();

create or replace function mw.audit_signature() returns trigger
  language plpgsql security definer set search_path = mw, pg_temp as $$
declare
  in_project text;
begin
  -- The signed record's project (a study's), else its case's; a change request's is none (the app's).
  if new.entity <> 'change_request' then
    select v.project into in_project from mw.record_versions v
     where v.entity = new.entity and v.record_id = new.record_id order by v.version desc limit 1;
    if in_project is null and new.case_id is not null then
      select c.project into in_project from mw.cases c where c.id = new.case_id;
    end if;
  end if;
  perform mw.audit_append(mw.audit_project_of(new.entity, new.record_id, new.case_id), 'person', new.person_id, new.name,
    'signature.signed', new.entity, new.record_id, new.case_id,
    jsonb_strip_nulls(jsonb_build_object('signatureId', new.id, 'meaning', new.meaning, 'contentHash', new.content_hash,
      'stepRunId', new.step_run_id, 'role', new.manifest ->> 'role', 'inProject', in_project)));
  return null;
end $$;

create trigger signatures_audit after insert on mw.signatures
  for each row execute function mw.audit_signature();

-- A step record once it settles: who did it (a person, an agent and the model it ran on, an
-- external participant), how it ended, and what it relied on (its rationale and the words it
-- quoted). System steps aren't judgements; their record writes are in the trail already.
create or replace function mw.audit_step_run() returns trigger
  language plpgsql security definer set search_path = mw, pg_temp as $$
declare
  kind text;
  actor text;
  label text;
  model text;
  verifier text;
  quote text;
  quoted_field text;
begin
  if new.performer = 'system' or new.status not in ('completed', 'needs_person', 'failed')
     or (tg_op = 'UPDATE' and old.status is not distinct from new.status) then
    return null;
  end if;
  if new.performer = 'agent' then
    kind := 'ai'; actor := new.id;
    -- The model the agent ran on (its own turns, not the verifier's).
    select j.model ->> 'model' into model from mw.step_journal j
     where j.step_run_id = new.id and j.kind = 'model' and j.journal_key like 'model:%' and j.model is not null order by j.started_at desc limit 1;
    select j.model ->> 'model' into verifier from mw.step_journal j
     where j.step_run_id = new.id and j.kind = 'model' and j.journal_key like 'verify:%' and j.model is not null order by j.started_at desc limit 1;
    select e.key, e.value -> 'provenance' ->> 'quote' into quoted_field, quote from jsonb_each(new.outputs) e
     where jsonb_typeof(e.value) = 'object' and e.value -> 'provenance' ->> 'quote' is not null order by e.key limit 1;
  elsif new.performer = 'person' and new.decided_by is not null then
    kind := 'person'; actor := new.decided_by;
    select p.name into label from mw.people p where p.id = new.decided_by;
  elsif new.decided_by like 'lnk_%' then
    kind := 'external'; actor := new.decided_by;
  else
    kind := 'system'; actor := new.id;
  end if;
  perform mw.audit_append(mw.audit_project_of_case(new.case_id), kind, actor, label, 'step.' || new.status, null, null, new.case_id,
    jsonb_strip_nulls(jsonb_build_object('stepRunId', new.id, 'step', new.step_id, 'workflow', new.workflow_id,
      'version', new.workflow_version, 'performer', new.performer, 'outcome', new.outcome, 'model', model, 'verifierModel', verifier,
      'rationale', left(coalesce(new.rationale, new.comment), 600), 'quote', left(quote, 600), 'quotedField', quoted_field,
      'checkpoint', case when jsonb_typeof(new.checkpoint) = 'array' and jsonb_array_length(new.checkpoint) > 0 then
        jsonb_build_object('rules', jsonb_array_length(new.checkpoint),
          'failed', (select count(*) from jsonb_array_elements(new.checkpoint) c where (c ->> 'passed')::boolean is false)) end,
      'inProject', new.project)));
  return null;
end $$;

create trigger step_runs_audit after insert or update of status on mw.step_runs
  for each row execute function mw.audit_step_run();

-- ------------------------------------------------------------------ inspectors (26 §7)

-- A read-only link for an inspector, until an end date. Only the sha256 of its token is kept.
create table mw.inspector_links (
  id               text primary key,             -- insp_<ulid>
  project          text not null,
  token_hash       text not null unique,
  name             text not null,                -- "MHRA inspection"
  inspectors       jsonb not null default '[]'::jsonb, -- [{ name, email?, organisation? }]
  expires_at       timestamptz not null,
  created_by       text not null,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  first_opened_at  timestamptz,
  last_opened_at   timestamptz
);
create index inspector_links_project on mw.inspector_links (project, created_at desc);

-- A question an inspector asked; it goes to the people (an inbox item), never to an agent.
create table mw.inspector_questions (
  id           text primary key,                 -- insq_<ulid>
  link_id      text not null references mw.inspector_links(id),
  project      text not null,
  asked_by     text,                             -- the inspector's name as given
  entity       text,                             -- the record it is about, if any
  record_id    text,
  question     text not null,
  asked_at     timestamptz not null default clock_timestamp(),
  answer       text,
  answered_by  text,
  answered_at  timestamptz
);
create index inspector_questions_open on mw.inspector_questions (project, asked_at) where answered_at is null;
create index inspector_questions_link on mw.inspector_questions (link_id, asked_at);

-- ------------------------------------------------------------------ grants and notifications

-- People read; the kernel (as system) writes requests, links and questions, and the log is
-- written only through mw.audit_append.
grant select on mw.change_requests, mw.change_request_validations, mw.change_request_numbers, mw.audit_log,
  mw.inspector_questions to memwise_app;
grant select (id, project, name, inspectors, expires_at, created_by, created_at, revoked_at, revoked_by,
  first_opened_at, last_opened_at) on mw.inspector_links to memwise_app;

create or replace function mw.notify_regulated_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object('kind', 'regulated', 'project', new.project)::text);
  if tg_table_name in ('change_requests', 'inspector_questions') then
    perform pg_notify('mw_changes', '{"kind":"inbox"}');
  end if;
  return null;
end $$;

create trigger change_requests_notify after insert or update on mw.change_requests
  for each row execute function mw.notify_regulated_change();
create trigger inspector_links_notify after insert or update on mw.inspector_links
  for each row execute function mw.notify_regulated_change();
create trigger inspector_questions_notify after insert or update on mw.inspector_questions
  for each row execute function mw.notify_regulated_change();
