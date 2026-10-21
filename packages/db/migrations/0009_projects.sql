-- Projects and pages, Stage 3 (docs/memwise/26-projects-and-pages.md §3, D87, D92): projects
-- inside apps. A project is one copy of an app (a domain used as a template) with its own records,
-- pages, runs, chats, people and connections. App tables stay named by app (`<domain>__<entity>`,
-- D72) and gain a `project` column, added by the domain DDL (domain/tables.ts) for every entity
-- with `scope: project` (the default). This file holds what doesn't depend on definitions: the
-- projects themselves, `project` on every per-project kernel table, grants per project, and the
-- row rules that read them.
--
-- Existing rows go into one project per domain, id = the domain id (an app without
-- projects/<id>/project.yaml is exactly that project). Nothing else moves.

-- ------------------------------------------------------------------ projects

create table mw.projects (
  id                text primary key,              -- the folder name (projects/<id>/), or the domain id
  app               text not null,                 -- the domain it is a copy of
  name              text not null,
  status            text not null default 'active' check (status in ('draft', 'active', 'archived')),
  "from"            jsonb,                         -- { template, version } | { project } | { blank: true }
  template_version  int not null default 1,        -- the app version its template was taken from
  study             text,                          -- the study key linking projects across apps (26 §9)
  settings          jsonb not null default '{}'::jsonb,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index projects_app on mw.projects (app);
create index projects_study on mw.projects (study) where study is not null;

-- Runs, cases and step runs belong to a project (filled and made required below).
alter table mw.cases add column if not exists project text;
alter table mw.runs add column if not exists project text;
alter table mw.step_runs add column if not exists project text;

-- The domain a workflow belongs to, from its latest indexed definition ('domain' when unknown).
create or replace function mw.workflow_domain(p_workflow text) returns text
  language sql stable as $$
    select coalesce((select d.body ->> 'domain' from mw.definitions d
                     where d.kind = 'workflow' and d.id = p_workflow order by d.indexed_at desc limit 1), 'domain')
  $$;

-- ------------------------------------------------------------------ grants per project

-- A grant in a domain is now a grant in one of its projects, or (project null) in all of them.
alter table mw.grants add column if not exists project text;
-- `definitions`: made at index from a project.yaml's people (replaced at each index); otherwise
-- given by a person in the app.
alter table mw.grants add column if not exists source text not null default 'app' check (source in ('app', 'definitions'));
create index if not exists grants_project on mw.grants (project) where project is not null;

-- The app a project belongs to (the id itself for a project the database doesn't know: the
-- convention of a domain's own project).
create or replace function mw.project_app(p_project text) returns text
  language sql stable as $$ select coalesce((select p.app from mw.projects p where p.id = p_project), p_project) $$;

-- Whether a person's grants let them see project `p_project` of domain `p_domain` (D92): anyone
-- who isn't a person; a person with no grant in the domain (workspace-wide roles, as before
-- projects); a person with a grant in that project or in every project of the domain.
-- `p_project` null (an app-scoped record, shared by every project) needs any grant in the domain.
create or replace function mw.domain_project_visible(p_domain text, p_project text) returns boolean
  language sql stable as $$
    select coalesce(mw.actor_kind(), '') <> 'person'
      or not exists (select 1 from jsonb_array_elements(mw.actor_grants()) g where g ->> 'domain' = p_domain)
      or exists (
        select 1 from jsonb_array_elements(mw.actor_grants()) g
        where g ->> 'domain' = p_domain
          and (p_project is null or g ->> 'project' is null or g ->> 'project' = p_project))
  $$;

-- The same for a row that names only its project (runs, cases, pages, chats).
create or replace function mw.project_visible(p_project text) returns boolean
  language sql stable as $$
    select p_project is null or coalesce(mw.actor_kind(), '') <> 'person'
      or mw.domain_project_visible(mw.project_app(p_project), p_project)
  $$;

-- A row of an app table: its project visible (above), and inside the project the record scope
-- of Phase 6 (24 §2) from the grants that apply to that project. With no project grants this is
-- exactly mw.in_scope.
create or replace function mw.row_visible(p_domain text, p_project text, p_row jsonb) returns boolean
  language sql stable as $$
    select coalesce(mw.actor_kind(), '') <> 'person'
      or not exists (select 1 from jsonb_array_elements(mw.actor_grants()) g where g ->> 'domain' = p_domain)
      or exists (
        select 1 from jsonb_array_elements(mw.actor_grants()) g
        where g ->> 'domain' = p_domain
          and (p_project is null or g ->> 'project' is null or g ->> 'project' = p_project)
          and (jsonb_typeof(g -> 'scope') is distinct from 'object' or g -> 'scope' = '{}'::jsonb
               or not exists (
                 select 1 from jsonb_each(g -> 'scope') s(k, ids)
                 where p_row ? s.k
                   and not coalesce((p_row ->> s.k) is not null and (s.ids ? (p_row ->> s.k) or s.ids = to_jsonb(p_row ->> s.k)), false))))
  $$;

-- A role in a domain's project: workspace-wide, or a grant in that project or the whole domain.
create or replace function mw.actor_has_role_in_project(role text, p_domain text, p_project text) returns boolean
  language sql stable as $$
    select mw.actor_has_role(role) or exists (
      select 1 from jsonb_array_elements(mw.actor_grants()) g
      where g ->> 'role' = role and g ->> 'domain' = p_domain
        and (p_project is null or g ->> 'project' is null or g ->> 'project' = p_project))
  $$;

-- The project a write lands in when the writer doesn't say: `mw.project` (withRecordContext,
-- the app), else the project of the step token's run, else the domain's own project.
create or replace function mw.current_project(p_domain text) returns text
  language sql stable as $$
    select coalesce(
      nullif(current_setting('mw.project', true), ''),
      (select r.project from mw.runs r where r.case_id = mw.token_case() and mw.project_app(r.project) = p_domain
        order by r.created_at limit 1),
      p_domain)
  $$;

