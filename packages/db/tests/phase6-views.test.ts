import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseCondition, type EntityTypeDef } from '@memwise/defs';
import {
  applyDomainSchema, bindTo, compileCondition, compileConditionSource, ConditionCompileError, createTestDatabase,
  evaluateCondition, literal, PgEntityStore, postgresAvailable, recordColumns, viewContext, withActor, withTransaction,
  withRecordContext, type TestDatabase,
} from '../src/index.ts';
import { fixtureDomains, fixtureEntities, person } from './phase6-fixtures.ts';

describe('compileCondition (24 §5)', () => {
  const e = fixtureEntities();
  const site = e['etmf.Site']!;
  const cols = recordColumns(site, e);
  const compile = (src: string, values: Record<string, unknown> = {}) => {
    const params: unknown[] = [];
    const sql = compileConditionSource(src, viewContext(cols, 'v.', bindTo(params), (n) => values[n]));
    return { sql, params };
  };

  test('names, literals as parameters, percent, status', () => {
    expect(compile("start_up_pack_complete = 100% and sponsor_approved")).toEqual({
      sql: '(coalesce((v."start_up_pack_complete" = $1::numeric), false) and coalesce(v."sponsor_approved", false))', params: [100],
    });
    expect(compile("status = 'open' implies activated_on is set")).toEqual({
      sql: `((not coalesce((v."lifecycle" = $1), false)) or coalesce((v."activated_on" is not null), false))`, params: ['open'],
    });
    expect(compile("site_number is set").sql).toBe(`(v."site_number" is not null and (v."site_number")::text <> '')`);
    expect(compile("status in ('open', 'activating')")).toEqual({ sql: '(v."lifecycle" in ($1, $2))', params: ['open', 'activating'] });
    expect(compile("status != 'open'").sql).toBe('(v."lifecycle" is distinct from $1)');
    expect(compile('activated_on = null').sql).toBe('(v."activated_on" is null)');
    expect(compile('record.budget > 10').sql).toBe('(v."budget" > $1::numeric)');
  });

  test('dates, durations and functions', () => {
    expect(compile('activated_on < today - 30d').sql).toBe(`(v."activated_on" < (current_date - interval '30 days'))`);
    expect(compile('days_since(activated_on) > 60').sql).toBe('((current_date - (v."activated_on")::date) > $1::numeric)');
    expect(compile('days_until(activated_on) <= 2w').sql).toContain(`interval '14 days'`);
    expect(compile("lower(site_number) = 'us-012'").sql).toBe(`(lower((v."site_number")::text) = $1)`);
    expect(compile('length(site_number) > 3').sql).toBe('(char_length((v."site_number")::text) > $1::numeric)');
    expect(compile('coalesce(budget, 0) > 1').sql).toBe('(coalesce(v."budget", $1::numeric) > $2::numeric)');
    expect(compile('created_at > now - 12h').sql).toBe(`(v."created_at" > (now() - interval '43200000 milliseconds'))`);
    expect(compile('budget / 0 > 1').sql).toBe('((v."budget" / nullif($1::numeric, 0)) > $2::numeric)');
  });

  test('params.<x> bind as parameters; unknown names and type clashes are errors with a position', () => {
    expect(compile('study = params.study', { study: 'stud_1' })).toEqual({ sql: '(v."study" = $1)', params: ['stud_1'] });
    const unknown = (() => { try { compile('budget > 1 and nope = 2'); } catch (x) { return x as ConditionCompileError; } })();
    expect(unknown).toBeInstanceOf(ConditionCompileError);
    expect(unknown).toMatchObject({ message: 'there is no field "nope" here', pos: 15 });
    expect(() => compile('params.missing = 1')).toThrow('there is no parameter "missing" here');
    expect(() => compile("budget = 'ten'")).toThrow('a number is compared with text');
    expect(() => compile("site_number + 1 > 2")).toThrow(/arithmetic/);
    expect(() => compile('budget and')).toThrow(ConditionCompileError);
  });

  test('text never becomes SQL: quotes and injections are parameters (or quoted literals in views)', () => {
    const evil = "x'); drop table mw.cases; --";
    const { sql, params } = compile(`site_number = '${evil.replace(/'/g, "\\'")}'`);
    expect(sql).toBe('(v."site_number" = $1)');
    expect(params).toEqual([evil]);
    const ast = parseCondition(`site_number = 'it''s'`).ast;
    expect(ast).toBeUndefined(); // the language has no '' escape; \' is the escape
    const inView = compileCondition(parseCondition(`site_number = 'it\\'s'`).ast!, viewContext(cols, 't.', literal));
    expect(inView).toBe(`(t."site_number" = 'it''s')`);
  });
});

