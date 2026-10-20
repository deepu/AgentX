-- Phase 5: external links, deliveries, notification settings and webhooks
-- (PHASE 5 CONTRACT, docs/memwise/23-phase-5-interfaces.md).

-- ------------------------------------------------------------------ links (23 §3)

-- A single-use, expiring link. Only the sha256 of its token is kept. `step` links open the
-- current waiting step run of (run_id, step_id); `inbox` links decide one inbox item for one person.
create table mw.external_links (
  id               text primary key,                  -- lnk_<ulid>
  kind             text not null check (kind in ('step', 'inbox')),
  token_hash       text not null unique,              -- sha256 hex of the token
  run_id           text not null,
  case_id          text not null,
  step_id          text,                              -- kind step: the external step it opens
  step_run_id      text,                              -- set when it is used, or for inbox items on a step
  person_id        text,                              -- kind inbox: who it acts as
  item_id          text,                              -- kind inbox: the inbox item id
  participant      jsonb not null default '{}'::jsonb, -- { name, email, phone }
  via              text,                              -- email | whatsapp | copy
  note             text,
  draft            jsonb,                             -- values typed so far
  draft_saved_at   timestamptz,
  suggestions      jsonb not null default '[]'::jsonb, -- ExtractSuggestion[] made on this link
  files            jsonb not null default '[]'::jsonb, -- file ids uploaded through this link
  created_by       text,                              -- person id, or step:<stepRunId> for external.invite
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  sent_at          timestamptz,
  first_opened_at  timestamptz,
  last_opened_at   timestamptz,
  used_at          timestamptz,
  closed_at        timestamptz,
  closed_reason    text,                              -- answered | left | revoked | replaced
  idem_key         text unique                        -- what the token is derived from (a retried invite gets the same link)
);
create index external_links_run on mw.external_links (run_id, step_id);
create index external_links_case on mw.external_links (case_id);
create index external_links_person on mw.external_links (person_id) where person_id is not null;

-- Keys the kernel derives secrets from (link tokens, webhook secrets at rest). Never leave the core.
create table mw.kernel_keys (
  name        text primary key,
  key         bytea not null,
  created_at  timestamptz not null default now()
);

-- Suggestions made while staff fill a step in the app (23 §5); links keep their own.
alter table mw.step_runs add column if not exists suggestions jsonb not null default '[]'::jsonb;
-- How a person's answer or approval came in when not through the app: email | whatsapp (an inbox link).
alter table mw.step_runs add column if not exists decided_via text;
alter table mw.approvals add column if not exists decided_via text;

-- ------------------------------------------------------------------ deliveries (23 §6)

-- One message sent through a channel tool. Unique per purpose key, so a retry never sends twice.
create table mw.deliveries (
  id           text primary key,                      -- dlv_<ulid>
  idem_key     text not null unique,
  channel      text not null,                         -- email | whatsapp
  tool         text not null,                         -- the bound channel tool
  "to"         text not null,
  purpose      text not null,                         -- invite | reminder | notification
  link_id      text,
  case_id      text,
  person_id    text,
  item_id      text,
  status       text not null default 'pending',       -- pending | sent | delivered | read | failed
  error        text,
  provider_id  text,                                  -- the provider's message id (status webhooks)
  approved_by  text,                                  -- resend: the person who confirmed the preview
  at           timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index deliveries_link on mw.deliveries (link_id);
create index deliveries_provider on mw.deliveries (provider_id);

-- People's notification settings (off by default).
alter table mw.people add column if not exists phone text;
alter table mw.people add column if not exists notify jsonb not null default '{}'::jsonb;

-- ------------------------------------------------------------------ webhooks (23 §7)

create table mw.webhooks (
  id           text primary key,                      -- hk_<random>: also the public path
  purpose      text not null,
  plugin       text,
  scheme       text not null check (scheme in ('hmac-sha256', 'meta')),
  secret_hash  text not null,                         -- sha256 hex of the signing secret (hmac) or app secret (meta)
  secret_enc   text,                                  -- the secret itself, for verifying (encrypted at rest by the caller)
  verify_token text,                                  -- meta: the hub.verify_token
  created_by   text,
  created_at   timestamptz not null default now()
);

create table mw.inbound_events (
  id           text primary key,                      -- inb_<ulid>
  hook_id      text not null references mw.webhooks(id),
  received_at  timestamptz not null default now(),
  verified     boolean not null,
  headers      jsonb not null default '{}'::jsonb,
  body         jsonb
);
create index inbound_events_hook on mw.inbound_events (hook_id, received_at);

-- ------------------------------------------------------------------ change notifications (19 §8)

-- The case view's link panel and deliveries follow these.
create or replace function mw.notify_external_change() returns trigger
  language plpgsql as $$
begin
  perform pg_notify('mw_changes', json_build_object('kind', 'external', 'caseId', new.case_id)::text);
  return null;
end $$;

create trigger external_links_notify after insert or update on mw.external_links
  for each row execute function mw.notify_external_change();
create trigger deliveries_notify after insert or update on mw.deliveries
  for each row execute function mw.notify_external_change();
