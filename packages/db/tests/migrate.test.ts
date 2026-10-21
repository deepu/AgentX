import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPool, createTestDatabase, migrate, postgresAvailable, withTransaction, type TestDatabase } from '../src/index.ts';

const ALL = ['0001_kernel.sql', '0002_people_and_domain.sql', '0003_change_control.sql', '0004_plugins.sql', '0005_external.sql', '0006_domains_and_records.sql', '0007_flow.sql', '0008_pages.sql', '0009_projects.sql'];

describe.skipIf(!postgresAvailable())('migrate', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('mw_migrate', { migrate: false }); }, 60_000);
  afterAll(() => db?.drop());

  test('applies the kernel schema once; a second run is a no-op', async () => {
    expect(await migrate(db.pool)).toEqual(ALL);
    expect(await migrate(db.pool)).toEqual([]);
    const { rows } = await db.pool.query('select name, checksum from mw.schema_migrations order by name');
    expect(rows.map((r) => r.name)).toEqual(ALL);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('concurrent callers on separate pools do not collide', async () => {
    const fresh = await createTestDatabase('mw_migrate_par', { migrate: false });
    const pools = [0, 1, 2, 3].map(() => createPool(fresh.url, { max: 2 }));
    try {
      const results = await Promise.all(pools.map((p) => migrate(p)));
      expect(results.flat()).toEqual(ALL);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await fresh.drop();
    }
  });

  test('refuses to run when an applied file has changed', async () => {
    const fresh = await createTestDatabase('mw_migrate_sum', { migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-migrations-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table t (a int);');
      expect(await migrate(fresh.pool, { dir })).toEqual(['0001_a.sql']);
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table t (a int, b int);');
      fs.writeFileSync(path.join(dir, '0002_b.sql'), 'create table u (a int);');
      await expect(migrate(fresh.pool, { dir })).rejects.toThrow(/0001_a.sql was changed/);
      // Nothing after the changed file was applied, and the lock was released.
      const { rows } = await fresh.pool.query(`select to_regclass('u') as u`);
      expect(rows[0].u).toBeNull();
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'create table t (a int);');
      expect(await migrate(fresh.pool, { dir })).toEqual(['0002_b.sql']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  test('a failing migration rolls back and is not recorded', async () => {
    const fresh = await createTestDatabase('mw_migrate_fail', { migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-migrations-'));
    try {
      fs.writeFileSync(path.join(dir, '0001_bad.sql'), 'create table t (a int); select nope;');
      await expect(migrate(fresh.pool, { dir })).rejects.toThrow(/0001_bad.sql failed/);
      const { rows } = await fresh.pool.query(`select to_regclass('t') as t, (select count(*)::int from mw.schema_migrations) as n`);
      expect(rows[0]).toEqual({ t: null, n: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  test('withTransaction commits, and rolls back on throw', async () => {
    await db.pool.query('create table if not exists tx_probe (a int)');
    await withTransaction(db.pool, (c) => c.query('insert into tx_probe values (1)'));
    await expect(withTransaction(db.pool, async (c) => {
      await c.query('insert into tx_probe values (2)');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const { rows } = await db.pool.query('select a from tx_probe order by a');
    expect(rows).toEqual([{ a: 1 }]);
  });
});
