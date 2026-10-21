-- Stage 6, EDC and studies across apps (docs/memwise/26-projects-and-pages.md §9, D110–D112).
--
-- A connector's record sources are read again on a schedule (a binding's `sync:`), refreshing the
-- fields the plugin owns on the records linked to them, so a change made in Rave (a new site
-- coordinator) becomes an entity event here. One row per plugin: when it was last read, what it
-- found, when it is due again, and the error if the last read failed.
create table mw.source_syncs (
  plugin     text primary key,                    -- memwise/medidata-rave
  at         timestamptz,                         -- the last read that finished
  next_due   timestamptz,                         -- when the sweep reads it again (null: only on demand)
  counts     jsonb not null default '{}'::jsonb,  -- { linked, created, refreshed, unmatched, candidates }
  error      text,                                -- the last read's error, cleared by the next good one
  error_at   timestamptz
);

-- A followed field changing on the other side of a link (24 §4) is announced on the following
-- record too (kind `changed`, data `{ fields, via: 'link', cause: <event id> }`), once per cause.
create unique index entity_events_link_cause on mw.entity_events (entity, record_id, (data ->> 'cause')) where data ? 'cause';

grant select on mw.source_syncs to memwise_app;
