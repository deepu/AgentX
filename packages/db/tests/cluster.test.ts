import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { embeddedBinaries, startCluster, type Cluster } from '../src/index.ts';

const bins = embeddedBinaries();

async function query(url: string, sql: string) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

function postmasterPid(dataDir: string): number {
  return Number(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
}

describe.skipIf(!bins)('bundled cluster (embedded binaries)', () => {
  let base: string;
  let dataDir: string;
  let cluster: Cluster | undefined;

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cluster-'));
    fs.chmodSync(base, 0o755); // reachable by the postgres OS user when tests run as root
    dataDir = path.join(base, 'data');
  });
  afterAll(async () => {
    await cluster?.stop().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('initdb, start, create a database, stop', async () => {
    cluster = await startCluster({ dataDir, binDir: bins!.binDir });
    expect(cluster.started).toBe('started');
    expect(fs.existsSync(path.join(dataDir, 'PG_VERSION'))).toBe(true);
    const [row] = await query(cluster.url(), `select current_setting('server_version_num')::int as v, current_setting('listen_addresses') as l`);
    expect(row.v).toBeGreaterThanOrEqual(180000);
    expect(row.l).toBe('127.0.0.1');
    await cluster.createDatabase('app');
    await query(cluster.url('app'), 'create table kept (a int); insert into kept values (42)');
    await cluster.stop();
    await cluster.stop(); // idempotent
    expect(fs.existsSync(path.join(dataDir, 'postmaster.pid'))).toBe(false);
  }, 60_000);

  test('restarts on a chosen port with data intact', async () => {
    const port = cluster!.port + 1;
    cluster = await startCluster({ dataDir, port });
    expect(cluster.port).toBe(port);
    expect(await query(cluster.url('app'), 'select a from kept')).toEqual([{ a: 42 }]);
  }, 60_000);

  test('adopts a server that is already running', async () => {
    const again = await startCluster({ dataDir });
    expect(again.started).toBe('adopted');
    expect(again.port).toBe(cluster!.port);
  }, 30_000);

  test('recovers after the postmaster is SIGKILLed', async () => {
    await query(cluster!.url('app'), 'insert into kept values (43)');
    process.kill(postmasterPid(dataDir), 'SIGKILL');
    cluster = await startCluster({ dataDir });
    expect(cluster.started).toBe('started');
    expect(await query(cluster.url('app'), 'select a from kept order by a')).toEqual([{ a: 42 }, { a: 43 }]);
  }, 60_000);

  test('a stale postmaster.pid naming a live non-postgres process does not block start', async () => {
    await cluster!.stop();
    // Our own pid is alive but is not a postmaster: what a reused pid looks like after a crash.
    fs.writeFileSync(path.join(dataDir, 'postmaster.pid'), `${process.pid}\n${dataDir}\n0\n${cluster!.port}\n\n127.0.0.1\n0 0\nready\n`);
    cluster = await startCluster({ dataDir });
    expect(cluster.started).toBe('started');
    await cluster.dropDatabase('app');
    expect(await query(cluster.url(), `select count(*)::int as n from pg_database where datname = 'app'`)).toEqual([{ n: 0 }]);
  }, 60_000);
});
