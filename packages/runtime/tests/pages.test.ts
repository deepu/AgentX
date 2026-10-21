// Pages in the kernel (docs/memwise/26-projects-and-pages.md §4), against a real Postgres: a
// draft changed from a chat with Undo, keeping it on a schedule the minute sweep honours, the
// built-in "Refresh a page" with a scripted writer (an answer change waits for review in the
// owner's waiting list, then is accepted or sent back; a refresh with nothing new leaves one
// history line), live blocks, and a parent that sums up its kept sub-pages only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import type { ProjectDefs, ScriptedTurn } from '@memwise/defs';
import { scriptedProvider, type ModelProvider } from '@memwise/gateway';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { createPagesService } from '../src/pages/service.ts';
import { sampleTools } from '../src/sample-tools.ts';
import type { InboxItem, Kernel, KernelChange, PersonActor } from '../src/types.ts';
import { INTAKE_DIR } from './fixtures/exit-setup.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const PROJECT = mkdtempSync(join(tmpdir(), 'mw-pages-project-'));
cpSync(INTAKE_DIR, PROJECT, { recursive: true });
const P = 'domain';

const BODY = `GLP-1 drugs cut weight by 15% on average across 9 trials.

## Trials

STEP-1 and SURMOUNT-1 lead the evidence.
`;
const NEW_TRIAL = `GLP-1 drugs cut weight by 15% on average across 10 trials, and most people keep it off for a year.

## Trials

STEP-1 and SURMOUNT-1 lead the evidence.

## ATTAIN-MAINTAIN

Most people kept the weight off at 52 weeks.
`;

// What the writer does next: read the page, then finish with these writes.
let writer: { page: string; writes: Record<string, unknown> } = { page: '', writes: {} };
const writerProvider: ModelProvider = {
  id: 'scripted',
  complete(model, request, opts) {
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ name: 'page.get', args: { page: writer.page } }] },
      { toolCalls: [{ name: 'step.finish', args: { outcome: 'written', writes: writer.writes, rationale: 'Rewritten from what is new.' } }] },
    ];
    return scriptedProvider({ writer: turns }).complete(model, request, opts);
  },
};

let db: TestDatabase;
let kernel: Kernel;
let owner: PersonActor;
let other: PersonActor;
const changes: KernelChange[] = [];

const finished = (runId: string) => kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 });

