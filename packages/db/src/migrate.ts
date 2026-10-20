/**
 * Schema migrations: the numbered `.sql` files in `packages/db/migrations`, applied in name order.
 *
 * Several processes may start at once (host, workers, a second app window), and DBOS showed
 * that parallel first launches collide on migrations (D35). So the whole run holds a Postgres
 * advisory lock: the second caller waits, then finds everything applied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Arbitrary but fixed: "mwmigr" in ASCII. Only needs to differ from other advisory locks we take. */
const LOCK_KEY = '120364616919410';

export interface MigrateOptions {
  /** Folder of `.sql` files; defaults to this package's migrations. */
  dir?: string;
  log?: (message: string) => void;
}

/** Apply every migration not yet recorded. Returns the names applied by this call. */
export async function migrate(pool: pg.Pool, opts: MigrateOptions = {}): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`
        create schema if not exists mw;
        create table if not exists mw.schema_migrations (
          name        text primary key,
          applied_at  timestamptz not null default now(),
          checksum    text not null
        );`);
      const { rows } = await client.query<{ name: string; checksum: string }>('select name, checksum from mw.schema_migrations');
      const applied = new Map(rows.map((r) => [r.name, r.checksum]));
      const done: string[] = [];
      for (const name of files) {
        const sql = fs.readFileSync(path.join(dir, name), 'utf8');
        const checksum = crypto.createHash('sha256').update(sql).digest('hex');
        const known = applied.get(name);
        if (known !== undefined) {
          if (known !== checksum) {
            throw new Error(`Migration ${name} was changed after it was applied (checksum ${known.slice(0, 12)} → ${checksum.slice(0, 12)}). Put the change in a new migration file.`);
          }
          continue;
        }
        opts.log?.(`applying migration ${name}`);
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into mw.schema_migrations (name, checksum) values ($1, $2)', [name, checksum]);
          await client.query('commit');
        } catch (e) {
          await client.query('rollback').catch((err: Error) => { broken = err; });
          throw new Error(`Migration ${name} failed: ${(e as Error).message}`, { cause: e });
        }
        done.push(name);
      }
      return done;
    } finally {
      if (!broken) await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch((err: Error) => { broken = err; });
    }
  } finally {
    // Destroying the connection also drops a session lock we could not release.
    client.release(broken);
  }
}
