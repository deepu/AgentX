/**
 * Test databases: a fresh, migrated database per test.
 *
 * With `MEMWISE_TEST_DATABASE_URL` (an admin URL to any Postgres) databases are created there.
 * Otherwise the first call starts one throwaway cluster for the whole process, in a temp
 * folder with the bundled (or system) binaries, and stops and deletes it when the process exits.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { embeddedBinaries, systemBinaries } from './binaries.ts';
import { quoteIdent, startCluster, stopWhenProcessExits, type Cluster } from './cluster.ts';
import { migrate } from './migrate.ts';
import { createPool } from './pool.ts';

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  /** Closes the pool and drops the database. */
  drop(): Promise<void>;
}

/** Whether `createTestDatabase` can work here, so suites can skip cleanly instead of failing. */
export function postgresAvailable(): boolean {
  if (process.env.MEMWISE_TEST_DATABASE_URL) return true;
  if (!embeddedBinaries() && !systemBinaries()) return false;
  // As root the cluster runs as the `postgres` OS user (see cluster.ts), which must exist.
  if (process.getuid?.() === 0) {
    try { return fs.readFileSync('/etc/passwd', 'utf8').split('\n').some((l) => l.startsWith('postgres:')); } catch { return false; }
  }
  return true;
}

export async function createTestDatabase(prefix = 'mw_test', opts: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = process.env.MEMWISE_TEST_DATABASE_URL || (await sharedCluster()).url();
  const name = `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`.toLowerCase();
  await admin(adminUrl, `create database ${quoteIdent(name)}`);
  const url = withDatabase(adminUrl, name);
  const pool = createPool(url, { max: 5 });
  try {
    if (opts.migrate !== false) await migrate(pool);
  } catch (e) {
    await pool.end();
    await admin(adminUrl, `drop database if exists ${quoteIdent(name)} with (force)`);
    throw e;
  }
  let dropped = false;
  return {
    name,
    url,
    pool,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      await admin(adminUrl, `drop database if exists ${quoteIdent(name)} with (force)`);
    },
  };
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

async function admin(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

// ---------------------------------------------------------------- the per-process cluster

let shared: Promise<Cluster> | undefined;

function sharedCluster(): Promise<Cluster> {
  shared ??= (async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memwise-test-pg-'));
    // When root, the cluster runs as the postgres OS user, which must be able to reach the data dir.
    fs.chmodSync(base, 0o755);
    const removeBase = () => fs.rmSync(base, { recursive: true, force: true });
    let cluster: Cluster;
    try {
      cluster = await startCluster({ dataDir: path.join(base, 'data') });
    } catch (e) {
      removeBase();
      shared = undefined;
      throw e;
    }
    // Under Node a normal exit stops it at once; the watcher covers bun test, signals and kills.
    const proc = process as unknown as { once(event: string, listener: () => void): void };
    proc.once('exit', () => { cluster.stopSync(); removeBase(); });
    stopWhenProcessExits(cluster, base);
    return cluster;
  })();
  return shared;
}
