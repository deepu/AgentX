// MemWise spike S3: bundled Postgres on desktop.
// Usage: node measure.mjs   |   bun measure.mjs
// Env: MEMWISE_HOME (default ~/.memwise), RESULTS_DIR (default ./results)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binaries, platformPackage, SPIKE_DIR } from './lib/binaries.mjs';
import { LocalPostgres } from './lib/cluster.mjs';
import { SCHEMA_SQL, SEED_SQL, FINGERPRINT_SQL, runChecks, pgAdapter } from './lib/schema.mjs';
import { run, timed, sleep, dirStats, mb, median, printTable, runtime, isWin } from './lib/util.mjs';

const PORT = 54323;        // bundled Postgres (current)
const PORT_OLD = 54326;    // previous major, side by side during the major-upgrade copy
const PORT_SOCKET = 54327; // pglite-socket
const SECTION_TIMEOUT_MS = 240_000;
const MEMWISE_HOME = process.env.MEMWISE_HOME || path.join(os.homedir(), '.memwise');
const ROOT = path.join(MEMWISE_HOME, 'spike-s3');
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(SPIKE_DIR, 'results');
const tag = `${process.platform}-${process.arch}-${runtime.split(' ')[0]}`;

if (!isWin && process.getuid?.() === 0) {
  console.error('Postgres refuses to run as root. Run this as a normal user (e.g. runuser -u <user> -- node measure.mjs).');
  process.exit(2);
}

