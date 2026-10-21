-- Projects and pages, Stage 2 (docs/memwise/26-projects-and-pages.md §4): pages built from a
-- question. A page is a draft until someone keeps it; a kept page has a refresh schedule, and a
-- refresh that changes the answer waits as a page change until someone accepts it. Pages nest
-- (`parent`); a parent may sum up its kept sub-pages. Every version says how it was made (`via`)
-- and why. Pages carry their project from the start (Stage 1: the project id is the domain id),
-- so Stage 3's migration adds no second column here.

-- ------------------------------------------------------------------ pages

alter table mw.pages
  add column if not exists project       text,
  add column if not exists parent        text,                       -- the parent page's id
  -- Existing written pages were kept on purpose; new pages start as drafts (default below).
  add column if not exists status        text not null default 'kept' check (status in ('draft', 'kept', 'archived')),
  add column if not exists question      text,                       -- the question it answers
  add column if not exists chat_id       text,                       -- the chat that made it
  -- { every: 'mon' | 'daily' | 'month' | <weekday>, until?: 'YYYY-MM-DD', next: <iso>, last?: <iso>,
  --   playbook?: <workflow id>, summary_due?: <iso> }
  add column if not exists refresh       jsonb,
  add column if not exists pinned        boolean not null default false,
  add column if not exists sums_children boolean not null default false,
  add column if not exists owner         text,                       -- who kept it: answer changes go to them
  add column if not exists created_by    text;

update mw.pages set project = domain where project is null;
alter table mw.pages alter column project set not null;
alter table mw.pages alter column status set default 'draft';
create index if not exists pages_project on mw.pages (project, parent);

-- How each version was made: `chat:<chat id>`, `run:<run id>`, `person:<person id>`.
alter table mw.page_versions
  add column if not exists via    text,
  add column if not exists reason text;

-- ------------------------------------------------------------------ answer changes

-- What each refresh found. One that changed the answer waits here until someone accepts it (it
-- then becomes `to_version`) or sends it back (the page keeps its body); one that found nothing
-- material is kept as `nothing_new`, for the page's history line. `summary` is what the review
-- shows: { label, before, after, plus?, sections: [{ heading, markdown, origin }], left_out: [{ title,
-- href?, why }], numbers: { added, removed }, from }.
create table mw.page_changes (
  id            text primary key,                -- pch_<ulid>
  page_id       text not null references mw.pages (id),
  from_version  int not null,
  to_version    int,
  run_id        text,
  case_id       text,
  step_run_id   text,                            -- the "Review an answer change" step, once it waits
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'sent_back', 'nothing_new')),
  title         text not null,
  body          text not null,                   -- the page as the refresh rewrote it
  summary       jsonb not null default '{}'::jsonb,
  reviewed_by   text,
  comment       text,
  reviewed_at   timestamptz,
  at            timestamptz not null default now()
);
create index page_changes_page on mw.page_changes (page_id, at);
create unique index page_changes_one_pending on mw.page_changes (page_id) where status = 'pending';
create index page_changes_run on mw.page_changes (run_id);

-- ------------------------------------------------------------------ the app role

grant select, insert, update on mw.page_changes to memwise_app;

-- ------------------------------------------------------------------ change notifications (19 §8)

create or replace function mw.notify_page_change() returns trigger
  language plpgsql as $$
begin
  if tg_table_name = 'pages' then
    perform pg_notify('mw_changes', json_build_object('kind', 'pages', 'project', new.project, 'pageId', new.id)::text);
  else
    perform pg_notify('mw_changes', json_build_object('kind', 'pages', 'pageId', new.page_id, 'changeId', new.id)::text);
    perform pg_notify('mw_changes', '{"kind":"inbox"}');
  end if;
  return null;
end $$;

create trigger pages_notify after insert or update on mw.pages
  for each row execute function mw.notify_page_change();
create trigger page_changes_notify after insert or update on mw.page_changes
  for each row execute function mw.notify_page_change();
