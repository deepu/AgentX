// A minimal supervisor for a bundled Postgres cluster: the shape MemWise's
// desktop host would need. We drive pg_ctl rather than spawning `postgres`
// directly because on Windows pg_ctl/initdb drop admin rights with a
// restricted token (postgres refuses to run as an administrator), and
// `pg_ctl stop -m fast` is a clean shutdown on every OS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { run, isWin, sleep } from './util.mjs';

export class LocalPostgres {
  /** @param {{ bin: ReturnType<import('./binaries.mjs').binaries>, dir: string, port: number }} opts */
  constructor({ bin, dir, port }) {
    this.bin = bin;
    this.dir = dir; // e.g. ~/.memwise/postgres  (holds data/, postgres.log, .pgpass)
    this.dataDir = path.join(dir, 'data');
    this.logFile = path.join(dir, 'postgres.log');
    this.secretFile = path.join(dir, 'superuser.secret');
    this.port = port;
    this.user = 'memwise';
  }

  get password() { return fs.readFileSync(this.secretFile, 'utf8').trim(); }
  isInitialised() { return fs.existsSync(path.join(this.dataDir, 'PG_VERSION')); }

  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.secretFile, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 });
    const r = await run(this.bin.initdb, [
      `--pgdata=${this.dataDir}`,
      `--username=${this.user}`,
      `--pwfile=${this.secretFile}`,
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      // Collation from Postgres itself, not from the OS (glibc/ICU/Windows):
      // avoids index corruption when the user's OS updates its locale data,
      // and identical behaviour on all three platforms. PG 17+.
      '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--locale=C',
      '--no-instructions',
    ], { env: { LC_MESSAGES: 'C' } });
    if (r.code !== 0) throw new Error(`initdb failed (${r.code}): ${r.stderr || r.stdout}`);
    // Desktop settings: loopback only, no unix socket in /tmp, fixed port.
    fs.appendFileSync(path.join(this.dataDir, 'postgresql.auto.conf'), [
      `port = ${this.port}`,
      `listen_addresses = '127.0.0.1'`,
      `unix_socket_directories = ''`,
      `max_connections = 40`,
      '',
    ].join('\n'));
  }

  async status() {
    const r = await run(this.bin.pg_ctl, ['status', '-D', this.dataDir]);
    return r.code === 0; // 0 = running, 3 = not running, 4 = no data dir
  }

  async start() {
    // stdio ignored: the server's output goes to the log file (see util.run).
    const r = await run(this.bin.pg_ctl, ['start', '-D', this.dataDir, '-l', this.logFile, '-w', '-t', '60'], { stdio: 'ignore' });
    if (r.code !== 0) throw new Error(`pg_ctl start failed (${r.code}); log tail:\n${this.logTail()}`);
    await this.waitReady();
  }

  /**
   * `pg_ctl start -w` is not enough on its own. On Windows pg_ctl cannot match
   * the postmaster's PID, so it accepts any postmaster.pid saying "ready" whose
   * start time is within 2 s of its own; a pid file left by a server killed a
   * moment earlier passes, and pg_ctl returns before the new server listens
   * (seen in CI as ECONNREFUSED right after a crash restart). So we also wait
   * until a real connection succeeds.
   */
  async waitReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = this.client();
      try { await c.connect(); await c.query('SELECT 1'); return; }
      catch (e) {
        // ECONNREFUSED: not listening yet. 57P03: still starting up or in recovery.
        const transient = e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === '57P03';
        if (!transient || Date.now() > deadline) throw new Error(`Postgres not ready: ${e.message}; log tail:\n${this.logTail()}`);
      } finally { await c.end().catch(() => {}); }
      await sleep(100);
    }
  }

  /** What the app does on launch: adopt a server left running by a crashed app, else start it. */
  async ensureStarted() {
    if (!this.isInitialised()) await this.init();
    if (await this.status()) return 'adopted';
    await this.start();
    return 'started';
  }

  async stop() {
    const r = await run(this.bin.pg_ctl, ['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '60']);
    if (r.code !== 0) throw new Error(`pg_ctl stop failed: ${r.stderr}`);
  }

  postmasterPid() {
    try { return Number(fs.readFileSync(path.join(this.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]); }
    catch { return null; }
  }

  /** Simulate power loss / OOM kill: kill the postmaster and all its children at once. */
  async hardKill() {
    const pid = this.postmasterPid();
    if (!pid) return;
    if (isWin) await run('taskkill', ['/F', '/T', '/PID', String(pid)]);
    else for (const p of await processTree(pid)) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
    for (let i = 0; i < 50 && (await processTree(pid)).length; i++) await sleep(100);
  }

  client(database = 'postgres') {
    return new pg.Client({ host: '127.0.0.1', port: this.port, user: this.user, password: this.password, database });
  }

  async query(sql, params) {
    const c = this.client();
    await c.connect();
    try { return await c.query(sql, params); } finally { await c.end(); }
  }

  /** Memory of the postmaster and its children. Linux: PSS (shared pages split fairly); else RSS / working set. */
  async memory() {
    const procs = await processTree(this.postmasterPid());
    const sum = (k) => procs.reduce((a, p) => a + (p[k] ?? 0), 0);
    return { processes: procs.length, rss: sum('rss'), pss: process.platform === 'linux' ? sum('pss') : null };
  }

  logTail(n = 15) {
    try { return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return '(no log)'; }
  }
}

/** The process `rootPid` and all its descendants, with memory in bytes. */
export async function processTree(rootPid) {
  if (!rootPid) return [];
  let all;
  if (isWin) {
    const ps = `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize)`;
    const r = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    all = JSON.parse(r.stdout || '[]').map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, rss: Number(p.WorkingSetSize) }));
  } else {
    const r = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
    all = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).map(([pid, ppid, rss]) => ({ pid, ppid, rss: rss * 1024 }));
  }
  const tree = all.filter((p) => p.pid === rootPid);
  if (!tree.length) return [];
  for (let i = 0; i < tree.length; i++) tree.push(...all.filter((p) => p.ppid === tree[i].pid));
  if (process.platform === 'linux') {
    for (const p of tree) {
      try { p.pss = Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8'))[1]) * 1024; } catch {}
    }
  }
  return tree;
}