const R = { platform: `${process.platform}-${process.arch}`, runtime, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, dataRoot: ROOT };
const started = [];
let failed = false;
const section = async (name, fn) => {
  console.error(`\n== ${name}`);
  const before = started.length;
  // A hung step shows up as a named failure instead of a silent CI timeout.
  let timer;
  const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${SECTION_TIMEOUT_MS / 1000} s`)), SECTION_TIMEOUT_MS); });
  try { R[name] = await Promise.race([fn(), watchdog]); }
  catch (e) {
    failed = true; R[name] = { error: e.message }; console.error(`!! ${name} failed: ${e.stack}`);
    // Stop what this section started, so the next section can bind its port.
    for (const c of started.slice(before)) if (fs.existsSync(c.dataDir) && (await c.status().catch(() => false))) await c.stop().catch(() => {});
  } finally { clearTimeout(timer); }
};
const cluster = (flavour, dir, port) => { const c = new LocalPostgres({ bin: binaries(flavour), dir: path.join(ROOT, dir), port }); started.push(c); return c; };
const fingerprint = async (c) => (await c.query(FINGERPRINT_SQL)).rows[0];
const applySchema = async (c, seed = true) => { await c.query(SCHEMA_SQL); if (seed) await c.query(SEED_SQL); };

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

await section('sizes', async () => {
  const bin = binaries('current');
  const installed = dirStats(bin.root);
  const registry = {};
  if (!process.env.SKIP_REGISTRY) for (const p of ['darwin-arm64', 'darwin-x64', 'windows-x64', 'linux-x64']) {
    const pkg = `@embedded-postgres/${p}@18.4.0-beta.17`;
    const r = await run(isWin ? 'npm.cmd' : 'npm', ['view', pkg, 'dist.unpackedSize', '--json'], { shell: isWin, timeoutMs: 30_000 }).catch(() => ({}));
    registry[p] = Number(r.stdout?.trim()) || null;
  }
  const pglite = dirStats(path.join(SPIKE_DIR, 'node_modules', '@electric-sql', 'pglite'));
  return { installedPackage: platformPackage(), installedBytes: installed.bytes, installedFiles: installed.files, registryUnpacked: registry, pgliteBytes: pglite.bytes };
});

await section('embedded', async () => {
  const out = {};
  const c = cluster('current', 'postgres', PORT);
  [out.initdbMs] = await timed(() => c.init());
  out.dataDirBytesAfterInit = dirStats(c.dataDir).bytes;
  [out.firstStartMs] = await timed(() => c.start());
  [out.firstQueryMs] = await timed(() => c.query('SELECT 1'));
  out.version = (await c.query('SHOW server_version')).rows[0].server_version;
  out.collation = (await c.query(`SELECT datlocprovider, datlocale, datcollate FROM pg_database WHERE datname = 'postgres'`)).rows[0];
  out.sharedBuffers = (await c.query('SHOW shared_buffers')).rows[0].shared_buffers;
  await applySchema(c);
  const db = await pgAdapter(() => c.client());
  out.checks = await runChecks(db);
  await db.close();
  const fp = await fingerprint(c);

  await sleep(3000);
  out.memIdle = await c.memory();
  const pool = Array.from({ length: 10 }, () => c.client());
  await Promise.all(pool.map((p) => p.connect().then(() => p.query('SELECT 1'))));
  out.memWith10Connections = await c.memory();
  await Promise.all(pool.map((p) => p.end()));

  const starts = [], stops = [];
  for (let i = 0; i < 3; i++) {
    const [stopMs] = await timed(() => c.stop()); stops.push(stopMs);
    const [startMs] = await timed(() => c.start()); starts.push(startMs);
  }
  out.stopMs = stops; out.warmStartMs = starts;
  out.persistedAcrossRestarts = (await fingerprint(c)).md5 === fp.md5;

  // App crashed but Postgres kept running: the next app launch adopts it.
  const relaunch = new LocalPostgres({ bin: c.bin, dir: c.dir, port: PORT });
  out.relaunchWhileServerRunning = await relaunch.ensureStarted();

  // Power loss / OOM: kill every postgres process, then start again (crash recovery).
  await c.query(`INSERT INTO cases (workspace, title) VALUES ('a', 'committed just before the crash')`);
  const fpBeforeCrash = await fingerprint(c);
  await c.hardKill();
  [out.startAfterCrashMs] = await timed(() => c.start());
  out.committedDataSurvivedCrash = (await fingerprint(c)).md5 === fpBeforeCrash.md5;
  out.dataDirBytes = dirStats(c.dataDir).bytes;
  await c.stop();
  return out;
});

await section('minorUpgrade', async () => {
  // Data dir created by 18.1, opened by 18.4 from a different install path (= app update).
  const old = cluster('18.1', 'minor', PORT);
  await old.init(); await old.start();
  const from = (await old.query('SHOW server_version')).rows[0].server_version;
  await applySchema(old);
  const fp = await fingerprint(old);
  await old.stop();
  const next = cluster('current', 'minor', PORT);
  const [startMs] = await timed(() => next.start());
  const to = (await next.query('SHOW server_version')).rows[0].server_version;
  const same = (await fingerprint(next)).md5 === fp.md5;
  await next.stop();
  return { from, to, startMs, dataIntact: same, binDirChanged: old.bin.root !== next.bin.root };
});

await section('majorUpgrade', async () => {
  const old = cluster('17', 'major-old', PORT_OLD);
  await old.init(); await old.start();
  const from = (await old.query('SHOW server_version')).rows[0].server_version;
  await applySchema(old);
  const fp = await fingerprint(old);
  await old.stop();

  // 1. New binaries on the old data dir must refuse cleanly (and not touch it).
  const naive = new LocalPostgres({ bin: binaries('current'), dir: old.dir, port: PORT_OLD });
  let refusal = 'started (unexpected!)';
  try { await naive.start(); await naive.stop(); }
  catch { refusal = /FATAL:\s*(.*)/.exec(naive.logTail(5))?.[1] ?? 'refused'; }

  // 2. Upgrade without pg_upgrade/pg_dump (not shipped): run both majors side
  //    by side, create the schema on the new one from our migrations, copy rows.
  const next = cluster('current', 'major-new', PORT);
  await old.start();
  const [initMs] = await timed(async () => { await next.init(); await next.start(); });
  const [copyMs] = await timed(async () => {
    await applySchema(next, false);
    const rows = (await old.query('SELECT coalesce(json_agg(c), \'[]\') AS j FROM cases c')).rows[0].j;
    await next.query('INSERT INTO cases SELECT * FROM json_populate_recordset(NULL::cases, $1)', [JSON.stringify(rows)]);
  });
  const to = (await next.query('SHOW server_version')).rows[0].server_version;
  const same = (await fingerprint(next)).md5 === fp.md5;
  await old.stop(); await next.stop();
  return { from, to, newBinariesOnOldDir: refusal, newClusterInitStartMs: initMs, schemaAndCopyMs: copyMs, dataIntact: same };
});

await section('pglite', async () => {
  const r = await run(process.execPath, [path.join(SPIKE_DIR, 'pglite-probe.mjs'), path.join(ROOT, 'pglite'), String(PORT_SOCKET)], { timeoutMs: 230_000 });
  if (r.code !== 0) throw new Error(`probe exited ${r.code}: ${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
});

// Never leave a server running (e.g. after a failed section).
for (const c of started) if (fs.existsSync(c.dataDir) && (await c.status().catch(() => false))) await c.stop().catch(() => {});

