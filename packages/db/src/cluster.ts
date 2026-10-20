/**
 * The bundled Postgres supervisor (D37, from spike S3): `initdb` on first use, `pg_ctl start`,
 * then a real connection before reporting ready, and `pg_ctl stop -m fast` on quit.
 *
 * We drive pg_ctl rather than spawning `postgres` ourselves: on Windows pg_ctl and initdb drop
 * administrator rights with a restricted token, and `pg_ctl stop -m fast` is a clean shutdown on
 * every OS.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { findBinaries, majorVersion, type PgBinaries } from './binaries.ts';

export interface ClusterOptions {
  dataDir: string;
  /** Port to listen on (127.0.0.1 only). A free one is picked when omitted. */
  port?: number;
  /** Folder holding initdb, pg_ctl and postgres; defaults to the bundled ones (see binaries.ts). */
  binDir?: string;
  log?: (message: string) => void;
}

export interface Cluster {
  port: number;
  dataDir: string;
  /** Whether this call started the server or found it already running (a crashed host's orphan). */
  started: 'started' | 'adopted';
  /** Superuser connection URL for a database. */
  url(database?: string): string;
  createDatabase(name: string): Promise<void>;
  /** Drops the database, closing any connections still open to it. */
  dropDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
  /** Synchronous stop, for process `exit` handlers where nothing async runs. */
  stopSync(): void;
}

const SUPERUSER = 'postgres';
const SOCKET_PREFIX = 'memwise-pg-';
const isWin = process.platform === 'win32';

/** `~/.memwise/postgres/data` (or under `MEMWISE_CONFIG_DIR`). */
export function defaultDataDir(): string {
  const home = process.env.MEMWISE_CONFIG_DIR || path.join(os.homedir(), '.memwise');
  return path.join(home, 'postgres', 'data');
}

export async function startCluster(opts: ClusterOptions): Promise<Cluster> {
  const log = opts.log ?? (() => {});
  const bins = findBinaries(opts.binDir);
  const dataDir = path.resolve(opts.dataDir);
  const logFile = path.join(path.dirname(dataDir), 'postgres.log');
  const owner = postgresOwner();
  const exec = executor(owner);

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', { mode: 0o600 });
  if (owner) {
    fs.chownSync(dataDir, owner.uid, owner.gid);
    fs.chownSync(logFile, owner.uid, owner.gid);
    const probe = spawnSync('runuser', ['-u', owner.name, '--', 'test', '-w', dataDir]);
    if (probe.status !== 0) throw new Error(`The ${owner.name} OS user cannot write ${dataDir}; every parent folder must be traversable by it`);
  }

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    if (fs.readdirSync(dataDir).length) throw new Error(`${dataDir} is not empty and is not a Postgres data directory`);
    log(`initdb ${dataDir} (${bins.source} binaries in ${bins.binDir})`);
    await initdb(bins, dataDir, exec);
  }

  const tail = () => logTail(logFile);
  const running = runningServer(dataDir);
  if (running) {
    // A server left running by a host that crashed: adopt it rather than start a second one.
    log(`adopting the server already running on port ${running.port} (pid ${running.pid})`);
    await waitReady(running.port, tail, 30_000);
    return handle({ bins, dataDir, port: running.port, socketDir: running.socketDir, exec, started: 'adopted' });
  }

  const port = opts.port ?? (await freePort());
  const socketDir = isWin ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), SOCKET_PREFIX));
  if (socketDir && owner) fs.chownSync(socketDir, owner.uid, owner.gid);
  const serverOpts = [`-p ${port}`, ...(socketDir ? [`-k '${socketDir}'`] : [])].join(' ');

  // After a hard kill, the old server's children can outlive the postmaster for a moment and
  // still hold its shared memory, so the new postmaster refuses to start. Retry briefly.
  for (let attempt = 1; ; attempt++) {
    const r = await exec(bins.pg_ctl, ['start', '-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', serverOpts], { stdio: 'ignore' });
    if (r.code === 0) break;
    const why = tail();
    if (attempt < 25 && /pre-existing shared memory block|lock file .* already exists/.test(why)) {
      removeStalePid(dataDir);
      await sleep(200);
      continue;
    }
    if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
    throw new Error(`pg_ctl start failed (${r.code}); log tail:\n${why}`);
  }
  await waitReady(port, tail);
  log(`postgres listening on 127.0.0.1:${port}`);
  return handle({ bins, dataDir, port, socketDir, exec, started: 'started' });
}

// ---------------------------------------------------------------- the handle

