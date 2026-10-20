import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, PgVersionStore, postgresAvailable, type TestDatabase } from '../src/index.ts';

describe.skipIf(!postgresAvailable())('version index', () => {
  let db: TestDatabase;
  const store = new PgVersionStore();
  beforeAll(async () => { db = await createTestDatabase('mw_versions'); }, 60_000);
  afterAll(() => db?.drop());

  test('found hashes are recorded once as files; a publish takes over their row; a later index never wins', async () => {
    expect(await store.recordFound(db.pool, [{ workflowId: 'w', version: 1, hash: 'h1' }])).toEqual([
      { workflowId: 'w', version: 1, hash: 'h1', source: 'files' }]);
    expect(await store.recordFound(db.pool, [{ workflowId: 'w', version: 1, hash: 'h1' }])).toEqual([]);

    await store.record(db.pool, { workflowId: 'w', version: 2, hash: 'h2', source: 'app', publishedBy: 'person_1', draftId: 'd1', runId: 'run_1' });
    expect(await store.recordFound(db.pool, [{ workflowId: 'w', version: 2, hash: 'h2' }])).toEqual([]);
    await store.record(db.pool, { workflowId: 'w', version: 2, hash: 'h2', source: 'files' });
    expect(await store.get(db.pool, 'w', 'h2')).toMatchObject({ source: 'app', publishedBy: 'person_1', draftId: 'd1', runId: 'run_1' });

    // A hash first found on disk, then published (the publish recorded it after an index got there first).
    await store.recordFound(db.pool, [{ workflowId: 'w', version: 3, hash: 'h3' }]);
    await store.record(db.pool, { workflowId: 'w', version: 3, hash: 'h3', source: 'cli' });
    expect(await store.get(db.pool, 'w', 'h3')).toMatchObject({ source: 'cli' });

    const list = await store.list(db.pool, 'w');
    expect(list.map((v) => v.hash)).toEqual(['h3', 'h2', 'h1']);
    expect(list[2]).toEqual({ workflowId: 'w', version: 1, hash: 'h1', source: 'files', publishedAt: expect.any(String) });
  });

  test('people may read the index, not write it', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role memwise_app');
      expect((await c.query(`select count(*)::int as n from mw.workflow_versions`)).rows[0].n).toBeGreaterThan(0);
      await expect(c.query(`insert into mw.workflow_versions (workflow_id, version, hash, source) values ('x', 1, 'x', 'app')`)).rejects.toThrow();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
