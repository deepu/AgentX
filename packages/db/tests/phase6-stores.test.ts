import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  canonicalJson, contentHash, createTestDatabase, mentionTokens, PgFlagStore, PgMentionStore, PgNoteStore, PgPageStore,
  PgPeopleStore, PgSignatureStore, PgViewStore, postgresAvailable, withActor, type TestDatabase,
} from '../src/index.ts';
import { person } from './phase6-fixtures.ts';

test('contentHash is the sha256 of canonical JSON: key order never matters', () => {
  expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  const a = contentHash({ entity: 'etmf.Document', recordId: 'docu_1', fileSha256: 'ab', values: { title: 'CV', about: 'Dr. Vogel' } });
  const b = contentHash({ entity: 'etmf.Document', recordId: 'docu_1', fileSha256: 'ab', values: { about: 'Dr. Vogel', title: 'CV' } });
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(contentHash({ entity: 'etmf.Document', recordId: 'docu_1', fileSha256: 'ab', values: { title: 'CV2', about: 'Dr. Vogel' } })).not.toBe(a);
  expect(mentionTokens('see [[etmf.Site:site_01ABC]] and [[Customer:cust_9]] and [[etmf.Site:site_01ABC]]'))
    .toEqual([{ entity: 'etmf.Site', id: 'site_01ABC' }, { entity: 'Customer', id: 'cust_9' }]);
});