// ---------------------------------------------------------------- report
const E = R.embedded ?? {}, P = R.pglite ?? {}, S = R.sizes ?? {}, mi = R.minorUpgrade ?? {}, ma = R.majorUpgrade ?? {};
const ok = (b) => (b === true ? 'yes' : b === false ? 'NO' : 'n/a');
const memNote = process.platform === 'linux' ? 'PSS (shared memory split fairly), RSS in brackets' : (isWin ? 'working set, summed' : 'RSS, summed (overcounts shared memory)');
const mem = (m) => (m ? `${mb(m.pss ?? m.rss)}${m.pss ? ` [rss ${mb(m.rss)}]` : ''} / ${m.processes} procs` : 'n/a');
const checks = (list) => (list ? `${list.filter((x) => x.ok).length}/${list.length} pass` : 'n/a');

printTable(`S3 results: ${R.platform}, ${R.runtime}, ${R.os}`, [
  ['embedded-postgres version', E.version ?? E.error ?? 'n/a'],
  ['installed size (this platform)', `${mb(S.installedBytes)}, ${S.installedFiles ?? '?'} files`, S.installedPackage],
  ...Object.entries(S.registryUnpacked ?? {}).map(([p, b]) => [`  npm unpacked ${p}`, mb(b)]),
  ['cold init (initdb)', `${E.initdbMs ?? 'n/a'} ms`],
  ['first start (pg_ctl start -w)', `${E.firstStartMs ?? 'n/a'} ms`],
  ['connect + first query', `${E.firstQueryMs ?? 'n/a'} ms`],
  ['warm start (3 runs)', E.warmStartMs ? `${E.warmStartMs.join(', ')} ms` : 'n/a'],
  ['stop (pg_ctl stop -m fast)', E.stopMs ? `${E.stopMs.join(', ')} ms` : 'n/a'],
  ['start after crash (recovery)', `${E.startAfterCrashMs ?? 'n/a'} ms`, `data intact: ${ok(E.committedDataSurvivedCrash)}`],
  ['relaunch, server still running', E.relaunchWhileServerRunning ?? 'n/a'],
  ['memory idle', mem(E.memIdle), memNote],
  ['memory with 10 connections', mem(E.memWith10Connections)],
  ['data dir after init / after test', `${mb(E.dataDirBytesAfterInit)} / ${mb(E.dataDirBytes)}`],
  ['collation provider', E.collation ? `${E.collation.datlocprovider} ${E.collation.datlocale}` : 'n/a'],
  ['schema checks', checks(E.checks)],
  ['minor upgrade', mi.error ?? `${mi.from} -> ${mi.to}: data intact ${ok(mi.dataIntact)}, start ${mi.startMs} ms`],
  ['major: new bins on old dir', ma.error ?? ma.newBinariesOnOldDir],
  ['major: side-by-side copy', ma.error ? 'n/a' : `${ma.from} -> ${ma.to}: data intact ${ok(ma.dataIntact)}, copy ${ma.schemaAndCopyMs} ms`],
]);
printTable('PGlite (same schema)', [
  ['version', P.version ?? P.error ?? 'n/a'],
  ['package size', mb(S.pgliteBytes)],
  ['import', `${P.importMs ?? 'n/a'} ms`],
  ['cold init (new data dir)', `${P.coldInitMs ?? 'n/a'} ms`],
  ['warm open (3 runs)', P.warmStartMs ? `${P.warmStartMs.join(', ')} ms` : 'n/a'],
  ['close', `${P.closeMs ?? 'n/a'} ms`],
  ['process RSS baseline / after open / after checks', `${mb(P.rssBaseline)} / ${mb(P.rssAfterColdOpen)} / ${mb(P.rssAfterChecks)}`],
  ['data dir', mb(P.dataDirBytes)],
  ['schema checks', checks(P.checks)],
  ['persisted across reopen', ok(P.persisted)],
  ['query waits for open tx (in-process)', `${P.inProcessQueryWaitsForOpenTxMs ?? 'n/a'} ms`],
  ['socket: 2 connections', P.socket?.twoConnections ?? P.socket?.error ?? 'n/a'],
  ['socket: session state shared', ok(P.socket?.sessionStateSharedAcrossConnections)],
  ['socket: conn B while A in tx', P.socket?.connBWhileATxOpen ?? 'n/a'],
]);
const failedChecks = [...(E.checks ?? []).map((c) => ['embedded', c]), ...(P.checks ?? []).map((c) => ['pglite', c])].filter(([, c]) => !c.ok);
for (const [who, c] of failedChecks) console.log(`FAILED CHECK (${who}): ${c.check}: ${c.detail}`);

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(path.join(RESULTS_DIR, `results-${tag}.json`), JSON.stringify(R, null, 2));
const embeddedOk = !failed && E.checks?.every((c) => c.ok) && mi.dataIntact && ma.dataIntact && E.committedDataSurvivedCrash;
console.log(`\nVERDICT (${R.platform}, ${R.runtime}): bundled Postgres ${embeddedOk ? 'PASS' : 'FAIL'}`);
process.exit(embeddedOk ? 0 : 1);
