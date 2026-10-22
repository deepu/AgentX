import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityTypeDef } from '@memwise/defs';
import {
  applyDomainSchema, auditEntryHash, checkAuditChain, createTestDatabase, PgAuditLog, PgChangeRequestStore, PgEntityStore,
  PgInspectorStore, PgSignatureStore, postgresAvailable, withActor, withTransaction, type TestDatabase,
} from '../src/index.ts';
import { fixtureDomains, fixtureEntities, person, stepActor } from './phase6-fixtures.ts';

describe.skipIf(!postgresAvailable())('regulated projects: change requests, the audit log, inspectors (26 §8)', () => {
  let db: TestDatabase;
  let e: Record<string, EntityTypeDef>;
  const store = new PgEntityStore();
  const log = new PgAuditLog();
  const crs = new PgChangeRequestStore();
  const manager = person('person_sm', ['study_manager']);

  beforeAll(async () => {
    db = await createTestDatabase('mw_regulated');
    e = fixtureEntities();
    await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    await db.pool.query(`insert into mw.people (id, name, email) values ('person_sm', 'Anika Rao', 'anika@example.com')`);
  }, 60_000);
  afterAll(() => db?.drop());

  test('record versions and signatures land in their project\'s trail, chained', async () => {
    const study = await withActor(db.pool, manager, (c) => store.create(c, e['etmf.Study']!, { title: 'MW-301' }, { reason: 'set up' }));
    await withActor(db.pool, manager, (c) => store.update(c, e['etmf.Study']!, study, { title: 'MW-301 (Aster-1)' }, { reason: 'full title' }));
    await withActor(db.pool, manager, (c) => new PgSignatureStore().add(c, {
      personId: 'person_sm', name: 'Anika Rao', meaning: 'Approved', entity: 'etmf.Study', recordId: study, contentHash: 'h'.repeat(64),
    }));
    const entries = await log.list(db.pool, { project: 'etmf', entity: 'etmf.Study', recordId: study });
    expect(entries.map((x) => [x.action, x.actorKind, x.actor, x.actorLabel])).toEqual([
      ['record.created', 'person', 'person_sm', 'Anika Rao'],
      ['record.changed', 'person', 'person_sm', 'Anika Rao'],
      ['signature.signed', 'person', 'person_sm', 'Anika Rao'],
    ]);
    expect(entries[1]!.data).toMatchObject({ version: 2, changed: ['title'], reason: 'full title' });
    expect(entries[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    // Every hash recomputes outside the database, and the whole chain verifies inside it.
    for (const x of entries) expect(auditEntryHash(x)).toBe(x.hash);
    expect(checkAuditChain(await log.list(db.pool, { project: 'etmf' }), { complete: true })).toMatchObject({ ok: true });
    expect(await log.verify(db.pool, 'etmf')).toMatchObject({ ok: true });
  });

  test('a step\'s write is the step\'s; the kernel appends entries of its own; numbers and text hash alike everywhere', async () => {
    const doc = await withActor(db.pool, stepActor('case_1', 'run_1/1/classify'), (c) =>
      store.create(c, e['etmf.Document']!, { title: 'CV' }, { stepRunId: 'run_1/1/classify' }));
    const [created] = await log.list(db.pool, { project: 'etmf', entity: 'etmf.Document', recordId: doc });
    expect(created).toMatchObject({ actorKind: 'system', actor: 'run_1/1/classify', action: 'record.created' });
    const id = await withTransaction(db.pool, (c) => log.append(c, {
      project: 'etmf', actorKind: 'inspector', actor: 'insp_1', actorLabel: 'Inspector, MHRA', action: 'inspector.viewed', entity: 'etmf.Document', recordId: doc,
      data: { score: 0.92, whole: 3, big: 1.5e300, text: 'Ünïcödé "quoted"\n\ttab ✓', nested: { b: [1, 2.50, { z: null, a: true }] } },
    }));
    const entry = (await log.get(db.pool, id))!;
    // Decimals are kept as text, so the export's verifier hashes what Postgres hashed.
    expect(entry.data).toEqual({ score: '0.92', whole: 3, big: expect.stringMatching(/^15000/), text: 'Ünïcödé "quoted"\n\ttab ✓', nested: { b: [1, '2.5', { z: null, a: true }] } });
    expect(auditEntryHash(entry)).toBe(entry.hash);
    expect(await log.verify(db.pool, 'etmf')).toMatchObject({ ok: true });
  });

  test('the log is append-only; a change made behind its back breaks the chain', async () => {
    const [first] = await log.list(db.pool, { project: 'etmf', limit: 1 });
    await expect(db.pool.query(`update mw.audit_log set actor_label = 'x' where id = $1`, [first!.id])).rejects.toThrow(/append-only/);
    await expect(db.pool.query(`delete from mw.audit_log where id = $1`, [first!.id])).rejects.toThrow(/append-only/);
    await expect(withActor(db.pool, manager, (c) => c.query(`insert into mw.audit_log (id, project, at, actor_kind, actor, action, prev_hash, hash)
      values ('aud_x', 'etmf', now(), 'person', 'p', 'x', 'x', 'x')`))).rejects.toThrow(/permission denied/);
    // A superuser who turns the guard off can change an entry, and the chain shows it.
    const exported = await log.list(db.pool, { project: 'etmf' });
    await withTransaction(db.pool, async (c) => {
      await c.query(`alter table mw.audit_log disable trigger audit_log_append_only`);
      await c.query(`update mw.audit_log set data = data || '{"reason":"edited"}' where id = $1`, [exported[1]!.id]);
      await c.query(`alter table mw.audit_log enable trigger audit_log_append_only`);
    });
    expect(await log.verify(db.pool, 'etmf')).toMatchObject({ ok: false, brokenAt: { seq: exported[1]!.seq, reason: 'hash' } });
    const tampered = await log.list(db.pool, { project: 'etmf' });
    expect(checkAuditChain(tampered, { complete: true })).toMatchObject({ ok: false, brokenAt: { id: exported[1]!.id, reason: 'hash' } });
    // Dropping an entry from an export breaks the link of the one after it.
    const dropped = exported.filter((_, i) => i !== 2).map((x, i) => (i >= 2 ? { ...x, seq: x.seq - 1 } : x));
    expect(checkAuditChain(dropped, { complete: true })).toMatchObject({ ok: false, brokenAt: { reason: 'link' } });
  });

  test('change requests number per project and keep their validations', async () => {
    await crs.setNextNumber(db.pool, 'etmf', 14);
    const cr = await crs.create(db.pool, { project: 'etmf', workflowId: 'file-document', draftId: 'd_1', title: 'Skip QC for CVs', raisedBy: 'person_sm', fromVersion: 2 });
    expect(cr).toMatchObject({ number: 14, status: 'open', reason: '', fromVersion: 2 });
    expect((await crs.create(db.pool, { project: 'etmf', workflowId: 'file-document', draftId: 'd_2', title: 'b', raisedBy: 'person_sm' })).number).toBe(15);
    expect((await crs.create(db.pool, { project: 'edc', workflowId: 'x', draftId: 'd_3', title: 'c', raisedBy: 'person_sm' })).number).toBe(1);
    expect((await crs.find(db.pool, 'CR-014', 'etmf'))?.id).toBe(cr.id);
    expect((await crs.byDraft(db.pool, 'd_1'))?.id).toBe(cr.id);
    await crs.addValidation(db.pool, { crId: cr.id, draftHash: 'h1', setLabel: '42 CVs', total: 42, passed: 41, checkErrors: 0, status: 'failed', results: [] });
    await crs.addValidation(db.pool, { crId: cr.id, draftHash: 'h2', setLabel: '42 CVs', total: 42, passed: 42, checkErrors: 0, status: 'passed', results: [] });
    expect((await crs.validations(db.pool, cr.id)).map((v) => `${v.passed}/${v.total}`)).toEqual(['41/42', '42/42']);
    const updated = await crs.update(db.pool, cr.id, { status: 'in_review', reason: 'QC repeats the AI check' });
    expect(updated).toMatchObject({ status: 'in_review', reason: 'QC repeats the AI check', title: 'Skip QC for CVs' });
    expect((await crs.list(db.pool, { project: 'etmf', status: ['in_review'] })).map((c) => c.number)).toEqual([14]);
  });

  test('inspector links are found by token hash only; questions wait for an answer', async () => {
    const insp = new PgInspectorStore();
    const link = await insp.create(db.pool, {
      project: 'etmf', name: 'MHRA inspection', inspectors: [{ name: 'Inspector, MHRA', organisation: 'MHRA' }],
      expiresAt: '2026-11-18T18:00:00.000Z', createdBy: 'person_sm', tokenHash: 'th_1',
    });
    expect((await insp.byTokenHash(db.pool, 'th_1'))?.id).toBe(link.id);
    await expect(withActor(db.pool, manager, (c) => c.query(`select token_hash from mw.inspector_links`))).rejects.toThrow(/permission denied/);
    expect((await withActor(db.pool, manager, (c) => c.query(`select name from mw.inspector_links`))).rows).toEqual([{ name: 'MHRA inspection' }]);
    await insp.touch(db.pool, link.id);
    const q = await insp.ask(db.pool, { linkId: link.id, project: 'etmf', question: 'Why was the site 109 ethics letter filed late?', askedBy: 'Inspector, MHRA' });
    expect((await insp.questions(db.pool, { project: 'etmf', open: true })).map((x) => x.id)).toEqual([q.id]);
    expect(await insp.answer(db.pool, q.id, 'The site sent it late.', 'person_sm')).toMatchObject({ answer: 'The site sent it late.' });
    expect(await insp.answer(db.pool, q.id, 'again', 'person_sm')).toBeUndefined();
    expect(await insp.questions(db.pool, { project: 'etmf', open: true })).toEqual([]);
    expect((await insp.revoke(db.pool, link.id, 'person_sm'))?.revokedAt).toBeDefined();
    expect((await insp.get(db.pool, link.id))?.firstOpenedAt).toBeDefined();
  });
});
