import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  applyDomainSchema, createTestDatabase, domainToolNames, entityColumns, entityTableName, PgEntityStore, PgRecordVersions,
  postgresAvailable, withActor, type TestDatabase,
} from '../src/index.ts';
import { entity, f, fixtureDomains, fixtureEntities, person } from './phase6-fixtures.ts';

test('tables and tools are named by domain (24 §3)', () => {
  const e = fixtureEntities();
  expect(entityTableName('Customer')).toBe('domain__customer');
  expect(entityTableName(e.Customer!)).toBe('domain__customer');
  expect(entityTableName(e['etmf.Site']!)).toBe('etmf__site');
  expect(entityTableName(e['etmf.ExpectedDocument']!)).toBe('etmf__expected_document');
  expect(entityTableName('edc.Site')).toBe('edc__site');
  expect(domainToolNames('Customer')).toEqual({
    create: 'domain.customer.create', get: 'domain.customer.get', update: 'domain.customer.update',
    transition: 'domain.customer.transition', list: 'domain.customer.list',
  });
  expect(domainToolNames(e['etmf.ExpectedDocument']!).get).toBe('etmf.expected_document.get');
  // A field named like a Phase 6 column is stored beside it.
  expect(entityColumns(e['etmf.Document']!).find((c) => c.field === 'version')?.column).toBe('fld_version');
});

describe.skipIf(!postgresAvailable())('Phase 6 schema', () => {
  let db: TestDatabase;
  const store = new PgEntityStore();
  const versions = new PgRecordVersions();

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_schema');
  }, 60_000);
  afterAll(() => db?.drop());

  test('a Phase 5 table is renamed, keeps its rows and ids, and gets first versions', async () => {
    // The Phase 2–5 layout: domain.customer with a `version` field column and a view.
    await db.pool.query(`
      create table domain.customer (
        id text primary key, lifecycle text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        created_by_step text, idempotency_key text unique, name text, version text);
      create view domain_read.customer as select * from domain.customer;
      insert into domain.customer (id, lifecycle, name, version, created_by_step) values
        ('cust_A', 'prospect', 'Asha Traders', 'v2', 'run_x/1/onboard'),
        ('cust_B', 'active', 'Bharat Metals', null, null);`);
    const e = fixtureEntities();
    const notes = await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    expect(notes).toContain('Customer: table domain.customer renamed to domain.domain__customer');
    expect(notes.some((n) => n.includes('renamed to fld_version'))).toBe(true);
    expect((await db.pool.query(`select to_regclass('domain.customer') as r`)).rows[0].r).toBeNull();
    expect((await db.pool.query(`select to_regclass('domain_read.customer') as r`)).rows[0].r).toBeNull();

    const rows = await withActor(db.pool, person('person_a'), (c) => store.list(c, e.Customer!));
    expect(rows.map((r) => [r.id, r.values.name, r.values.version, r.version]).sort()).toEqual([
      ['cust_A', 'Asha Traders', 'v2', 1], ['cust_B', 'Bharat Metals', undefined, 1],
    ]);
    const v = await versions.list(db.pool, 'Customer', 'cust_A');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version: 1, by: 'step:run_x/1/onboard', reason: 'recorded before version history' });
    expect(v[0]!.values).toEqual({ status: 'prospect', name: 'Asha Traders', version: 'v2' });
    expect((await versions.list(db.pool, 'Customer', 'cust_B'))[0]!.by).toBe('system');
    expect(await versions.verifyChain(db.pool, 'Customer', 'cust_A')).toEqual({ ok: true });

    // A second index changes nothing: no rename, no new versions.
    expect(await applyDomainSchema(db.pool, e, { domains: fixtureDomains() })).toEqual([]);
    expect(await versions.list(db.pool, 'Customer', 'cust_A')).toHaveLength(1);

    // The next change continues the chain at version 2.
    await withActor(db.pool, person('person_a'), (c) => store.update(c, e.Customer!, 'cust_A', { name: 'Asha Traders Ltd' }));
    const after = await versions.list(db.pool, 'Customer', 'cust_A');
    expect(after.map((x) => [x.version, x.by, x.changed])).toEqual([[1, 'step:run_x/1/onboard', []], [2, 'person_a', ['name']]]);
    expect(after[1]!.prevHash).toBe(after[0]!.hash);
    expect(await versions.verifyChain(db.pool, 'Customer', 'cust_A')).toEqual({ ok: true });
  });

  test('every table has version and updated_by; created_at and updated_at come from the server', async () => {
    const { rows } = await db.pool.query(
      `select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'domain' and column_name in ('version', 'updated_by', 'fld_version') order by 1, 2`);
    const byTable = new Map<string, string[]>();
    for (const r of rows) byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), `${r.column_name}:${r.data_type}`]);
    expect(byTable.get('etmf__document')).toEqual(['fld_version:text', 'updated_by:text', 'version:integer']);
    expect(byTable.get('edc__site')).toEqual(['updated_by:text', 'version:integer']);

    // A writer that sends its own timestamps or version is overruled.
    await db.pool.query(`insert into domain.etmf__sponsor (id, name, created_at, updated_at, version) values ('spon_T', 'T', '2001-01-01', '2001-01-01', 7)`);
    const r = (await db.pool.query(`select created_at > now() - interval '1 minute' as fresh, version from domain.etmf__sponsor where id = 'spon_T'`)).rows[0];
    expect(r).toEqual({ fresh: true, version: 1 });
  });

  test('a table made by an older index without a version field gets the columns too', async () => {
    const late = entity('domain', 'Lead', { fields: { name: f('Text') } });
    await db.pool.query(`create table domain.lead (id text primary key, lifecycle text, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), created_by_step text, idempotency_key text unique, name text);
      insert into domain.lead (id, name) values ('lead_1', 'L')`);
    await applyDomainSchema(db.pool, { Lead: late });
    const row = await store.get(db.pool, late, 'lead_1');
    expect(row).toMatchObject({ id: 'lead_1', version: 1, values: { name: 'L' } });
  });
});