describe.skipIf(!postgresAvailable())('calculated and followed fields, queries (24 §4, §6)', () => {
  let db: TestDatabase;
  let e: Record<string, EntityTypeDef>;
  const store = new PgEntityStore();
  const manager = person('person_sm', ['study_manager']);
  const cra = person('person_cra', ['cra']);
  let study: string;
  let site: string;
  let site2: string;
  let edcSite: string;

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_views');
    e = fixtureEntities();
    await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    await withActor(db.pool, manager, async (c) => {
      await withRecordContext(c, { reason: 'seed' });
      study = await store.create(c, e['etmf.Study']!, { title: 'ONC-1' });
      site = await store.create(c, e['etmf.Site']!, { site_number: 'US-012', study, activated_on: '2026-09-20', sponsor_approved: true, budget: 100 });
      site2 = await store.create(c, e['etmf.Site']!, { site_number: 'US-013', study, budget: 50 });
      for (let i = 0; i < 10; i++) {
        const x = await store.create(c, e['etmf.ExpectedDocument']!, { artifact: `A${i}`, site });
        if (i < 9) await store.transition(c, e['etmf.ExpectedDocument']!, x, { to: 'filed', transition: 'to_filed' });
      }
      const d1 = await store.create(c, e['etmf.Document']!, { title: 'CV', site, pages: 4 });
      await store.create(c, e['etmf.Document']!, { title: 'Protocol', site, pages: 10 });
      await store.transition(c, e['etmf.Document']!, d1, { to: 'filed', transition: 'to_filed' });
      edcSite = await store.create(c, e['edc.Site']!, { site_number: 'US-012', name: 'Harbor Oncology, Boston', principal_investigator: 'Dr. Lena Vogel' });
    });
    // The pairing (the kernel makes it; 24 §4): etmf.Site US-012 ↔ edc.Site.
    await db.pool.query(
      `insert into mw.identity_links (id, entity, record_id, plugin, source, external_id, method, score) values ('link_1', 'etmf.Site', $1, 'domain:edc', 'Site', $2, 'key', 1)`,
      [site, edcSite]);
  }, 60_000);
  afterAll(() => db?.drop());

  test('rollups (percent, count, sum), formulas over fields and over rollups', async () => {
    const row = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Site']!, site));
    expect(row!.values).toMatchObject({
      start_up_pack_complete: 90, documents_filed: 1, pages_total: 14, filed_twice: 2, days_activating: expect.any(Number),
    });
    const empty = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Site']!, site2));
    expect(empty!.values).toMatchObject({ start_up_pack_complete: null, documents_filed: 0, pages_total: null, filed_twice: 0 });
    const s = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Study']!, study));
    expect(s!.values).toMatchObject({ sites_total: 2, sites_ready: 0 });
  });

  test('followed fields read through the link, with the other domain\'s field access', async () => {
    const asManager = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Site']!, site));
    expect(asManager!.values).toMatchObject({ name: 'Harbor Oncology, Boston', principal_investigator: null });
    expect(asManager!.hidden).toEqual(['principal_investigator']);
    expect(asManager!.followed).toEqual({ 'edc.Site': { recordId: edcSite } });
    const asCra = await withActor(db.pool, cra, (c) => store.get(c, e['etmf.Site']!, site));
    expect(asCra!.values.principal_investigator).toBe('Dr. Lena Vogel');
    expect(asCra!.hidden).toEqual([]);
    const unpaired = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Site']!, site2));
    expect(unpaired!.values.name).toBeNull();
    expect(unpaired!.followed).toEqual({ 'edc.Site': {} });
  });

  test('evaluateCondition: holds and the values it read; guards on calculated fields', async () => {
    const guard = 'start_up_pack_complete = 100% and sponsor_approved';
    expect(await withActor(db.pool, manager, (c) => evaluateCondition(c, e['etmf.Site']!, e, site, guard)))
      .toEqual({ holds: false, values: { start_up_pack_complete: 90, sponsor_approved: true } });
    expect((await evaluateCondition(db.pool, e['etmf.Site']!, e, site, "name = 'Harbor Oncology, Boston' and status = 'selected'")).holds).toBe(true);
    expect(await evaluateCondition(db.pool, e['etmf.Site']!, e, 'site_nope', 'budget > 1')).toEqual({ holds: false, values: {} });
    expect((await evaluateCondition(db.pool, e['etmf.Site']!, e, site, 'activated_on < today + 30d')).holds).toBe(true);
    expect((await evaluateCondition(db.pool, e['etmf.Site']!, e, site, 'budget > params.min', { params: { min: 99 } })).holds).toBe(true);
    // Filing the tenth makes it 100%.
    const last = (await store.query(db.pool, e['etmf.ExpectedDocument']!, e, { filter: "status = 'expected'" })).rows[0]!;
    await withTransaction(db.pool, async (c) => {
      await withRecordContext(c, { reason: 'filed' });
      await store.transition(c, e['etmf.ExpectedDocument']!, last.id, { to: 'filed', transition: 'to_filed' });
    });
    expect((await evaluateCondition(db.pool, e['etmf.Site']!, e, site, guard)).holds).toBe(true);
    expect((await evaluateCondition(db.pool, e['etmf.Study']!, e, study, 'sites_ready = 1')).holds).toBe(true);
  });

  test('query: filter, sort, group, columns, paging, total', async () => {
    const r = await withActor(db.pool, manager, (c) => store.query(c, e['etmf.ExpectedDocument']!, e, {
      filter: "site = params.site", params: { site }, sort: [{ field: 'artifact', desc: true }], group: 'status', columns: ['artifact'], limit: 3, offset: 1,
    }));
    expect(r.total).toBe(10);
    expect(r.rows.map((x) => x.values)).toEqual([{ artifact: 'A8' }, { artifact: 'A7' }, { artifact: 'A6' }]);
    expect(r.groups).toEqual([{ key: 'filed', count: 10 }]);
    const sites = await store.query(db.pool, e['etmf.Site']!, e, { sort: [{ field: 'start_up_pack_complete', desc: true }] });
    expect(sites.rows.map((x) => x.values.site_number)).toEqual(['US-012', 'US-013']);
    await expect(store.query(db.pool, e['etmf.Site']!, e, { sort: [{ field: 'nope' }] })).rejects.toThrow('there is no field "nope" to sort by');
  });

  test('aggregate: count, sum, avg, percent with where and of', async () => {
    const agg = (a: Parameters<PgEntityStore['aggregate']>[3]) => store.aggregate(db.pool, e['etmf.Site']!, e, a);
    expect(await agg({ kind: 'count' })).toBe(2);
    expect(await agg({ kind: 'count', where: 'start_up_pack_complete = 100%' })).toBe(1);
    expect(await agg({ kind: 'sum', field: 'budget' })).toBe(150);
    expect(await agg({ kind: 'avg', field: 'budget', where: 'budget > 60' })).toBe(100);
    expect(await agg({ kind: 'percent', where: 'sponsor_approved', of: 'study = params.study', params: { study } })).toBe(50);
    expect(await agg({ kind: 'percent', where: 'sponsor_approved', of: "site_number = 'none'" })).toBeNull();
    expect(await store.aggregate(db.pool, e['etmf.Document']!, e, { kind: 'percent', where: "status = 'filed'" })).toBe(50);
  });
});
