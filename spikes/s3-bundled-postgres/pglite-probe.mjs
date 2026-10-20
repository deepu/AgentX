// PGlite measurements, run in a child process so its memory numbers are clean.
// Prints one JSON object on stdout. Usage: <node|bun> pglite-probe.mjs <dataDir> <socketPort>
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { SCHEMA_SQL, SEED_SQL, FINGERPRINT_SQL, runChecks } from './lib/schema.mjs';

const [dataDir, socketPort] = [process.argv[2], Number(process.argv[3])];
const rss = () => process.memoryUsage().rss;
const timed = async (fn) => { const t = performance.now(); const v = await fn(); return [Math.round(performance.now() - t), v]; };
const out = { rssBaseline: rss() };

const [importMs, mods] = await timed(async () => ({
  PGlite: (await import('@electric-sql/pglite')).PGlite,
  pgcrypto: (await import('@electric-sql/pglite/contrib/pgcrypto')).pgcrypto,
  pg_trgm: (await import('@electric-sql/pglite/contrib/pg_trgm')).pg_trgm,
  PGLiteSocketServer: (await import('@electric-sql/pglite-socket')).PGLiteSocketServer,
}));
out.importMs = importMs;
const open = () => mods.PGlite.create({ dataDir, extensions: { pgcrypto: mods.pgcrypto, pg_trgm: mods.pg_trgm } });

fs.rmSync(dataDir, { recursive: true, force: true });
let db;
[out.coldInitMs, db] = await timed(open);
out.rssAfterColdOpen = rss();
out.version = (await db.query('SHOW server_version')).rows[0].server_version;
await db.exec(SCHEMA_SQL);
await db.exec(SEED_SQL);
out.checks = await runChecks({
  exec: (sql) => db.exec(sql),
  query: (sql, params) => db.query(sql, params),
  listen: (channel, cb) => db.listen(channel, cb),
});
const before = (await db.query(FINGERPRINT_SQL)).rows[0];
out.rssAfterChecks = rss();
[out.closeMs] = await timed(() => db.close());

// Warm start: reopen the same data directory.
const warm = [];
for (let i = 0; i < 3; i++) {
  const [ms, d] = await timed(open);
  warm.push(ms);
  if (i < 2) await d.close(); else db = d;
}
out.warmStartMs = warm;
const after = (await db.query(FINGERPRINT_SQL)).rows[0];
out.persisted = before.md5 === after.md5;
out.rssIdle = rss();

// Concurrency. PGlite is one Postgres backend in-process: one session, so
// statements from different callers are serialised and share session state.
const [txBlockMs] = await timed(async () => {
  const tx = db.transaction(async (t) => { await t.query(`INSERT INTO cases (workspace, title) VALUES ('a','tx row')`); await new Promise((r) => setTimeout(r, 300)); });
  await new Promise((r) => setTimeout(r, 20));
  await db.query('SELECT 1'); // waits until the transaction above finishes
  await tx;
});
out.inProcessQueryWaitsForOpenTxMs = txBlockMs;

// Multi-client access over the wire protocol via pglite-socket (what DBOS's pg pool would use).
const server = new mods.PGLiteSocketServer({ db, port: socketPort, host: '127.0.0.1', maxConnections: 10 });
await server.start();
const mk = () => new pg.Client({ host: '127.0.0.1', port: socketPort, user: 'postgres', database: 'postgres' });
const a = mk(), b = mk();
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
const sock = {};
try {
  await withTimeout(Promise.all([a.connect(), b.connect()]), 5000);
  sock.twoConnections = 'ok';
  await a.query(`SELECT set_config('memwise.workspace', 'from-A', false)`);
  sock.sessionStateSharedAcrossConnections = (await b.query(`SELECT current_setting('memwise.workspace', true) AS v`)).rows[0].v === 'from-A';
  const base = (await b.query('SELECT count(*)::int AS n FROM cases')).rows[0].n;
  await a.query('BEGIN');
  await a.query(`INSERT INTO cases (workspace, title) VALUES ('a', 'uncommitted on A')`);
  try {
    const n = (await withTimeout(b.query('SELECT count(*)::int AS n FROM cases'), 3000)).rows[0].n;
    sock.connBWhileATxOpen = n > base ? 'sees A uncommitted row (no isolation)' : 'isolated';
  } catch (e) { sock.connBWhileATxOpen = `blocked (${e.message})`; }
  await withTimeout(a.query('ROLLBACK'), 5000).catch(() => {});
} catch (e) {
  sock.error = e.message;
}
await Promise.allSettled([a.end(), b.end()]);
await server.stop();
out.socket = sock;

await db.close();
out.dataDirBytes = dirBytes(dataDir);
console.log(JSON.stringify(out));
process.exit(0);

function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    n += e.isDirectory() ? dirBytes(p) : e.isFile() ? fs.statSync(p).size : 0;
  }
  return n;
}
