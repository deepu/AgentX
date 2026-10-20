-- Phase 6: domains and records: grants per domain, record versions (append-only, hash-chained),
-- entity events, signatures, sign-in events, notes, mentions, flags, personal views and written
-- pages (PHASE 6 CONTRACT, docs/memwise/24-phase-6-interfaces.md §2, §3, §6, §7, §9, §16).
-- The per-table row triggers that write versions and events are generated at index by
-- applyDomainSchema (domain/records-sql.ts); this file holds what doesn't depend on definitions.

-- ------------------------------------------------------------------ ids

-- A ULID like ids.ts makes (48-bit time, 80 random bits, Crockford base32), for rows that
-- triggers write. Random bits come from gen_random_uuid (built in since Postgres 13).
create or replace function mw.ulid() returns text
  language plpgsql volatile as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  rnd bytea := uuid_send(gen_random_uuid());
  out text := '';
begin
  for i in 1..10 loop
    out := substr(alphabet, (ms % 32)::int + 1, 1) || out;
    ms := ms / 32;
  end loop;
  for i in 0..15 loop
    out := out || substr(alphabet, (get_byte(rnd, i) & 31) + 1, 1);
  end loop;
  return out;
end $$;

-- ------------------------------------------------------------------ grants per domain (24 §2)

-- A role granted in one domain, optionally limited to records: scope = { <field>: [<record id>, …] }.
-- Workspace-wide roles stay in mw.person_roles.
create table mw.grants (
  id          bigserial primary key,
  person_id   text not null references mw.people(id) on delete cascade,
  role_id     text not null,
  domain      text not null,
  scope       jsonb,
  created_at  timestamptz not null default now()
);
create index grants_person on mw.grants (person_id);

-- The person actor's grants, as JSON (`setActor` writes `mw.grants`); [] for anyone else.
create or replace function mw.actor_grants() returns jsonb
  language sql stable as $$ select coalesce(nullif(current_setting('mw.grants', true), '')::jsonb, '[]'::jsonb) $$;

-- A workspace-wide role, or a grant of the role in this domain.
create or replace function mw.actor_has_role_in(role text, domain text) returns boolean
  language sql stable as $$
    select mw.actor_has_role(role) or exists (
      select 1 from jsonb_array_elements(mw.actor_grants()) g where g ->> 'role' = role and g ->> 'domain' = domain)
  $$;

-- Whether the actor's view of this domain is limited to records: a person with at least one grant
-- in the domain, every one of them scoped.
create or replace function mw.scope_filtered(p_domain text) returns boolean
  language sql stable as $$
    select coalesce(mw.actor_kind() = 'person', false)
      and exists (select 1 from jsonb_array_elements(mw.actor_grants()) g where g ->> 'domain' = p_domain)
      and not exists (
        select 1 from jsonb_array_elements(mw.actor_grants()) g
        where g ->> 'domain' = p_domain
          and (jsonb_typeof(g -> 'scope') is distinct from 'object' or g -> 'scope' = '{}'::jsonb))
  $$;

-- Whether a row is inside the actor's record scope. `p_row` holds the row's scope candidates by
-- field name (its Ref columns, and the entity's own snake name → its id). A grant matches when every
-- key of its scope that the row has holds one of the grant's ids; keys the row lacks don't filter.
create or replace function mw.in_scope(p_domain text, p_row jsonb) returns boolean
  language sql stable as $$
    select not mw.scope_filtered(p_domain) or exists (
      select 1 from jsonb_array_elements(mw.actor_grants()) g
      where g ->> 'domain' = p_domain and jsonb_typeof(g -> 'scope') = 'object'
        and not exists (
          select 1 from jsonb_each(g -> 'scope') s(k, ids)
          where p_row ? s.k
            and not coalesce((p_row ->> s.k) is not null and (s.ids ? (p_row ->> s.k) or s.ids = to_jsonb(p_row ->> s.k)), false)))
  $$;

-- ------------------------------------------------------------------ who, why and how a write happened (24 §3)

-- `by`: an explicit `mw.by` (withRecordContext: `source:edc`, a person the kernel acts for), else
-- the person, else `step:<stepRunId>`, else `system`.
create or replace function mw.record_by() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('mw.by', true), ''),
      case mw.actor_kind() when 'person' then mw.actor_person() when 'step' then 'step:' || mw.token_step_run() end,
      'system')
  $$;

