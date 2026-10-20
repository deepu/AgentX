import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PluginManifest } from '@memwise/defs';
import {
  createTestDatabase, PgBindingVersionStore, PgIdentityStore, PgPluginStore, postgresAvailable, type TestDatabase,
} from '../src/index.ts';

const manifest = { id: 'acme/crm', version: '1.0.0', title: 'CRM' } as unknown as PluginManifest;

describe.skipIf(!postgresAvailable())('plugins, binding versions and identity (0004)', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('mw_plugins'); }, 60_000);
  afterAll(() => db?.drop());

  test('installs are recorded per version; installing again updates the row', async () => {
    const store = new PgPluginStore();
    await store.record(db.pool, { id: 'acme/crm', version: '1.0.0', hash: 'h1', dir: 'plugins/acme__crm/1.0.0', manifest, notes: [], installedBy: 'person_1' });
    await store.record(db.pool, { id: 'acme/crm', version: '1.1.0', hash: 'h2', dir: 'plugins/acme__crm/1.1.0', manifest, notes: ['n'] });
    await store.record(db.pool, { id: 'acme/crm', version: '1.0.0', hash: 'h1b', dir: 'plugins/acme__crm/1.0.0', manifest, notes: [] });
    expect((await store.get(db.pool, 'acme/crm', '1.0.0'))).toMatchObject({ hash: 'h1b', installedBy: 'person_1' });
    expect((await store.list(db.pool, 'acme/crm')).map((p) => p.version).sort()).toEqual(['1.0.0', '1.1.0']);
    expect((await store.list(db.pool)).length).toBe(2);
  });

  test('a freeze is recorded once per binding version', async () => {
    const store = new PgBindingVersionStore();
    await store.record(db.pool, { pluginId: 'acme/crm', version: 1, pluginVersion: '1.0.0', hash: 'b1', frozenBy: 'person_2', runId: 'run_1', draftId: 'd1' });
    await store.record(db.pool, { pluginId: 'acme/crm', version: 1, pluginVersion: '1.0.0', hash: 'other' });
    await store.record(db.pool, { pluginId: 'acme/crm', version: 2, pluginVersion: '1.1.0', hash: 'b2', draftId: 'd2' });
    expect((await store.list(db.pool, 'acme/crm')).map((v) => [v.version, v.hash])).toEqual([[2, 'b2'], [1, 'b1']]);
    expect(await store.byDraft(db.pool, 'd1')).toMatchObject({ version: 1, frozenBy: 'person_2', runId: 'run_1' });
  });

  test('one link per outside record; candidates once per pair; decisions once', async () => {
    const store = new PgIdentityStore();
    const base = { entity: 'Customer', plugin: 'acme/crm', source: 'contact' };
    expect(await store.link(db.pool, { ...base, recordId: 'cust_1', externalId: 'c1', method: 'key', score: 1, reasons: ['same GSTIN'] })).toBe(true);
    expect(await store.link(db.pool, { ...base, recordId: 'cust_2', externalId: 'c1', method: 'fuzzy', score: 0.97, reasons: [] })).toBe(false);
    expect(await store.links(db.pool, 'Customer', 'cust_1')).toEqual([expect.objectContaining({ externalId: 'c1', method: 'key', reasons: ['same GSTIN'] })]);
    expect(await store.linkOf(db.pool, 'acme/crm', 'contact', 'c1')).toMatchObject({ recordId: 'cust_1' });

    const c = { ...base, recordId: 'cust_3', externalId: 'c2', score: 0.8, reasons: ['name 0.80 similar'], external: { name: 'Menon Exp' } };
    expect(await store.propose(db.pool, c)).toBe(true);
    expect(await store.propose(db.pool, c)).toBe(false);
    expect(await store.propose(db.pool, { ...c, recordId: 'cust_4' })).toBe(true);
    const pending = await store.candidates(db.pool, { status: 'pending' });
    expect(pending.map((p) => p.recordId)).toEqual(['cust_3', 'cust_4']);
    expect(await store.decide(db.pool, pending[0]!.id, 'rejected', 'person_1')).toBe(true);
    expect(await store.decide(db.pool, pending[0]!.id, 'confirmed', 'person_1')).toBe(false);
    // A rejected pair is remembered: proposing it again adds nothing.
    expect(await store.propose(db.pool, c)).toBe(false);
    // Settled, not rejected: the kernel's, not a person's "different".
    expect(await store.settleOthers(db.pool, pending[0]!, 'person_1')).toBe(1);
    expect(await store.candidate(db.pool, pending[1]!.id)).toMatchObject({ status: 'settled', decidedBy: 'person_1' });
    // Links are one to one per source: other candidates for the same domain record are settled too.
    const forCust9 = { ...base, recordId: 'cust_9', score: 0.8, reasons: [], external: {} };
    await store.propose(db.pool, { ...forCust9, externalId: 'c5' });
    await store.propose(db.pool, { ...forCust9, externalId: 'c6' });
    await store.propose(db.pool, { ...forCust9, externalId: 'c6', source: 'lead' });
    const [c5, c6, lead] = await store.candidates(db.pool, { status: 'pending' });
    expect(await store.settleOthers(db.pool, c5!, 'person_1')).toBe(1);
    expect((await store.candidate(db.pool, c6!.id))!.status).toBe('settled');
    expect((await store.candidate(db.pool, lead!.id))!.status).toBe('pending');
    expect(await store.linkOfRecord(db.pool, 'acme/crm', 'contact', 'Customer', 'cust_1')).toMatchObject({ externalId: 'c1' });
    expect(await store.linkOfRecord(db.pool, 'acme/crm', 'lead', 'Customer', 'cust_1')).toBeUndefined();
  });

  test('people may read, not write', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role memwise_app');
      expect((await c.query(`select count(*)::int as n from mw.identity_links`)).rows[0].n).toBe(1);
      await expect(c.query(`insert into mw.plugins (id, version, hash, dir, manifest) values ('x/y', '1', 'h', 'd', '{}')`)).rejects.toThrow();
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