async function waitingReview(runId: string) {
  const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active' || r.state === 'review', timeoutMs: 60_000 });
  expect(run).toMatchObject({ state: 'review', status: 'active' });
  for (let i = 0; i < 100; i++) {
    const s = await kernel.getStepRecord(`${runId}/${run.enteredSeq}/review`);
    if (s?.status === 'waiting') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('review never waited');
}

const pageItems = (items: InboxItem[]) => items.filter((i) => (i.kind === 'decision' || i.kind === 'input') && i.pageChange);

describe.skipIf(!pgAvailable)('pages in the kernel', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_pages');
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: PROJECT, filesDir: mkdtempSync(join(tmpdir(), 'mw-pages-files-')),
      tools: sampleTools({ databaseUrl: db.url }),
      modelRoles: { writer: { provider: 'scripted', model: 's' } }, providers: [writerProvider], logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    const add = async (name: string, roles: string[]) => kernel.people.actorFor((await kernel.people.create({ name, email: `${name}@acme.example`, roles })).id);
    owner = await add('maya', ['manager']);
    other = await add('sam', ['staff']);
    kernel.onChange((c) => changes.push(c));
  }, 120_000);
  afterAll(async () => { await kernel?.shutdown(); await db?.drop(); }, 60_000);

  let pageId = '';

  test('a draft from a question, changed from a chat with Undo', async () => {
    const made = await kernel.pages.create({ project: P, title: 'Weight loss', question: 'How much weight do people lose on GLP-1s?', body: BODY, chatId: 'chat_1', via: 'chat:chat_1' }, owner);
    expect(made).toMatchObject({ applied: true, page: { status: 'draft', version: 1, headline: 'GLP-1 drugs cut weight by 15% on average across 9 trials.' } });
    pageId = made.page!.id;
    expect(changes.some((c) => c.kind === 'pages' && c.pageId === pageId)).toBe(true);

    const edited = await kernel.pages.update(pageId, { body: BODY.replace('lead the evidence', 'are the largest'), via: 'chat:chat_1', reason: 'Plainer words' }, owner);
    expect(edited.page).toMatchObject({ version: 2, canUndo: true, changedFromChat: { version: 2, chatId: 'chat_1', sections: ['Trials'] } });
    expect(edited.page!.history.map((h) => h.kind)).toEqual(['chat', 'asked']);

    // A write against an older version is refused, not lost.
    expect(await kernel.pages.update(pageId, { body: 'x', expectedVersion: 1 }, owner)).toMatchObject({ applied: false, status: 'stale' });

    const undone = await kernel.pages.undo(pageId, owner, { version: 2 });
    expect(undone.page).toMatchObject({ version: 3, written: BODY });
    expect(undone.page!.history[0]).toMatchObject({ kind: 'undo', version: 3, byName: 'maya' });
    expect((await kernel.pages.versions(pageId, owner)).map((v) => v.via)).toEqual(['chat:chat_1', 'chat:chat_1', `person:${owner.personId}`]);
    expect((await kernel.pages.list(P, owner)).map((p) => p.id)).toContain(pageId);
  });

  test('keep: a schedule the minute sweep starts once per slot', async () => {
    expect(await kernel.pages.keep(pageId, { every: 'fortnightly' }, owner)).toMatchObject({ applied: false, status: 'invalid' });
    const kept = await kernel.pages.keep(pageId, { every: 'mon' }, owner);
    expect(kept.page).toMatchObject({ status: 'kept', owner: owner.personId, refresh: { every: 'mon', playbook: 'refresh-page' } });
    const next = new Date(kept.page!.refresh!.next!);
    expect([next.getDay(), next.getHours()]).toEqual([1, 6]);
    expect(await kernel.pages.sweep(new Date(next.getTime() - 60_000))).toEqual([]);

    // The writer finds nothing new: one "nothing new" line, nobody asked to review.
    writer = { page: pageId, writes: { body: BODY } };
    const swept = await kernel.pages.sweep(new Date(next.getTime() + 60_000));
    expect(swept).toHaveLength(1);
    const run = await finished(swept[0]!.runId);
    expect(run).toMatchObject({ state: 'end', status: 'done' });
    // Its next slot moved on: the same minute sweeps nothing again.
    expect(await kernel.pages.sweep(new Date(next.getTime() + 60_000))).toEqual([]);
    const page = (await kernel.pages.get(pageId, owner))!;
    expect(page.version).toBe(3);
    expect(page.history[0]).toMatchObject({ kind: 'nothing_new' });
    expect(page.lastRefresh).toMatchObject({ status: 'nothing_new' });
    expect(new Date(page.refresh!.next!).getTime()).toBeGreaterThan(next.getTime());
  }, 90_000);

  let changeId = '';
  test('an answer change waits in the owner\'s waiting list, then is accepted', async () => {
    writer = { page: pageId, writes: { body: NEW_TRIAL, label: '1 new trial', change_title: 'ATTAIN-MAINTAIN added', plus: 'Most people keep the weight off for a year.', left_out: [{ title: 'A conference abstract', why: 'No full results yet' }] } };
    const started = await kernel.pages.refreshNow(pageId, owner);
    expect(started.started).toBe(true);
    // One refresh at a time.
    expect(await kernel.pages.refreshNow(pageId, owner)).toMatchObject({ started: false, runId: started.runId });
    await waitingReview(started.runId!);

    const mine = pageItems(await kernel.inbox(owner));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ pageChange: { pageId, pageTitle: 'Weight loss', label: '1 new trial', from: { kind: 'manual', by: owner.personId } } });
    changeId = (mine[0] as { pageChange: { changeId: string } }).pageChange.changeId;
    // Someone else in the project doesn't review the owner's page.
    expect(pageItems(await kernel.inbox(other))).toEqual([]);

    const view = (await kernel.pages.getChange(changeId, owner))!;
    expect(view).toMatchObject({ status: 'pending', mayDecide: true, pageTitle: 'Weight loss', fromVersion: 3, before: BODY, after: NEW_TRIAL });
    expect(view.summary).toMatchObject({ label: '1 new trial', title: 'ATTAIN-MAINTAIN added', leftOut: [{ title: 'A conference abstract' }] });
    expect(view.summary.sections?.map((s) => [s.heading, s.changed, s.origin])).toEqual([['ATTAIN-MAINTAIN', 'added', 'refresh']]);
    expect(view.summary.numbers?.added).toContain('10');
    expect((await kernel.pages.getChange(changeId, other))!.mayDecide).toBe(false);
    expect(await kernel.pages.decideChange(changeId, { decision: 'accept' }, other)).toMatchObject({ applied: false, status: 'forbidden' });
    // The page itself is unchanged until someone accepts.
    expect((await kernel.pages.get(pageId, owner))!).toMatchObject({ version: 3, pendingChange: { id: changeId, label: '1 new trial' } });

    expect(await kernel.pages.decideChange(changeId, { decision: 'accept', comment: 'Good catch' }, owner)).toMatchObject({ applied: true });
    const run = await finished(started.runId!);
    expect(run).toMatchObject({ state: 'end', status: 'done' });
    const page = (await kernel.pages.get(pageId, owner))!;
    expect(page).toMatchObject({ version: 4, written: NEW_TRIAL });
    expect(page.pendingChange).toBeUndefined();
    expect(page.history[0]).toMatchObject({ kind: 'accepted', version: 4, text: 'ATTAIN-MAINTAIN added', byName: 'maya' });
    expect((await kernel.pages.getChange(changeId, owner))!).toMatchObject({ status: 'accepted', toVersion: 4, comment: 'Good catch' });
    expect(pageItems(await kernel.inbox(owner))).toEqual([]);
  }, 90_000);

  test('sent back: the page keeps its body', async () => {
    writer = { page: pageId, writes: { body: NEW_TRIAL.replace('10 trials', '11 trials'), label: '1 new trial' } };
    const started = await kernel.pages.refreshNow(pageId, owner);
    await waitingReview(started.runId!);
    const change = pageItems(await kernel.inbox(owner))[0] as { pageChange: { changeId: string } };
    expect(await kernel.pages.decideChange(change.pageChange.changeId, { decision: 'send_back', comment: 'That one is an abstract' }, owner)).toMatchObject({ applied: true });
    expect(await finished(started.runId!)).toMatchObject({ state: 'end', status: 'done' });
    const page = (await kernel.pages.get(pageId, owner))!;
    expect(page).toMatchObject({ version: 4, written: NEW_TRIAL });
    expect(page.history[0]).toMatchObject({ kind: 'sent_back', text: 'That one is an abstract' });
    expect(await kernel.pages.decideChange(change.pageChange.changeId, { decision: 'accept' }, owner)).toMatchObject({ applied: false, status: 'stale' });
  }, 90_000);

  test('a parent sums up its kept sub-pages only; an accepted change in one marks the parent for a summary refresh', async () => {
    const parent = (await kernel.pages.create({ project: P, title: 'Obesity', body: 'Two questions.\n\n```subpages\n{}\n```\n', sumsChildren: true }, owner)).page!;
    await kernel.pages.keep(parent.id, { every: 'mon' }, owner);
    expect((await kernel.pages.update(pageId, { parent: parent.id }, owner)).applied).toBe(true);
    const draft = (await kernel.pages.create({ project: P, title: 'Muscle loss', parent: parent.id, body: 'Unclear.' }, owner)).page!;
    expect(await kernel.pages.update(parent.id, { parent: pageId }, owner)).toMatchObject({ applied: false, status: 'invalid' });

    const view = (await kernel.pages.get(parent.id, owner))!;
    expect(view.children.map((c) => [c.title, c.inSummary])).toEqual([['Muscle loss', false], ['Weight loss', true]]);
    const block = JSON.parse(view.body.match(/```subpages\n([\s\S]*?)\n```/)![1]!);
    expect(block.pages.map((p: { title: string; inSummary: boolean }) => [p.title, p.inSummary])).toEqual([['Muscle loss', false], ['Weight loss', true]]);
    expect(block.changes.map((c: { title: string }) => c.title)).toContain('Weight loss');
    expect((await kernel.pages.get(pageId, owner))!.breadcrumb).toEqual([{ id: parent.id, title: 'Obesity' }]);
    const list = (await kernel.pages.list(P, owner)).map((p) => p.title);
    expect(list.indexOf('Obesity')).toBeLessThan(list.indexOf('Weight loss'));

    // The parent's refresh reads its kept children; the draft is named apart, left out.
    const tools = (await import('../src/pages/tools.ts')).pageTools(() => kernel.pages as never);
    const forRefresh = await tools.find((t) => t.name === 'page.get')!.execute({ page: parent.id }, {} as never) as Record<string, unknown>;
    expect((forRefresh.children as { title: string }[]).map((c) => c.title)).toEqual(['Weight loss']);
    expect(forRefresh.drafts_left_out).toEqual([draft.title]);

    // A change accepted in the kept child: the parent's summary is due, and the sweep starts it.
    writer = { page: pageId, writes: { body: NEW_TRIAL.replace('10 trials', '12 trials'), label: '2 new trials' } };
    const started = await kernel.pages.refreshNow(pageId, owner);
    await waitingReview(started.runId!);
    const change = pageItems(await kernel.inbox(owner))[0] as { pageChange: { changeId: string } };
    await kernel.pages.decideChange(change.pageChange.changeId, { decision: 'accept' }, owner);
    await finished(started.runId!);
    const due = (await kernel.pages.get(parent.id, owner))!.refresh!;
    expect(due.summaryDue).toBeTruthy();
    writer = { page: parent.id, writes: { body: (await kernel.pages.get(parent.id, owner))!.written } };
    const swept = await kernel.pages.sweep(new Date());
    expect(swept.map((s) => s.pageId)).toEqual([parent.id]);
    expect(await finished(swept[0]!.runId)).toMatchObject({ state: 'end', status: 'done' });
    expect((await kernel.pages.get(parent.id, owner))!.refresh!.summaryDue).toBeUndefined();
    const { rows } = await kernel.pool.query(`select values -> 'reason' ->> 'value' as reason from mw.cases where id = $1`, [swept[0]!.caseId]);
    expect(rows[0].reason).toBe('summary');
  }, 120_000);

  test('archive: read only, off the schedule', async () => {
    const p = (await kernel.pages.create({ project: P, title: 'Old', body: 'Old answer.' }, owner)).page!;
    await kernel.pages.keep(p.id, {}, owner);
    expect((await kernel.pages.archive(p.id, owner)).page).toMatchObject({ status: 'archived' });
    expect((await kernel.pages.get(p.id, owner))!.refresh).toBeUndefined();
    expect(await kernel.pages.update(p.id, { body: 'New' }, owner)).toMatchObject({ applied: false, status: 'invalid' });
    expect((await kernel.pages.list(P, owner)).map((x) => x.id)).not.toContain(p.id);
  });

  test('a regulated project refuses changes to a kept page; drafts there change freely', async () => {
    const project = { domains: { [P]: { id: P, name: 'Trial master file', regulated: true, pages: {}, views: {}, workflows: [] } } } as unknown as ProjectDefs;
    const svc = createPagesService({
      pool: kernel.pool, project: () => project, people: kernel.people, records: () => kernel.records,
      start: () => Promise.reject(new Error('not here')), submitStep: (i) => kernel.submitStep(i), emit: () => {},
    });
    const draft = (await svc.create({ project: P, title: 'Draft', body: 'One.' }, owner)).page!;
    expect(await svc.update(draft.id, { body: 'Two.' }, owner)).toMatchObject({ applied: true });
    await svc.keep(draft.id, {}, owner);
    expect(await svc.update(draft.id, { body: 'Three.' }, owner)).toMatchObject({ applied: false, status: 'regulated' });
    expect(await svc.undo(draft.id, owner)).toMatchObject({ applied: false, status: 'regulated' });
    expect((await svc.get(draft.id, owner))!.canUndo).toBe(false);
  });

  test('a records block is a live query, as the viewer may see it', async () => {
    await kernel.records.create({ entity: 'Customer', values: { name: 'Acme Traders', gstin: '29ABCDE1234F1Z5' }, reason: 'test' }, owner).catch(() => undefined);
    const p = (await kernel.pages.create({ project: P, title: 'Customers', body: 'Who we serve.\n\n```records\n{"entity":"Customer","limit":5}\n```\n\n```records\n{}\n```\n' }, owner)).page!;
    const blocks = [...p.body.matchAll(/```records\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));
    expect(blocks[0]).toMatchObject({ entity: 'Customer', result: { entity: 'Customer' } });
    expect(typeof blocks[0].result.total).toBe('number');
    expect(blocks[1].error).toContain('entity');
    // The written body keeps the block as written.
    expect(p.written).toContain('{"entity":"Customer","limit":5}');
  });
});