-- `via`: `mw.via`, else the step run, else `app` for a person.
create or replace function mw.record_via() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('mw.via', true), ''),
      case mw.actor_kind() when 'step' then mw.token_step_run() when 'person' then 'app' end)
  $$;

-- `reason`: `mw.reason`, else a step write's generated one (the kernel sets a better one).
create or replace function mw.record_reason() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('mw.reason', true), ''),
      case when mw.actor_kind() = 'step' then 'step ' || mw.token_step_run() end)
  $$;

-- ------------------------------------------------------------------ record versions (24 §3)

-- JSON with object keys sorted (bytewise) and no spaces; scalars as jsonb writes them. The input of
-- every version hash, so the chain can be recomputed from the stored rows alone.
create or replace function mw.canonical_json(j jsonb) returns text
  language plpgsql immutable as $$
begin
  case jsonb_typeof(j)
    when 'object' then
      return '{' || coalesce((select string_agg(to_json(k)::text || ':' || mw.canonical_json(v), ',' order by k collate "C")
                              from jsonb_each(j) as e(k, v)), '') || '}';
    when 'array' then
      return '[' || coalesce((select string_agg(mw.canonical_json(v), ',' order by n)
                              from jsonb_array_elements(j) with ordinality as a(v, n)), '') || ']';
    else
      return coalesce(j::text, 'null');
  end case;
end $$;

-- hash = sha256(prev_hash ‖ canonical JSON of { entity, record_id, version, at (UTC, microseconds), by, reason, values }).
create or replace function mw.record_hash(prev_hash text, entity text, record_id text, version int, at timestamptz,
                                          by text, reason text, vals jsonb) returns text
  language sql stable as $$
    select encode(sha256(convert_to(prev_hash || mw.canonical_json(jsonb_build_object(
      'entity', entity, 'record_id', record_id, 'version', version,
      'at', to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'by', by, 'reason', reason, 'values', vals)), 'UTF8')), 'hex')
  $$;

-- One row per version of every record, written by the generated row trigger of each domain table
-- (so no write path can skip it). Nobody may change or delete a row (trigger below), and the app
-- role may only read: tampering needs a superuser who disables the trigger, and still breaks the chain.
create table mw.record_versions (
  entity     text not null,                     -- entity key (etmf.Document)
  record_id  text not null,
  version    int not null,                      -- the row's new `version`
  at         timestamptz not null,              -- clock_timestamp() of the server
  by         text not null,                     -- person id | step:<stepRunId> | source:<x> | system
  via        text,                              -- step run id, link id or app
  reason     text,
  "values"   jsonb not null,                    -- the whole row by field name (status = lifecycle)
  changed    text[] not null default '{}',      -- field names that differ from the previous version
  prev_hash  text not null,                     -- the previous version's hash, or 64 zeros
  hash       text not null,
  primary key (entity, record_id, version)
);
create index record_versions_at on mw.record_versions (at);

-- Writes one version with its hash; called by the row triggers (and the migrating index).
-- Not callable by the app role: only the owner's trigger functions call it.
create or replace function mw.write_record_version(p_entity text, p_record_id text, p_version int, p_by text, p_via text,
                                                   p_reason text, p_values jsonb, p_changed text[]) returns text
  language plpgsql as $$
declare
  prev text;
  t timestamptz := clock_timestamp();
  h text;
