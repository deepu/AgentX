-- Phase 4: plugins, bindings and identity links (PHASE 4 CONTRACT, docs/memwise/22-phase-4-interfaces.md).
-- Plugins and bindings are plain files in the project folder (plugins/<slug>/<version>/,
-- domain/bindings/<slug>.yaml); the database keeps what was installed and frozen, by whom, and
-- the identity links between domain records and the records connectors hold.

-- ------------------------------------------------------------------ installed plugins (22 §2)

create table mw.plugins (
  id            text not null,                   -- memwise/client-intake
  version       text not null,                   -- semver
  hash          text not null,                   -- sha256 over the installed folder
  dir           text not null,                   -- plugins/<slug>/<version>, relative to the project
  manifest      jsonb not null,                  -- the PluginManifest as installed (imported tools discovered)
  notes         jsonb not null default '[]'::jsonb,  -- install notes (ignored Claude plugin parts, discovery problems)
  installed_by  text,                            -- person id, or system / cli
  installed_at  timestamptz not null default now(),
  primary key (id, version)
);

-- ------------------------------------------------------------------ binding versions (22 §3)

-- One row per freeze: who froze which content of a plugin's binding, through which run and draft.
create table mw.binding_versions (
  plugin_id       text not null,
  version         int not null,                  -- the binding's `version:` after the freeze
  plugin_version  text not null,                 -- the plugin version it pins
  hash            text not null,                 -- content hash of the binding file
  frozen_by       text,                          -- person id of whoever approved the review
  run_id          text,                          -- the bind-plugin run
  draft_id        text,
  frozen_at       timestamptz not null default now(),
  primary key (plugin_id, version)
);

-- ------------------------------------------------------------------ identity resolution (22 §6)

-- A domain record linked to a record a plugin holds. One link per outside record.
create table mw.identity_links (
  id           text primary key,                 -- link_<ulid>
  entity       text not null,                    -- the domain entity type (Customer)
  record_id    text not null,                    -- the domain row's id
  plugin       text not null,
  source       text not null,                    -- the plugin's record source (contact)
  external_id  text not null,                    -- the record's key in the connector
  method       text not null,                    -- key | fuzzy | person | created
  score        double precision not null,
  reasons      jsonb not null default '[]'::jsonb,
  linked_by    text,                             -- person id for `person` links
  at           timestamptz not null default now(),
  unique (plugin, source, external_id)
);
create index identity_links_record on mw.identity_links (entity, record_id);

-- An uncertain match waiting for a person. A rejected pair stays (status `rejected`), so the
-- same pair is never proposed again.
create table mw.identity_candidates (
  id           text primary key,                 -- idc_<ulid>
  entity       text not null,
  record_id    text not null,
  plugin       text not null,
  source       text not null,
  external_id  text not null,
  score        double precision not null,
  reasons      jsonb not null default '[]'::jsonb,
  external     jsonb not null default '{}'::jsonb, -- the record's mapped values when the candidate was made
  status       text not null default 'pending',  -- pending | confirmed | rejected
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (plugin, source, external_id, record_id)
);
create index identity_candidates_pending on mw.identity_candidates (created_at) where status = 'pending';

-- People read all of it; the kernel (as system) writes it: installs, freezes, resolution and
-- decisions are checked by the kernel before it writes.
grant select on mw.plugins, mw.binding_versions, mw.identity_links, mw.identity_candidates to memwise_app;

-- ------------------------------------------------------------------ change notifications (19 §8)

create or replace function mw.notify_plugins_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', '{"kind":"plugins"}');
  return null;
end $$;

create trigger plugins_notify after insert or update or delete on mw.plugins
  for each statement execute function mw.notify_plugins_change();
create trigger binding_versions_notify after insert or update on mw.binding_versions
  for each statement execute function mw.notify_plugins_change();
create trigger identity_links_notify after insert or update or delete on mw.identity_links
  for each statement execute function mw.notify_plugins_change();
create trigger identity_candidates_notify after insert or update on mw.identity_candidates
  for each statement execute function mw.notify_plugins_change();
-- Pending candidates are inbox items.
create trigger identity_candidates_inbox after insert or update on mw.identity_candidates
  for each statement execute function mw.notify_inbox_change();