describe.skipIf(!postgresAvailable())('Phase 6 stores', () => {
  let db: TestDatabase;
  const tess = person('person_tess', ['tmf_specialist']);

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_stores');
  }, 60_000);
  afterAll(() => db?.drop());

  test('signatures: added with server time, found by record, case and step run; never changed', async () => {
    const sigs = new PgSignatureStore();
    const id = await withActor(db.pool, tess, (c) => sigs.add(c, {
      stepRunId: 'run_1/3/qc', caseId: 'case_1', personId: 'person_tess', name: 'Tess Lin', meaning: 'Reviewed and approved for filing',
      entity: 'etmf.Document', recordId: 'docu_1', contentHash: 'h1', manifest: { values: { title: 'CV' } },
    }));
    expect(id).toMatch(/^sig_/);
    const [s] = await sigs.forRecord(db.pool, 'etmf.Document', 'docu_1');
    expect(s).toMatchObject({ id, personId: 'person_tess', name: 'Tess Lin', meaning: 'Reviewed and approved for filing', contentHash: 'h1', caseId: 'case_1' });
    expect((await sigs.forCase(db.pool, 'case_1')).map((x) => x.id)).toEqual([id]);
    expect((await sigs.forStepRun(db.pool, 'run_1/3/qc')).map((x) => x.id)).toEqual([id]);
    await expect(db.pool.query(`update mw.signatures set record_id = 'docu_2' where id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(withActor(db.pool, tess, (c) => c.query(`delete from mw.signatures where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  test('auth events and lock state: failures in the last 15 minutes since the last good signature', async () => {
    const people = new PgPeopleStore(db.pool);
    const p = await people.create({ name: 'Sig Ner', email: 'signer@example.com', password: 'correct horse battery' });
    for (let i = 0; i < 3; i++) await people.recordAuthEvent(p.id, 'signature-failed', { stepRunId: 'run_1/3/qc' });
    expect(await people.lockState(p.id)).toEqual({ recentFailures: 3 });
    await people.recordAuthEvent(p.id, 'signature-ok');
    await people.recordAuthEvent(p.id, 'signature-failed');
    expect((await people.lockState(p.id)).recentFailures).toBe(1);
    // An old failure doesn't count.
    await db.pool.query(`update mw.auth_events set at = now() - interval '20 minutes' where person_id = $1 and kind = 'signature-failed'`, [p.id]);
    expect((await people.lockState(p.id)).recentFailures).toBe(0);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    await people.recordAuthEvent(p.id, 'locked', { until });
    expect(await people.lockState(p.id)).toEqual({ lockedUntil: until, recentFailures: 0 });
    expect((await people.get(p.id))!.lockedUntil).toBe(until);
    await people.setLockedUntil(p.id, null);
    expect((await people.lockState(p.id)).lockedUntil).toBeUndefined();
    expect((await people.authEvents(p.id)).map((x) => x.kind)).toEqual(['locked', 'signature-ok', 'signature-failed', 'signature-failed', 'signature-failed', 'signature-failed']);
  });

  test('notes: one per record, every save a version; saving the same text adds none', async () => {
    const notes = new PgNoteStore();
    expect(await notes.get(db.pool, 'etmf.Site', 'site_1')).toBeUndefined();
    expect(await withActor(db.pool, tess, (c) => notes.save(c, 'etmf.Site', 'site_1', 'PI changed in May', 'person_tess'))).toBe(1);
    expect(await withActor(db.pool, tess, (c) => notes.save(c, 'etmf.Site', 'site_1', 'PI changed in May', 'person_tess'))).toBe(1);
    expect(await withActor(db.pool, tess, (c) => notes.save(c, 'etmf.Site', 'site_1', 'PI changed in June', 'person_tess', { reason: 'date', expectedVersion: 1 }))).toBe(2);
    await expect(notes.save(db.pool, 'etmf.Site', 'site_1', 'x', 'person_tess', { expectedVersion: 1 })).rejects.toThrow(/changed since/);
    expect(await notes.get(db.pool, 'etmf.Site', 'site_1')).toMatchObject({ body: 'PI changed in June', version: 2, by: 'person_tess', reason: 'date' });
    expect((await notes.history(db.pool, 'etmf.Site', 'site_1')).map((n) => n.body)).toEqual(['PI changed in May', 'PI changed in June']);
    await expect(db.pool.query(`delete from mw.record_notes`)).rejects.toThrow(/append-only/);
  });

  test('mentions: idempotent per source and target, replaced when the source is edited', async () => {
    const m = new PgMentionStore();
    const a = await m.add(db.pool, { targetEntity: 'etmf.Site', targetId: 'site_1', sourceKind: 'note', sourceId: 'etmf.Study:stud_1', label: 'Note on ONC-1' });
    const b = await m.add(db.pool, { targetEntity: 'etmf.Site', targetId: 'site_1', sourceKind: 'note', sourceId: 'etmf.Study:stud_1' });
    expect(b).toBe(a);
    await m.add(db.pool, { targetEntity: 'etmf.Site', targetId: 'site_1', sourceKind: 'chat', sourceId: 'chat_9', caseId: 'case_1' });
    expect((await m.forTarget(db.pool, 'etmf.Site', 'site_1')).map((x) => [x.sourceKind, x.label ?? null])).toEqual([['chat', null], ['note', 'Note on ONC-1']]);
    await withActor(db.pool, tess, (c) => m.replaceForSource(c, 'note', 'etmf.Study:stud_1', [{ entity: 'etmf.Site', id: 'site_2' }]));
    expect((await m.forTarget(db.pool, 'etmf.Site', 'site_1')).map((x) => x.sourceKind)).toEqual(['chat']);
    expect((await m.forTarget(db.pool, 'etmf.Site', 'site_2')).map((x) => x.sourceId)).toEqual(['etmf.Study:stud_1']);
  });

  test('flags: one open flag per record and invariant; raise is idempotent; close; list by domain', async () => {
    const flags = new PgFlagStore();
    const inv = "status = 'open' implies activated_on is set";
    const first = await flags.raise(db.pool, { entity: 'etmf.Site', recordId: 'site_1', invariant: inv, message: 'Open without an activation date' });
    expect(first.raised).toBe(true);
    const again = await flags.raise(db.pool, { entity: 'etmf.Site', recordId: 'site_1', invariant: inv, message: 'Still open without a date' });
    expect(again).toEqual({ id: first.id, raised: false });
    await flags.raise(db.pool, { entity: 'Customer', recordId: 'cust_1', invariant: 'name is set', message: 'No name' });
    expect((await flags.list(db.pool, { domain: 'etmf' })).map((x) => [x.id, x.message, x.domain])).toEqual([[first.id, 'Still open without a date', 'etmf']]);
    expect((await flags.list(db.pool, { domain: 'domain' })).map((x) => x.entity)).toEqual(['Customer']);
    expect(await flags.close(db.pool, 'etmf.Site', 'site_1', inv)).toBe(true);
    expect(await flags.close(db.pool, 'etmf.Site', 'site_1', inv)).toBe(false);
    expect(await flags.list(db.pool, { entity: 'etmf.Site' })).toEqual([]);
    expect((await flags.list(db.pool, { entity: 'etmf.Site', open: false }))[0]!.closedAt).toBeDefined();
    const reopened = await flags.raise(db.pool, { entity: 'etmf.Site', recordId: 'site_1', invariant: inv, message: 'Again' });
    expect(reopened.raised).toBe(true);
    expect(reopened.id).not.toBe(first.id);
  });

  test('personal views and written pages with versions', async () => {
    const views = new PgViewStore();
    const saved = await withActor(db.pool, tess, (c) => views.save(c, 'person_tess', 'etmf', {
      id: '', title: 'My late documents', entity: 'Document', filter: "status = 'draft'", layout: 'table',
    }));
    expect(saved.id).toMatch(/^view_/);
    await withActor(db.pool, tess, (c) => views.save(c, 'person_tess', 'etmf', { ...saved, title: 'Late documents' }));
    expect((await views.listPersonal(db.pool, 'person_tess', 'etmf')).map((v) => v.title)).toEqual(['Late documents']);
    // Someone else saving with the same id makes their own view.
    const theirs = await views.save(db.pool, 'person_bob', 'etmf', { ...saved, title: 'Bob\'s' });
    expect(theirs.id).not.toBe(saved.id);
    expect(await withActor(db.pool, tess, (c) => views.remove(c, 'person_tess', saved.id))).toBe(true);

    const pages = new PgPageStore();
    const p1 = await withActor(db.pool, tess, (c) => pages.save(c, { domain: 'etmf', title: 'How we file CVs', body: '# CVs', under: { entity: 'Study' } }, 'person_tess'));
    expect(p1).toMatchObject({ domain: 'etmf', title: 'How we file CVs', version: 1, updatedBy: 'person_tess', under: { entity: 'Study' } });
    const p2 = await withActor(db.pool, tess, (c) => pages.save(c, { id: p1.id, domain: 'etmf', title: 'How we file CVs', body: '# CVs\nWith the PI.' }, 'person_tess', { expectedVersion: 1 }));
    expect(p2.version).toBe(2);
    await expect(pages.save(db.pool, { id: p1.id, domain: 'etmf', title: 'x', body: '' }, 'person_bob', { expectedVersion: 1 })).rejects.toThrow(/changed since/);
    expect((await pages.list(db.pool, 'etmf')).map((p) => p.id)).toEqual([p1.id]);
    expect((await pages.versions(db.pool, p1.id)).map((v) => v.body)).toEqual(['# CVs', '# CVs\nWith the PI.']);
  });
});