begin
  select v.hash into prev from mw.record_versions v
   where v.entity = p_entity and v.record_id = p_record_id order by v.version desc limit 1;
  prev := coalesce(prev, repeat('0', 64));
  h := mw.record_hash(prev, p_entity, p_record_id, p_version, t, p_by, p_reason, p_values);
  insert into mw.record_versions (entity, record_id, version, at, by, via, reason, "values", changed, prev_hash, hash)
  values (p_entity, p_record_id, p_version, t, p_by, p_via, p_reason, p_values, coalesce(p_changed, '{}'), prev, h);
  return h;
end $$;
revoke execute on function mw.write_record_version(text, text, int, text, text, text, jsonb, text[]) from public;

-- History tables refuse every change, for every role (the owner included).
create or replace function mw.refuse_history_change() returns trigger
  language plpgsql as $$
begin
  raise exception 'history-is-append-only: % rows can be added, never changed or deleted', tg_table_name
    using errcode = 'MW002';
end $$;

create trigger record_versions_append_only before update or delete on mw.record_versions
  for each row execute function mw.refuse_history_change();
create trigger record_versions_no_truncate before truncate on mw.record_versions
  for each statement execute function mw.refuse_history_change();

-- ------------------------------------------------------------------ entity events (24 §7)

create table mw.entity_events (
  seq        bigserial primary key,
  id         text not null unique,              -- evt_<ulid>
  entity     text not null,                     -- entity key
  record_id  text not null,
  kind       text not null,                     -- created | changed | entered
  data       jsonb not null default '{}',       -- { fields } | { state, from, transition }
  by         text,
  at         timestamptz not null default clock_timestamp()
);
create index entity_events_record on mw.entity_events (entity, record_id, seq);

-- Written by the generated row trigger of every domain table, in the writing transaction.
create or replace function mw.write_entity_event(p_entity text, p_record_id text, p_kind text, p_data jsonb, p_by text) returns void
  language plpgsql as $$
begin
  insert into mw.entity_events (id, entity, record_id, kind, data, by)
  values ('evt_' || mw.ulid(), p_entity, p_record_id, p_kind, coalesce(p_data, '{}'::jsonb), p_by);
  perform pg_notify('mw_changes', '{"kind":"entity"}');
  perform pg_notify('mw_changes', json_build_object('kind', 'records', 'entity', p_entity, 'recordId', p_record_id)::text);
end $$;
revoke execute on function mw.write_entity_event(text, text, text, jsonb, text) from public;

-- ------------------------------------------------------------------ signatures and sign-in events (24 §9)

create table mw.signatures (
  id            text primary key,               -- sig_<ulid>
  step_run_id   text,
  case_id       text,
  person_id     text not null,
  name          text not null,                  -- the person's name when they signed
  meaning       text not null,                  -- "Reviewed and approved for filing"
  entity        text not null,                  -- the record it covers (entity key)
  record_id     text not null,
  content_hash  text not null,                  -- contentHash({ entity, record_id, file sha256, values })
  manifest      jsonb not null default '{}',    -- what was hashed, for the audit export
  at            timestamptz not null default clock_timestamp()
);
create index signatures_record on mw.signatures (entity, record_id, at);
create index signatures_case on mw.signatures (case_id);
create index signatures_step_run on mw.signatures (step_run_id);

create trigger signatures_append_only before update or delete on mw.signatures
  for each row execute function mw.refuse_history_change();
create trigger signatures_no_truncate before truncate on mw.signatures
  for each statement execute function mw.refuse_history_change();

-- Locked after too many failed signatures (the kernel decides the policy; 24 §9).
alter table mw.people add column if not exists locked_until timestamptz;

-- Every signing attempt and lock: signature-ok | signature-failed | locked.
create table mw.auth_events (
  id         text primary key,                  -- auth_<ulid>
  person_id  text not null,
  kind       text not null,
  detail     jsonb not null default '{}',
  at         timestamptz not null default clock_timestamp()
);
create index auth_events_person on mw.auth_events (person_id, at);