-- ------------------------------------------------------------------ project on runs, cases and step runs


update mw.runs r set project = mw.workflow_domain(r.workflow_id) where r.project is null;
update mw.cases c set project = coalesce((select r.project from mw.runs r where r.case_id = c.id order by r.created_at limit 1),
                                         mw.workflow_domain(c.workflow_id)) where c.project is null;
update mw.step_runs s set project = coalesce((select r.project from mw.runs r where r.id = s.run_id),
                                             mw.workflow_domain(s.workflow_id)) where s.project is null;

-- A row written without one (older code, a test) takes its workflow's domain's project; a step
-- run takes its run's.
create or replace function mw.fill_project() returns trigger
  language plpgsql as $$
begin
  if new.project is null then
    if tg_table_name = 'step_runs' then
      new.project := (select r.project from mw.runs r where r.id = new.run_id);
    elsif tg_table_name = 'cases' then
      new.project := nullif(current_setting('mw.project', true), '');
    end if;
    new.project := coalesce(new.project, mw.workflow_domain(new.workflow_id));
  end if;
  return new;
end $$;

create trigger cases_project before insert on mw.cases for each row execute function mw.fill_project();
create trigger runs_project before insert on mw.runs for each row execute function mw.fill_project();
create trigger step_runs_project before insert on mw.step_runs for each row execute function mw.fill_project();

alter table mw.cases alter column project set not null;
alter table mw.runs alter column project set not null;
alter table mw.step_runs alter column project set not null;
create index cases_project on mw.cases (project);
create index runs_project on mw.runs (project, status);
create index step_runs_project on mw.step_runs (project, status);

-- People see runs, cases and step runs of their projects only (compileRls states the same at index).
drop policy if exists mw_person_all on mw.cases;
create policy mw_person_all on mw.cases for all to memwise_app
  using (mw.actor_kind() = 'person' and mw.project_visible(project)) with check (mw.actor_kind() = 'person' and mw.project_visible(project));
