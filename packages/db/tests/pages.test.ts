import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createTestDatabase, PgChatAnchorStore, PgPageChangeStore, PgPageStore, postgresAvailable, withActor, type TestDatabase,
} from '../src/index.ts';
import { person } from './phase6-fixtures.ts';

// Projects and pages (26 §4): pages built from a question, kept with a schedule, nested, with
// versions that say how they were made, and answer changes waiting for review.
describe.skipIf(!postgresAvailable())('pages (0008)', () => {
  let db: TestDatabase;
  const leah = person('person_leah', ['lead']);
  const pages = new PgPageStore();
  const changes = new PgPageChangeStore();

  beforeAll(async () => {
    db = await createTestDatabase('mw_pages_store');
  }, 60_000);
  afterAll(() => db?.drop());

  test('a page from a question is a draft in its project; each version says how it was made', async () => {
    const glp1 = await withActor(db.pool, leah, (c) => pages.save(c, {
      domain: 'literature', title: 'GLP-1', body: 'Oral GLP-1s for weight.', sumsChildren: true,
    }, 'person_leah', { via: 'person:person_leah', reason: 'Made the topic' }));
    expect(glp1).toMatchObject({ project: 'literature', status: 'kept', sumsChildren: true, pinned: false, version: 1, createdBy: 'person_leah' });

    const draft = await withActor(db.pool, leah, (c) => pages.save(c, {
      domain: 'literature', project: 'literature', title: 'Side effects', body: '', status: 'draft', parent: glp1.id,
      question: 'How often do people stop oral GLP-1s because of side effects?', chatId: 'chat_1',
    }, 'person_leah', { via: 'chat:chat_1', reason: 'Asked on the home' }));
    expect(draft).toMatchObject({ status: 'draft', parent: glp1.id, question: expect.stringContaining('side effects'), chatId: 'chat_1' });

    const v2 = await withActor(db.pool, leah, (c) => pages.write(c, draft.id, { body: 'With orforglipron, 5 to 10% stopped.' }, 'person_leah',
      { via: 'chat:chat_1', reason: 'Answered the question', expectedVersion: 1 }));
    expect(v2.version).toBe(2);
    expect(v2.parent).toBe(glp1.id);
    await expect(pages.write(db.pool, draft.id, { body: 'x' }, 'person_leah', { expectedVersion: 1 })).rejects.toThrow(/changed since/);
    expect((await pages.versions(db.pool, draft.id)).map((v) => [v.version, v.via, v.reason])).toEqual([
      [1, 'chat:chat_1', 'Asked on the home'], [2, 'chat:chat_1', 'Answered the question'],
    ]);
    // History is append-only, for the app role too.
    await expect(db.pool.query(`update mw.page_versions set body = 'x' where page_id = $1`, [draft.id])).rejects.toThrow(/append-only/);

    expect((await pages.children(db.pool, glp1.id)).map((p) => p.title)).toEqual(['Side effects']);
    expect((await pages.listProject(db.pool, 'literature')).map((p) => p.title)).toEqual(['GLP-1', 'Side effects']);

    // Keep: kept, with a schedule and an owner; archived pages leave the list.
    const kept = await withActor(db.pool, leah, (c) => pages.set(c, draft.id, {
      status: 'kept', owner: 'person_leah', refresh: { every: 'mon', next: '2026-06-08T06:00:00.000Z' },
    }));
    expect(kept).toMatchObject({ status: 'kept', owner: 'person_leah', refresh: { every: 'mon' } });
    expect((await pages.due(db.pool, new Date('2026-06-08T07:00:00Z'))).map((p) => p.id)).toEqual([draft.id]);
    expect(await pages.due(db.pool, new Date('2026-06-07T07:00:00Z'))).toEqual([]);
    await pages.set(db.pool, draft.id, { refresh: { every: 'mon', next: '2026-06-08T06:00:00.000Z', until: '2026-06-01' } });
    expect(await pages.due(db.pool, new Date('2026-06-08T07:00:00Z'))).toEqual([]);
    await pages.set(db.pool, draft.id, { status: 'archived' });
    expect((await pages.listProject(db.pool, 'literature')).map((p) => p.title)).toEqual(['GLP-1']);
    expect((await pages.listProject(db.pool, 'literature', { archived: true })).map((p) => p.title)).toEqual(['GLP-1', 'Side effects']);
  });

  test('an answer change waits, one per page, until accepted or sent back', async () => {
    const page = await pages.save(db.pool, { domain: 'literature', title: 'Weight loss', body: 'Before.' }, 'person_leah');
    const first = await changes.propose(db.pool, { pageId: page.id, fromVersion: 1, title: 'Weight loss', body: 'After.', summary: { label: '1 new trial' }, runId: 'run_1' });
    expect(first).toMatchObject({ status: 'pending', fromVersion: 1, summary: { label: '1 new trial' } });
    expect((await changes.pending(db.pool, page.id))!.id).toBe(first.id);

    // A newer refresh replaces one nobody reviewed.
    const second = await changes.propose(db.pool, { pageId: page.id, fromVersion: 1, title: 'Weight loss', body: 'After, again.', summary: {}, runId: 'run_2' });
    expect((await changes.get(db.pool, first.id))!.status).toBe('sent_back');
    expect((await changes.pending(db.pool, page.id))!.id).toBe(second.id);
    expect((await changes.forRun(db.pool, 'run_2'))!.id).toBe(second.id);

    await changes.setStepRun(db.pool, second.id, 'run_2/4/review');
    expect((await changes.forStepRuns(db.pool, ['run_2/4/review'])).map((c) => c.id)).toEqual([second.id]);
    expect(await changes.revise(db.pool, second.id, { body: 'After, with a note.' })).toMatchObject({ body: 'After, with a note.' });

    const applied = await pages.write(db.pool, page.id, { body: 'After, with a note.' }, 'person_leah', { via: 'run:run_2', reason: 'Accepted the answer change' });
    expect(await withActor(db.pool, leah, (c) => changes.decide(c, second.id, { status: 'accepted', by: 'person_leah', toVersion: applied.version }))).toBe(true);
    expect(await changes.decide(db.pool, second.id, { status: 'sent_back', by: 'person_leah' })).toBe(false);
    expect(await changes.get(db.pool, second.id)).toMatchObject({ status: 'accepted', toVersion: 2, reviewedBy: 'person_leah' });
    expect(await changes.pending(db.pool, page.id)).toBeUndefined();
    expect((await changes.forPage(db.pool, page.id)).map((c) => c.status)).toEqual(['accepted', 'sent_back']);
  });

  test('a chat can be anchored to a page or to a page change', async () => {
    const anchors = new PgChatAnchorStore();
    await anchors.set(db.pool, { chatId: 'chat_p', anchorKind: 'page', anchorId: 'page_1', personId: 'person_leah' });
    await anchors.set(db.pool, { chatId: 'chat_c', anchorKind: 'page_change', anchorId: 'pch_1', personId: 'person_leah' });
    expect((await anchors.forAnchor(db.pool, 'page', 'page_1')).map((a) => a.chatId)).toEqual(['chat_p']);
    expect((await anchors.get(db.pool, 'chat_c'))!.anchorKind).toBe('page_change');
  });
});