-- ------------------------------------------------------------------ notes, mentions, flags (24 §4, §6)

-- One note per record, with history: each save is a new version.
create table mw.record_notes (
  entity     text not null,
  record_id  text not null,
  version    int not null,
  body       text not null,
  by         text not null,
  reason     text,
  at         timestamptz not null default clock_timestamp(),
  primary key (entity, record_id, version)
);

create trigger record_notes_append_only before update or delete on mw.record_notes
  for each row execute function mw.refuse_history_change();

-- `@` references to a record from notes, chat messages, step rationales, comments and pages.
create table mw.mentions (
  id             text primary key,              -- men_<ulid>
  target_entity  text not null,
  target_id      text not null,
  source_kind    text not null,                 -- note | chat | step | comment | page
  source_id      text not null,
  label          text,
  case_id        text,
  at             timestamptz not null default clock_timestamp(),
  unique (target_entity, target_id, source_kind, source_id)
);
create index mentions_source on mw.mentions (source_kind, source_id);

-- A broken invariant on a record: one open flag per (entity, record, invariant).
create table mw.record_flags (
  id          text primary key,                 -- flag_<ulid>
  entity      text not null,
  domain      text not null,
  record_id   text not null,
  invariant   text not null,
  message     text not null,
  raised_at   timestamptz not null default clock_timestamp(),
  closed_at   timestamptz
);
create unique index record_flags_open on mw.record_flags (entity, record_id, invariant) where closed_at is null;
create index record_flags_domain on mw.record_flags (domain, raised_at) where closed_at is null;

-- ------------------------------------------------------------------ personal views and written pages (24 §6)

create table mw.views (
  id          text primary key,                 -- view_<ulid> (or the id the person chose)
  person_id   text not null,
  domain      text not null,
  body        jsonb not null,                   -- ViewDef
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index views_person on mw.views (person_id, domain);

-- Prose pages written in the app (data, not definitions), with every version kept.
create table mw.pages (
  id          text primary key,                 -- page_<ulid>
  domain      text not null,
  under       jsonb,                            -- { entity, id? }: where it hangs in the page tree
  title       text not null,
  body        text not null default '',         -- markdown
  version     int not null default 1,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index pages_domain on mw.pages (domain);

create table mw.page_versions (
  page_id  text not null,
  version  int not null,
  title    text not null,
  body     text not null,
  under    jsonb,
  by       text,
  at       timestamptz not null default clock_timestamp(),
  primary key (page_id, version)
);

create trigger page_versions_append_only before update or delete on mw.page_versions
  for each row execute function mw.refuse_history_change();

-- ------------------------------------------------------------------ the app role

-- History: read only (the row triggers write it with the owner's rights). Nothing here can be
-- deleted by the app role except mentions (re-derived when their source is edited) and a
-- person's own views.
grant select on mw.record_versions, mw.entity_events, mw.grants, mw.auth_events to memwise_app;
grant select, insert on mw.signatures, mw.record_notes, mw.page_versions to memwise_app;
grant select, insert, update, delete on mw.mentions to memwise_app;
grant select, insert, update on mw.record_flags, mw.pages to memwise_app;
grant select, insert, update, delete on mw.views to memwise_app;
grant select (locked_until) on mw.people to memwise_app;

-- ------------------------------------------------------------------ change notifications (19 §8)

create or replace function mw.notify_record_extra_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object('kind', 'records', 'entity', new.entity, 'recordId', new.record_id)::text);
  if tg_table_name = 'record_flags' then
    perform pg_notify('mw_changes', '{"kind":"inbox"}');
  end if;
  return null;
end $$;

create trigger record_notes_notify after insert on mw.record_notes
  for each row execute function mw.notify_record_extra_change();
create trigger record_flags_notify after insert or update on mw.record_flags
  for each row execute function mw.notify_record_extra_change();
create trigger signatures_notify after insert on mw.signatures
  for each row execute function mw.notify_record_extra_change();