drop policy if exists mw_person_all on mw.runs;
create policy mw_person_all on mw.runs for all to memwise_app
  using (mw.actor_kind() = 'person' and mw.project_visible(project)) with check (mw.actor_kind() = 'person' and mw.project_visible(project));
drop policy if exists mw_person_all on mw.step_runs;
create policy mw_person_all on mw.step_runs for all to memwise_app
  using (mw.actor_kind() = 'person' and mw.project_visible(project)) with check (mw.actor_kind() = 'person' and mw.project_visible(project));

-- ------------------------------------------------------------------ project on pages, chats, notes, mentions, views, history

-- The domain of an entity key: `etmf.Site` → etmf; a bare name is the default domain's.
create or replace function mw.entity_domain(p_entity text) returns text
  language sql immutable as $$ select case when position('.' in p_entity) > 0 then split_part(p_entity, '.', 1) else 'domain' end $$;

-- Pages carry `project` since 0008_pages.
alter table mw.chat_anchors add column if not exists project text;
alter table mw.record_notes add column if not exists project text;
alter table mw.mentions add column if not exists project text;
alter table mw.views add column if not exists project text;
alter table mw.record_versions add column if not exists project text;
alter table mw.entity_events add column if not exists project text;
alter table mw.record_flags add column if not exists project text;

update mw.chat_anchors a set project = case a.anchor_kind
    when 'case' then (select c.project from mw.cases c where c.id = a.anchor_id)
    when 'step' then (select s.project from mw.step_runs s where s.id = a.anchor_id)
    when 'page' then (select p.project from mw.pages p where p.id = a.anchor_id)
    when 'record' then mw.entity_domain(split_part(a.anchor_id, ':', 1))
  end
  where a.project is null;
update mw.record_notes set project = mw.entity_domain(entity) where project is null;
update mw.mentions set project = mw.entity_domain(target_entity) where project is null;
update mw.views set project = domain where project is null;
update mw.record_flags set project = domain where project is null;

create index chat_anchors_project on mw.chat_anchors (project);
create index record_notes_project on mw.record_notes (project);
create index mentions_project on mw.mentions (project);
create index views_project on mw.views (person_id, project);
create index record_versions_project on mw.record_versions (project) where project is not null;
create index record_flags_project on mw.record_flags (project, raised_at) where closed_at is null;

-- A chat anchored to a case, step or page belongs to its project; one anchored elsewhere takes
-- `mw.project` when the writer gives none.
create or replace function mw.fill_anchor_project() returns trigger
  language plpgsql as $$
begin
  if new.project is null then
    new.project := case new.anchor_kind
      when 'case' then (select c.project from mw.cases c where c.id = new.anchor_id)
      when 'step' then (select s.project from mw.step_runs s where s.id = new.anchor_id)
      when 'page' then (select p.project from mw.pages p where p.id = new.anchor_id)
      when 'page_change' then (select p.project from mw.page_changes pc join mw.pages p on p.id = pc.page_id where pc.id = new.anchor_id)
    end;
    new.project := coalesce(new.project, nullif(current_setting('mw.project', true), ''));
  end if;
  return new;
end $$;
create trigger chat_anchors_project before insert or update on mw.chat_anchors for each row execute function mw.fill_anchor_project();

-- Notes and mentions written in the app say their project through `mw.project`.
alter table mw.record_notes alter column project set default nullif(current_setting('mw.project', true), '');
alter table mw.mentions alter column project set default nullif(current_setting('mw.project', true), '');

-- Row rules: a person sees these only in projects they can see. Rows without a project (written
-- before it was known) stay visible, as before.
alter table mw.pages enable row level security;
create policy mw_pages_person on mw.pages for all to memwise_app
  using (mw.actor_kind() is distinct from 'person' or mw.project_visible(project))
  with check (mw.actor_kind() is distinct from 'person' or mw.project_visible(project));

alter table mw.page_versions enable row level security;
create policy mw_page_versions_read on mw.page_versions for select to memwise_app
  using (exists (select 1 from mw.pages p where p.id = page_id));