function handle(c: { bins: PgBinaries; dataDir: string; port: number; socketDir?: string; exec: Exec; started: Cluster['started'] }): Cluster {
  const url = (database = 'postgres') => `postgresql://${SUPERUSER}@127.0.0.1:${c.port}/${encodeURIComponent(database)}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: url(), connectionTimeoutMillis: 10_000 });
    await client.connect();
    try { await client.query(sql); } finally { await client.end(); }
  };
  const stopArgs = ['stop', '-D', c.dataDir, '-m', 'fast', '-w', '-t', '60'];
  // Our socket folders have a known prefix; an adopted server's came from an earlier host of ours.
  const ownSocketDir = c.socketDir && path.basename(c.socketDir).startsWith(SOCKET_PREFIX) ? c.socketDir : undefined;
  const cleanup = () => { if (ownSocketDir) fs.rmSync(ownSocketDir, { recursive: true, force: true }); };
  let stopped = false;
  const cluster: Cluster = {
    port: c.port,
    dataDir: c.dataDir,
    started: c.started,
    url,
    createDatabase: (name) => admin(`create database ${quoteIdent(name)}`),
    dropDatabase: (name) => admin(`drop database if exists ${quoteIdent(name)} with (force)`),
    async stop() {
      if (stopped) return;
      const r = await c.exec(c.bins.pg_ctl, stopArgs);
      // Exit code 1 with no pid file: it was not running (already stopped or killed).
      if (r.code !== 0 && fs.existsSync(path.join(c.dataDir, 'postmaster.pid'))) throw new Error(`pg_ctl stop failed: ${r.stderr || r.stdout}`);
      stopped = true;
      cleanup();
    },
    stopSync() {
      if (stopped) return;
      const [cmd, args] = c.exec.command(c.bins.pg_ctl, stopArgs);
      spawnSync(cmd, args, { stdio: 'ignore', cwd: os.tmpdir(), timeout: 60_000 });
      stopped = true;
      cleanup();
    },
  };
  stopCommands.set(cluster, { stop: c.exec.command(c.bins.pg_ctl, stopArgs), socketDir: ownSocketDir });
  return cluster;
}

const stopCommands = new WeakMap<Cluster, { stop: [string, string[]]; socketDir?: string }>();

/**
 * Stops the cluster (and deletes `removeDir`) once this process is gone, however it ends.
 * `process.on('exit')` is not enough: `bun test` never fires it, and a SIGKILL skips it. So a
 * small detached watcher polls for our pid and runs `pg_ctl stop` after we die. For throwaway
 * test clusters; the desktop host instead adopts its server on the next launch.
 */
export function stopWhenProcessExits(cluster: Cluster, removeDir?: string): void {
  const known = stopCommands.get(cluster);
  if (!known) throw new Error('Not a cluster started by startCluster');
  const watch = `
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const { ppid, cmd, args, dirs } = JSON.parse(process.env.MEMWISE_PG_WATCHDOG);
    const alive = () => { try { process.kill(ppid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const timer = setInterval(() => {
      if (alive()) return;
      clearInterval(timer);
      spawnSync(cmd, args, { stdio: 'ignore', timeout: 60000 });
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }, 500);`;
  const env = { ...process.env, MEMWISE_PG_WATCHDOG: JSON.stringify({
    ppid: process.pid, cmd: known.stop[0], args: known.stop[1], dirs: [known.socketDir, removeDir].filter(Boolean),
  }) };
  // cwd: a neutral folder, so no bunfig.toml preload or package config is picked up.
  spawn(process.execPath, ['-e', watch], { detached: true, stdio: 'ignore', cwd: os.tmpdir(), env, windowsHide: true }).unref();
}

// ---------------------------------------------------------------- init, readiness, stale state

async function initdb(bins: PgBinaries, dataDir: string, exec: Exec): Promise<void> {
  // Collation from Postgres itself (PG 17+), not the OS, so an OS locale update can't corrupt
  // indexes and all three platforms sort the same. Older system installs get plain C.
  const locale = majorVersion(bins) >= 17
    ? ['--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C']
    : ['--locale=C'];
  const r = await exec(bins.initdb, [
    `--pgdata=${dataDir}`, `--username=${SUPERUSER}`, '--auth=trust', '--encoding=UTF8', ...locale, '--no-instructions',
  ]);
  if (r.code !== 0) throw new Error(`initdb failed (${r.code}): ${r.stderr || r.stdout}`);
  // Loopback only. Trust auth is safe only because nothing outside this machine can connect;
  // the per-start socket folder is passed on the command line.
  fs.appendFileSync(path.join(dataDir, 'postgresql.auto.conf'), [
    `listen_addresses = '127.0.0.1'`,
    ...(isWin ? [`unix_socket_directories = ''`] : []),
    '',
  ].join('\n'));
}

/**
 * `pg_ctl start -w` alone is not a readiness check: on Windows pg_ctl can accept the pid file of
 * a server killed a moment ago and return before the new one listens (S3). So we also wait for
 * a real connection and a query.
 */
async function waitReady(port: number, tail: () => string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ host: '127.0.0.1', port, user: SUPERUSER, database: 'postgres', connectionTimeoutMillis: 2000 });
    client.on('error', () => {});
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query('select 1');
      return;
    } catch (e) {
      const err = e as { code?: string; message: string };
      // Not listening yet, or still starting / in crash recovery (57P03).
      const transient = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === '57P03' || /timeout|terminated/i.test(err.message);
      if (!transient || Date.now() > deadline) throw new Error(`Postgres on port ${port} is not ready: ${err.message}; log tail:\n${tail()}`);
    } finally {
      // Don't await end() on a socket that never connected: it can wait for a close that already happened.
      if (connected) await client.end().catch(() => {});
      else client.end().catch(() => {});
    }
    await sleep(100);
  }
}

/** postmaster.pid lines: pid, data dir, start time, port, socket dir, listen address, shmem key, status. */
function readPid(dataDir: string): { pid: number; port: number; socketDir?: string } | undefined {
  try {
    const lines = fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
    const pid = Number(lines[0]);
    const port = Number(lines[3]);
    return pid > 0 ? { pid, port, socketDir: lines[4]?.trim() || undefined } : undefined;
  } catch {
    return undefined;
  }
}

/** The server named by postmaster.pid when it is still alive; otherwise clears a stale pid file. */
function runningServer(dataDir: string): { pid: number; port: number; socketDir?: string } | undefined {
  const info = readPid(dataDir);
  if (!info) return undefined;
  if (info.port > 0 && isPostmaster(info.pid)) return info;
  // The postmaster died (crash, power loss, SIGKILL). Postgres tolerates a stale pid file unless
  // its pid now belongs to another live process, so remove it ourselves, and its socket folder.
  removeStalePid(dataDir);
  if (info.socketDir && path.basename(info.socketDir).startsWith(SOCKET_PREFIX)) fs.rmSync(info.socketDir, { recursive: true, force: true });
  return undefined;
}

function removeStalePid(dataDir: string): void {
  const info = readPid(dataDir);
  if (info && isPostmaster(info.pid)) return;
  fs.rmSync(path.join(dataDir, 'postmaster.pid'), { force: true });
}

function isPostmaster(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as { code?: string }).code !== 'EPERM') return false; }
  // On Linux we can also rule out a reused pid; elsewhere the readiness check does that.
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('postgres'); } catch { return false; }
  }
  return true;
}

function logTail(file: string, n = 15): string {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(no log)'; }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- running the binaries

interface Owner { name: string; uid: number; gid: number }

/**
 * initdb, pg_ctl and postgres refuse to run as root. When this process is root (containers and
 * CI only; the desktop app never runs as root) we run them as the `postgres` OS user through
 * `runuser` and hand it the data directory.
 */
function postgresOwner(): Owner | undefined {
  if (process.getuid?.() !== 0) return undefined;
  const id = (flag: string) => spawnSync('id', [flag, 'postgres'], { encoding: 'utf8' });
  const uid = id('-u');
  const gid = id('-g');
  if (uid.status !== 0 || gid.status !== 0) {
    throw new Error('Running as root: Postgres refuses to run as root and there is no `postgres` OS user to run it as');
  }
  return { name: 'postgres', uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}

interface Exec {
  (cmd: string, args: string[], opts?: { stdio?: 'pipe' | 'ignore'; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  command(cmd: string, args: string[]): [string, string[]];
}

function executor(owner: Owner | undefined): Exec {
  const command = (cmd: string, args: string[]): [string, string[]] =>
    owner ? ['runuser', ['-u', owner.name, '--', cmd, ...args]] : [cmd, args];
  const exec = ((cmd, args, { stdio = 'pipe', timeoutMs = 120_000 } = {}) =>
    new Promise((resolve, reject) => {
      const [c, a] = command(cmd, args);
      // cwd: the postgres OS user may not be able to read ours (e.g. /root).
      const child = spawn(c, a, { stdio, cwd: os.tmpdir(), env: { ...process.env, LC_MESSAGES: 'C' }, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(cmd)} timed out`)); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      // Resolve on exit, not close: the postmaster started by pg_ctl can inherit and hold our pipes.
      child.on('exit', (code) => { clearTimeout(timer); setTimeout(() => resolve({ code, stdout, stderr }), 20); });
    })) as Exec;
  exec.command = command;
  return exec;
}
