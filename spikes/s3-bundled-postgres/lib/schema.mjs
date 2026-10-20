// A small schema using the Postgres features MemWise relies on (doc 12 §1):
// extensions, row-level security driven by a session setting, triggers,
// LISTEN/NOTIFY from a trigger, jsonb, trigram and full-text search.
// Runs unchanged on the bundled Postgres and on PGlite.

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memwise_app') THEN CREATE ROLE memwise_app NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace   text NOT NULL,
  title       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  version     int NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_title_trgm ON cases USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS cases_data_gin ON cases USING gin (data jsonb_path_ops);

ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON cases;
CREATE POLICY workspace_isolation ON cases
  USING (workspace = current_setting('memwise.workspace', true))
  WITH CHECK (workspace = current_setting('memwise.workspace', true));
GRANT SELECT, INSERT, UPDATE ON cases TO memwise_app;

CREATE OR REPLACE FUNCTION cases_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS cases_touch ON cases;
CREATE TRIGGER cases_touch BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION cases_touch();

CREATE OR REPLACE FUNCTION cases_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('case_events', json_build_object('op', TG_OP, 'id', NEW.id, 'workspace', NEW.workspace)::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cases_notify ON cases;
CREATE TRIGGER cases_notify AFTER INSERT OR UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION cases_notify();
`;

export const SEED_SQL = `
INSERT INTO cases (workspace, title, data) VALUES
  ('a', 'Client intake: Jones family', '{"priority":"high","client":{"name":"Jones"}}'),
  ('a', 'Tax return 2025 for Müller',   '{"priority":"low","tags":["tax"]}'),
  ('b', 'Intake call with Ortega',      '{"priority":"high"}');
`;

/**
 * Run the feature checks. `db` adapts either driver:
 *   db.exec(sql)            run one or more statements
 *   db.query(sql, params)   -> { rows }
 *   db.listen(channel, cb)  -> Promise<unlisten>
 * Returns [{ check, ok, detail }].
 */
export async function runChecks(db) {
  const results = [];
  const check = async (name, fn) => {
    try { const detail = await fn(); results.push({ check: name, ok: true, detail: String(detail ?? '') }); }
    catch (e) { results.push({ check: name, ok: false, detail: e.message.split('\n')[0] }); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  const notifications = [];
  const unlisten = await db.listen('case_events', (payload) => notifications.push(JSON.parse(payload)));

  await check('extensions pgcrypto + pg_trgm', async () => {
    const r = await one(`SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) AS v FROM pg_extension WHERE extname IN ('pgcrypto','pg_trgm')`);
    if (!r.v?.includes('pgcrypto') || !r.v.includes('pg_trgm')) throw new Error(`missing: ${r.v}`);
    return r.v;
  });

  await check('pgcrypto digest + gen_random_uuid', async () => {
    const r = await one(`SELECT encode(digest('memwise', 'sha256'), 'hex') AS h, gen_random_uuid() AS u`);
    return `${r.h.slice(0, 12)}…, ${r.u}`;
  });

  await check('trigger (BEFORE UPDATE bumps version)', async () => {
    const r = await one(`UPDATE cases SET title = title || ' (updated)' WHERE title LIKE 'Client intake%' RETURNING version`);
    if (r.version !== 2) throw new Error(`version=${r.version}`);
    return 'version 1 -> 2';
  });

  await check('RLS: app role sees only its workspace', async () => {
    await db.exec(`SET ROLE memwise_app; SELECT set_config('memwise.workspace', 'a', false);`);
    try {
      const r = await one(`SELECT count(*)::int AS n FROM cases`);
      if (r.n !== 2) throw new Error(`saw ${r.n} rows, expected 2`);
      let blocked = false;
      try { await db.query(`INSERT INTO cases (workspace, title) VALUES ('b', 'sneaky')`); } catch { blocked = true; }
      if (!blocked) throw new Error('cross-workspace insert was allowed');
      return 'sees 2 of 3 rows; cross-workspace insert rejected';
    } finally {
      await db.exec(`RESET ROLE; RESET memwise.workspace;`);
    }
  });

  await check('jsonb containment + path', async () => {
    const r = await one(`SELECT count(*)::int AS n, max(data #>> '{client,name}') AS name FROM cases WHERE data @> '{"priority":"high"}'`);
    if (r.n !== 2 || r.name !== 'Jones') throw new Error(JSON.stringify(r));
    return `2 high-priority, client=${r.name}`;
  });

  await check('pg_trgm fuzzy search', async () => {
    const r = await one(`SELECT title FROM cases WHERE title % 'intak with ortega' ORDER BY similarity(title, 'intak with ortega') DESC LIMIT 1`);
    if (!r?.title?.includes('Ortega')) throw new Error(`got ${r?.title}`);
    return r.title;
  });

  await check('full-text search, non-ASCII', async () => {
    const r = await one(`SELECT to_tsvector('simple', 'Müller Zürich café') @@ plainto_tsquery('simple', 'müller') AS hit, upper('café') AS up`);
    if (!r.hit) throw new Error(`no match; upper=${r.up}`);
    return `match; upper('café')=${r.up}`;
  });

  await check('LISTEN/NOTIFY from trigger', async () => {
    await db.query(`INSERT INTO cases (workspace, title) VALUES ('a', 'notify probe')`);
    for (let i = 0; i < 40 && !notifications.some((n) => n.op === 'INSERT'); i++) await new Promise((r) => setTimeout(r, 50));
    if (!notifications.length) throw new Error('no notification received');
    return `${notifications.length} events (${[...new Set(notifications.map((n) => n.op))].join(', ')})`;
  });

  await unlisten();
  return results;
}

/** A content fingerprint used to compare data across restarts and upgrades. */
export const FINGERPRINT_SQL = `SELECT count(*)::int AS n, md5(string_agg(id::text || title || data::text || version, ',' ORDER BY id)) AS md5 FROM cases`;

/** Adapter for node-postgres: one client for queries, a second one for LISTEN. */
export async function pgAdapter(makeClient) {
  const c = makeClient();
  const listener = makeClient();
  await c.connect();
  await listener.connect();
  return {
    exec: (sql) => c.query(sql),
    query: (sql, params) => c.query(sql, params),
    async listen(channel, cb) {
      listener.on('notification', (m) => m.channel === channel && cb(m.payload));
      await listener.query(`LISTEN ${channel}`);
      return () => listener.query(`UNLISTEN ${channel}`);
    },
    async close() { await c.end(); await listener.end(); },
  };
}