create policy mw_page_versions_add on mw.page_versions for insert to memwise_app
  with check (exists (select 1 from mw.pages p where p.id = page_id));

alter table mw.page_changes enable row level security;
create policy mw_page_changes_person on mw.page_changes for all to memwise_app
  using (exists (select 1 from mw.pages p where p.id = page_id))
  with check (exists (select 1 from mw.pages p where p.id = page_id));

alter table mw.chat_anchors enable row level security;
create policy mw_chat_anchors_person on mw.chat_anchors for all to memwise_app
  using (mw.actor_kind() is distinct from 'person' or mw.project_visible(project))
  with check (mw.actor_kind() is distinct from 'person' or mw.project_visible(project));

alter table mw.record_notes enable row level security;
create policy mw_record_notes_read on mw.record_notes for select to memwise_app using (mw.project_visible(project));
create policy mw_record_notes_add on mw.record_notes for insert to memwise_app with check (mw.project_visible(project));

alter table mw.mentions enable row level security;
create policy mw_mentions_person on mw.mentions for all to memwise_app
  using (mw.project_visible(project)) with check (mw.project_visible(project));

alter table mw.record_versions enable row level security;
create policy mw_record_versions_read on mw.record_versions for select to memwise_app using (mw.project_visible(project));

alter table mw.record_flags enable row level security;
create policy mw_record_flags_person on mw.record_flags for all to memwise_app
  using (mw.project_visible(project)) with check (mw.project_visible(project));

-- Versions and events with their project: the generated row triggers pass it (records-sql.ts).
create or replace function mw.write_record_version(p_entity text, p_record_id text, p_version int, p_by text, p_via text,
                                                   p_reason text, p_values jsonb, p_changed text[], p_project text) returns text
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
  insert into mw.record_versions (entity, record_id, version, at, by, via, reason, "values", changed, prev_hash, hash, project)
  values (p_entity, p_record_id, p_version, t, p_by, p_via, p_reason, p_values, coalesce(p_changed, '{}'), prev, h, p_project);
  return h;
end $$;
revoke execute on function mw.write_record_version(text, text, int, text, text, text, jsonb, text[], text) from public;

create or replace function mw.write_entity_event(p_entity text, p_record_id text, p_kind text, p_data jsonb, p_by text, p_project text) returns void
  language plpgsql as $$
begin
  insert into mw.entity_events (id, entity, record_id, kind, data, by, project)
  values ('evt_' || mw.ulid(), p_entity, p_record_id, p_kind, coalesce(p_data, '{}'::jsonb), p_by, p_project);
  perform pg_notify('mw_changes', '{"kind":"entity"}');
  perform pg_notify('mw_changes', json_build_object('kind', 'records', 'entity', p_entity, 'recordId', p_record_id, 'project', p_project)::text);
end $$;
revoke execute on function mw.write_entity_event(text, text, text, jsonb, text, text) from public;

-- ------------------------------------------------------------------ one project per domain

-- Every domain this database has seen: indexed domains, and any domain named by data.
insert into mw.projects (id, app, name, template_version)
select d.id, d.id, coalesce((select x.body ->> 'name' from mw.definitions x where x.kind = 'domain' and x.id = d.id
                             order by x.indexed_at desc limit 1), d.id), 1
from (
  select id from mw.definitions where kind = 'domain'
  union select domain from mw.grants
  union select project from mw.pages
  union select domain from mw.views
  union select domain from mw.record_flags
  union select project from mw.runs
) d
where d.id is not null
on conflict (id) do nothing;

-- ------------------------------------------------------------------ the app role

grant select on mw.projects to memwise_app;

-- ------------------------------------------------------------------ change notifications (19 §8)

create or replace function mw.notify_project_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object('kind', 'projects', 'projectId', new.id)::text);
  return null;
end $$;
create trigger projects_notify after insert or update on mw.projects
  for each row execute function mw.notify_project_change();
