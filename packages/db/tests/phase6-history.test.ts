import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityTypeDef } from '@memwise/defs';
import {
  applyDomainSchema, createTestDatabase, PgEntityEvents, PgEntityStore, PgRecordVersions, postgresAvailable,
  RecordWriteError, withActor, withRecordContext, withTransaction, type TestDatabase,
} from '../src/index.ts';
import { fixtureDomains, fixtureEntities, person, stepActor } from './phase6-fixtures.ts';

describe.skipIf(!postgresAvailable())('record versions, chain, events (24 §3, §7)', () => {
  let db: TestDatabase;
  let e: Record<string, EntityTypeDef>;
  const store = new PgEntityStore();
  const versions = new PgRecordVersions();
  const events = new PgEntityEvents();
  const manager = person('person_sm', ['study_manager']);
  let study: string;
  let site: string;

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_history');
    e = fixtureEntities();
    await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    study = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Study']!, { title: 'ONC-1' }, { reason: 'set up' }));
    site = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Site']!, { site_number: 'US-012', study }, { reason: 'set up' }));
  }, 60_000);
  afterAll(() => db?.drop());

  test('every write is a version with who, when, why and what changed; the chain verifies', async () => {
    await withActor(db.pool, manager, async (c) => {
      await withRecordContext(c, { via: 'app' });
      return store.update(c, e['etmf.Site']!, site, { budget: 1000 }, { reason: 'budget agreed' });
    });
    const r = await withActor(db.pool, manager, (c) => store.transition(c, e['etmf.Site']!, site, { to: 'activating', transition: 'picked', reason: 'picked by sponsor' }));
    expect(r).toEqual({ version: 3, from: 'selected' });
    const list = await versions.list(db.pool, 'etmf.Site', site);
    expect(list.map((v) => [v.version, v.by, v.via, v.reason, v.changed])).toEqual([
      [1, 'person_sm', 'app', 'set up', ['site_number', 'study', 'status']],
      [2, 'person_sm', 'app', 'budget agreed', ['budget']],
      [3, 'person_sm', 'app', 'picked by sponsor', ['status']],
    ]);
    expect(list[0]!.prevHash).toBe('0'.repeat(64));
    expect(list[2]!.values).toMatchObject({ status: 'activating', site_number: 'US-012', budget: 1000, study });
    expect(new Date(list[2]!.at).getTime()).toBeGreaterThanOrEqual(new Date(list[1]!.at).getTime());
    expect(await versions.verifyChain(db.pool, 'etmf.Site', site)).toEqual({ ok: true });
    const row = await store.get(db.pool, e['etmf.Site']!, site);
    expect(row).toMatchObject({ version: 3, updatedBy: 'person_sm', lifecycle: 'activating' });
  });

  test('a write that changes nothing makes no version; expectedVersion refuses a stale write', async () => {
    const same = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, site, { budget: 1000 }, { reason: 'again' }));
    expect(same).toEqual({ version: 3, changed: [] });
    expect(await versions.list(db.pool, 'etmf.Site', site)).toHaveLength(3);
    const err = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, site, { budget: 5 }, { reason: 'x', expectedVersion: 2 }))
      .catch((x) => x);
    expect(err).toBeInstanceOf(RecordWriteError);
    expect(err.code).toBe('stale');
    const missing = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, 'site_nope', { budget: 5 }, { reason: 'x' })).catch((x) => x);
    expect(missing.code).toBe('missing');
  });

  test('calculated and followed fields and unknown states are refused in plain words', async () => {
    const calc = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, site, { documents_filed: 3 })).catch((x) => x);
    expect(calc.message).toBe('"documents_filed" is calculated on Site and can\'t be written');
    const followed = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, site, { name: 'X' })).catch((x) => x);
    expect(followed.message).toBe('"name" comes from a linked domain and can\'t be changed on Site');
    const state = await withActor(db.pool, manager, (c) => store.transition(c, e['etmf.Site']!, site, { to: 'closed', transition: 'x' })).catch((x) => x);
    expect(state.code).toBe('unknown-state');
  });

  test('a step write is by step:<run> via the step run, with the generated reason', async () => {
    const docId = await withActor(db.pool, stepActor('case_1', 'run_case_1/1/file'), (c) =>
      store.create(c, e['etmf.Document']!, { title: 'CV', site }, { stepRunId: 'run_case_1/1/file' }));
    const [v] = await versions.list(db.pool, 'etmf.Document', docId);
    expect(v).toMatchObject({ by: 'step:run_case_1/1/file', via: 'run_case_1/1/file', reason: 'step run_case_1/1/file' });
    // A source write (a linked domain, a plugin) says who through `by`.
    await withTransaction(db.pool, async (c) => {
      await withRecordContext(c, { by: 'source:domain:edc', reason: 'paired', via: 'link_1' });
      await store.update(c, e['etmf.Document']!, docId, { tag: 'edc' });
    });
    expect((await versions.list(db.pool, 'etmf.Document', docId))[1]).toMatchObject({ by: 'source:domain:edc', via: 'link_1', reason: 'paired' });
  });

  test('regulated: a person edit of a controlled field needs a reason; tag (controlled: false) does not', async () => {
    const docId = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Document']!, { title: 'Protocol', site }, { reason: 'new' }));
    const err = await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Document']!, docId, { title: 'Protocol v2' })).catch((x) => x);
    expect(err).toBeInstanceOf(RecordWriteError);
    expect(err.code).toBe('reason-required');
    expect(err.message).toBe('a change to title on Document needs a reason');
    expect((await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Document']!, docId, { tag: 'misc' }))).changed).toEqual(['tag']);
    expect((await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Document']!, docId, { title: 'Protocol v2' }, { reason: 'typo' }))).changed)
      .toEqual(['title']);
    // Outside a regulated domain no reason is needed.
    const cust = await withActor(db.pool, manager, (c) => store.create(c, e.Customer!, { name: 'A' }));
    expect((await withActor(db.pool, manager, (c) => store.update(c, e.Customer!, cust, { name: 'B' }))).version).toBe(2);
  });

  test('history is append-only for the app role and for the owner; tampering breaks the chain', async () => {
    await expect(withActor(db.pool, manager, (c) => c.query(`update mw.record_versions set reason = 'x' where record_id = $1`, [site])))
      .rejects.toThrow(/permission denied/);
    await expect(withActor(db.pool, manager, (c) => c.query(`delete from mw.record_versions where record_id = $1`, [site])))
      .rejects.toThrow(/permission denied/);
    await expect(withActor(db.pool, manager, (c) => c.query(
      `insert into mw.record_versions (entity, record_id, version, at, by, "values", prev_hash, hash) values ('etmf.Site', $1, 9, now(), 'x', '{}', '', '')`, [site])))
      .rejects.toThrow(/permission denied/);
    await expect(withActor(db.pool, manager, (c) => c.query(`delete from domain.etmf__site where id = $1`, [site])))
      .rejects.toThrow(/permission denied/);
    // The owner (superuser here) is refused by the trigger.
    await expect(db.pool.query(`update mw.record_versions set reason = 'x' where record_id = $1`, [site])).rejects.toThrow(/append-only/);
    await expect(db.pool.query(`delete from mw.record_versions where record_id = $1`, [site])).rejects.toThrow(/append-only/);

    // A superuser who switches triggers off can change a row, and the chain shows it.
    await withTransaction(db.pool, async (c) => {
      await c.query(`set local session_replication_role = replica`);
      await c.query(`update mw.record_versions set "values" = jsonb_set("values", '{budget}', '999') where entity = 'etmf.Site' and record_id = $1 and version = 2`, [site]);
    });
    expect(await versions.verifyChain(db.pool, 'etmf.Site', site)).toEqual({
      ok: false, brokenAt: 2, message: 'version 2 was changed after it was written: its content no longer matches its hash',
    });
    // Rewriting a hash too is caught by the next link.
    await withTransaction(db.pool, async (c) => {
      await c.query(`set local session_replication_role = replica`);
      await c.query(`update mw.record_versions set hash = mw.record_hash(prev_hash, entity, record_id, version, at, by, reason, "values")
                     where entity = 'etmf.Site' and record_id = $1 and version = 2`, [site]);
    });
    expect((await versions.verifyChain(db.pool, 'etmf.Site', site)).brokenAt).toBe(3);
  });

  test('entity events: created, changed with fields, entered with state, from and transition', async () => {
    const from = await events.latestSeq(db.pool);
    const id = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Site']!, { site_number: 'US-020', study }, { reason: 'r' }));
    await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, id, { budget: 10, sponsor_approved: true }, { reason: 'r' }));
    await withActor(db.pool, manager, (c) => store.transition(c, e['etmf.Site']!, id, { to: 'activating', transition: 'picked', reason: 'r' }));
    const got = (await events.after(db.pool, from, 100, { entity: 'etmf.Site', recordId: id }))
      .map((x) => [x.kind, x.fields ?? null, x.state ?? null, x.from ?? null, x.transition ?? null, x.by]);
    expect(got).toEqual([
      ['created', null, null, null, null, 'person_sm'],
      ['entered', null, 'selected', null, null, 'person_sm'],
      ['changed', ['sponsor_approved', 'budget'], null, null, null, 'person_sm'],
      ['changed', ['status'], null, null, null, 'person_sm'],
      ['entered', null, 'activating', 'selected', 'picked', 'person_sm'],
    ]);
    // The study whose rollups count sites heard about the new site (sites_total), once per write that matters.
    const studyEvents = (await events.after(db.pool, from, 100, { entity: 'etmf.Study', recordId: study })).map((x) => x.fields);
    expect(studyEvents).toEqual([['sites_total', 'sites_ready']]);
    // A rolled-back write leaves no event.
    const before = await events.latestSeq(db.pool);
    await withActor(db.pool, manager, async (c) => {
      await store.update(c, e['etmf.Site']!, id, { budget: 11 }, { reason: 'r' });
      throw new Error('undo');
    }).catch(() => undefined);
    expect((await events.after(db.pool, before, 10)).filter((x) => x.recordId === id)).toEqual([]);
  });

  test('rollup events reach the parent and, through rollups of rollups, the grandparent', async () => {
    const s2 = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Site']!, { site_number: 'US-030', study }, { reason: 'r' }));
    const exp = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.ExpectedDocument']!, { artifact: 'CV', site: s2 }, { reason: 'r' }));
    let from = await events.latestSeq(db.pool);
    // Filing the expected document changes the site's percent, which the study's sites_ready reads.
    await withActor(db.pool, manager, (c) => store.transition(c, e['etmf.ExpectedDocument']!, exp, { to: 'filed', transition: 'to_filed', reason: 'r' }));
    let after = await events.after(db.pool, from, 100);
    expect(after.filter((x) => x.entity === 'etmf.Site').map((x) => [x.recordId, x.fields])).toEqual([[s2, ['start_up_pack_complete']]]);
    expect(after.filter((x) => x.entity === 'etmf.Study').map((x) => [x.recordId, x.fields])).toEqual([[study, ['sites_ready']]]);

    // A change no rollup reads (the artifact name) tells no parent.
    from = await events.latestSeq(db.pool);
    await withActor(db.pool, manager, (c) => store.update(c, e['etmf.ExpectedDocument']!, exp, { artifact: 'CV (PI)' }, { reason: 'r' }));
    after = await events.after(db.pool, from, 100);
    expect(after.map((x) => x.entity)).toEqual(['etmf.ExpectedDocument']);

    // Moving a document to another site tells both sites (old and new).
    const doc = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Document']!, { title: 'D', site, pages: 3 }, { reason: 'r' }));
    from = await events.latestSeq(db.pool);
    await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Document']!, doc, { site: s2 }, { reason: 'moved' }));
    after = await events.after(db.pool, from, 100);
    expect(after.filter((x) => x.entity === 'etmf.Site').map((x) => x.recordId)).toEqual([site, s2]);
    expect(after.find((x) => x.entity === 'etmf.Site')!.fields).toEqual(['documents_filed', 'pages_total', 'filed_twice']);
  });

  test('a change notifies mw_changes with kind entity and kind records', async () => {
    const listener = await db.pool.connect();
    const got: string[] = [];
    listener.on('notification', (n) => got.push(n.payload ?? ''));
    await listener.query('listen mw_changes');
    try {
      await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Site']!, site, { budget: 77 }, { reason: 'r' }));
      for (let i = 0; i < 50 && got.length < 2; i++) await Bun.sleep(20);
      expect(got).toContain('{"kind":"entity"}');
      expect(got.map((p) => JSON.parse(p))).toContainEqual({ kind: 'records', entity: 'etmf.Site', recordId: site, project: 'etmf' });
    } finally {
      await listener.query('unlisten mw_changes');
      listener.release();
    }
  });
});
