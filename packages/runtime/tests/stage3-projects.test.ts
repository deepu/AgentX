// Stage 3 exit test (docs/memwise/26-projects-and-pages.md §3, §11 "Stage 3"): projects inside
// apps, through a real kernel on a copy of examples/etmf and Postgres.
//   1. A person granted only MW-301 never sees MW-207's records, pages, runs or chats (row rules).
//   2. MW-301 overrides "Chase missing documents" to wait 5 days; MW-207 waits the template's 3.
//   3. Template v5 is published; MW-207 gets "Review template update"; MW-301's review says it
//      already does that; a past case of MW-207 is replayed on v5.
//   4. MW-310 is copied from MW-301 with no records; a draft runs nothing until Start study.
//   5. "TMF across studies" shows both running studies.
//   6. Single-domain examples still load as one project each.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityTableName, PgPageStore, withActor, type TestDatabase } from '@memwise/db';
import { loadProject, resolveEntity, type ExampleCase } from '@memwise/defs';
import { parseSeed, SEED_FILE } from '../src/projects/seed.ts';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { projectTools } from '../src/projects/tools.ts';
import type { Actor, Kernel, PersonActor, TestRunner } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const EXAMPLES = resolve(import.meta.dir, '../../../examples');
const SYSTEM: Actor = { kind: 'system' };
const DAY = 86_400_000;

let db: TestDatabase;
let kernel: Kernel;
let root: string;
let anika: PersonActor; // study manager in every study
let priya: PersonActor; // CRA in MW-301 only
let tom: PersonActor; // TMF specialist in MW-301 and MW-207
const runnerCalls: { workflowId: string; extra: ExampleCase[] }[] = [];

/** The example cases as the CLI would run them: every one passes (the replayed past case too). */
const fakeRunner: TestRunner = async ({ workflowId, extraExamples }) => {
  runnerCalls.push({ workflowId, extra: extraExamples ?? [] });
  return [
    { name: 'pack-arrives', status: 'pass', differences: [] },
    { name: 'still-missing', status: 'pass', differences: [] },
    ...(extraExamples ?? []).map((e) => ({ name: e.name, status: 'pass' as const, differences: [] })),
  ];
};

const rows = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
const asPerson = <T,>(actor: Actor, sql: string, params: unknown[] = []) =>
  withActor(db.pool, actor, async (c) => (await c.query(sql, params)).rows as T[]);
const def = async (key: string) => (await kernel.project()).project.entities[key]!;
const table = async (key: string) => `domain."${entityTableName(await def(key))}"`;
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const siteIn = async (project: string, number: string) =>
  (await rows(`select id from ${await table('etmf.Site')} where project = $1 and site_number = $2`, [project, number]))[0]!.id as string;
const chaseRun = (project: string, site: string) => until(`chase-missing in ${project}`, async () =>
  (await rows(`select r.id, r.case_id, r.project, r.workflow_hash, r.state from mw.runs r join mw.cases c on c.id = r.case_id
                where r.workflow_id = 'chase-missing' and r.project = $1 and c.values -> 'site' ->> 'value' = $2`, [project, site]))[0],
  (r) => !!r);

describe.skipIf(!pgAvailable)('Stage 3: projects inside apps', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mw-stage3-'));
    cpSync(join(EXAMPLES, 'etmf'), root, { recursive: true });
    // MW-310 is made in this test, from MW-301, as New project makes it.
    rmSync(join(root, 'projects', 'mw310'), { recursive: true, force: true });
    db = await kernelDatabase('mw_rt_stage3');
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: root, tools: [], modelRoles: {}, providers: [], testRunner: fakeRunner,
      filesDir: mkdtempSync(join(tmpdir(), 'mw-stage3-files-')), logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const actor = async (email: string) => kernel.people.actorFor((await kernel.people.byEmail(email))!.id);
    anika = await actor('anika.rao@northlight.example');
    priya = await actor('priya.shah@northlight.example');
    tom = await actor('tom.okafor@northlight.example');
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test('the people of project.yaml are people with grants in their projects only', async () => {
    expect(priya.roles).toEqual([]);
    expect(priya.grants).toEqual([{ role: 'cra', domain: 'etmf', project: 'mw301' }]);
    expect(tom.grants).toEqual([{ role: 'tmf_specialist', domain: 'etmf', project: 'mw207' }, { role: 'tmf_specialist', domain: 'etmf', project: 'mw301' }]);
    expect((await rows(`select id, app, status, template_version from mw.projects where app = 'etmf' order by id`)))
      // The app's own project (D107) has its row beside the studies.
      .toEqual([{ id: 'etmf', app: 'etmf', status: 'active', template_version: 4 }, { id: 'mw207', app: 'etmf', status: 'active', template_version: 4 }, { id: 'mw301', app: 'etmf', status: 'active', template_version: 4 }]);
  });

  test('the walkthrough records are made into their studies, once', async () => {
    const mw301 = await kernel.projects.seed('mw301', SYSTEM);
    const mw207 = await kernel.projects.seed('mw207', SYSTEM);
    expect(mw301.created).toBeGreaterThan(100);
    expect(mw207.created).toBeGreaterThan(40);
    expect(await kernel.projects.seed('mw301', SYSTEM)).toEqual({ created: 0, skipped: 'it has records' });
    await expect(kernel.projects.seed('mw301', anika)).rejects.toThrow('only the kernel itself');
    const sites = await rows(`select project, count(*)::int as n from ${await table('etmf.Site')} group by project order by project`);
    expect(sites).toEqual([{ project: 'mw207', n: 6 }, { project: 'mw301', n: 12 }]);
    // The sponsor is the app's (scope: app): one record, no project column, shared by both studies.
    expect(await rows(`select count(*)::int as n from ${await table('etmf.Sponsor')}`)).toEqual([{ n: 1 }]);
    expect((await rows(`select column_name from information_schema.columns where table_schema = 'domain' and table_name = $1 and column_name = 'project'`,
      [entityTableName(await def('etmf.Sponsor'))]))).toEqual([]);
    // EDC's sites went to EDC's own project; an open site with its whole pack raises no flag.
    expect(await rows(`select distinct project from ${await table('edc.Site')}`)).toEqual([{ project: 'edc' }]);
    await kernel.triggers.settle(30_000);
    expect(await rows(`select count(*)::int as n from mw.record_flags where closed_at is null and entity = 'etmf.Site'`)).toEqual([{ n: 0 }]);
  }, 120_000);

  let run301 = '';
  let run207 = '';
  let case207 = '';
let hash301 = '';

  test('exit 2: a site activating in MW-301 runs MW-301\'s own Chase missing documents, which waits 5 days; MW-207 waits 3', async () => {
    const jp = await siteIn('mw301', 'JP-009');
    const at = await siteIn('mw207', 'AT-005');
    expect(await kernel.records.transition({ entity: 'etmf.Site', id: jp, transition: 'picked' }, anika)).toMatchObject({ applied: true });
    expect(await kernel.records.transition({ entity: 'etmf.Site', id: at, transition: 'picked' }, anika)).toMatchObject({ applied: true });
    await kernel.triggers.settle(30_000);
    const r301 = await chaseRun('mw301', jp);
    const r207 = await chaseRun('mw207', at);
    run301 = r301.id; run207 = r207.id; case207 = r207.case_id; hash301 = r301.workflow_hash;
    const project = (await kernel.project()).project.projects!;
    // Each runs its project's own copy, pinned by hash like any version.
    expect(r301.workflow_hash).toBe(project.mw301!.workflows['chase-missing']!.hash);
    expect(r207.workflow_hash).toBe(project.mw207!.workflows['chase-missing']!.hash);
    expect(project.mw301!.workflows['chase-missing']!.overridden).toEqual(['workflow.yaml']);
    expect(project.mw301!.workflows['chase-missing']!.version).toBe(2);
    // Cases and step runs belong to the run's project.
    expect(await rows(`select project from mw.cases where id = $1`, [r301.case_id])).toEqual([{ project: 'mw301' }]);

    // Tom sends both reminders: he holds tmf_specialist in both studies.
    // (The sites seeded as activating are being chased too: the trigger fired for them when they were made.)
    const reminders = await until('both reminders', async () => (await kernel.inbox(tom))
      .filter((i) => i.kind === 'decision' && (i.runId === run301 || i.runId === run207)), (x) => x.length === 2);
    expect(reminders.map((i) => i.project).sort()).toEqual(['mw207', 'mw301']);
    for (const i of reminders) {
      if (i.kind !== 'decision') continue;
      expect(await kernel.submitStep({ stepRunId: i.stepRunId, outcome: 'sent', values: {}, by: tom })).toMatchObject({ applied: true });
    }
    const waitDays = async (runId: string) => {
      await kernel.waitForRun(runId, { until: (r) => r.state === 'wait_for_documents', timeoutMs: 30_000 });
      const t = await until('the timeout timer', () => rows(`select fire_at from mw.timers where run_id = $1 and status = 'pending'`, [runId]), (x) => x.length > 0);
      return Math.round((new Date(t[0]!.fire_at).getTime() - Date.now()) / DAY);
    };
    expect(await waitDays(run301)).toBe(5);
    expect(await waitDays(run207)).toBe(3);
  }, 120_000);

  test('exit 1: Priya, granted only MW-301, never sees MW-207\'s records, pages, runs or chats', async () => {
    // A page and a chat in each study.
    const pages = new PgPageStore();
    await withActor(db.pool, SYSTEM, async (c) => {
      await pages.save(c, { domain: 'etmf', project: 'mw301', title: 'MW-301 inspection prep', body: 'Ready.' }, 'system');
      await pages.save(c, { domain: 'etmf', project: 'mw207', title: 'MW-207 QC backlog', body: 'Behind.' }, 'system');
    });
    const case301 = (await rows(`select case_id from mw.runs where id = $1`, [run301]))[0]!.case_id;
    await db.pool.query(`insert into mw.chat_anchors (chat_id, anchor_kind, anchor_id) values ('chat_301', 'case', $1), ('chat_207', 'case', $2)`, [case301, case207]);
    expect(await rows(`select chat_id, project from mw.chat_anchors where chat_id like 'chat_%' order by chat_id`))
      .toEqual([{ chat_id: 'chat_207', project: 'mw207' }, { chat_id: 'chat_301', project: 'mw301' }]);

    // In SQL, under the app role's row rules.
    const sites = await asPerson<{ project: string }>(priya, `select distinct project from ${await table('etmf.Site')}`);
    expect(sites).toEqual([{ project: 'mw301' }]);
    for (const key of ['etmf.Document', 'etmf.ExpectedDocument', 'etmf.Person', 'etmf.Study']) {
      expect(await asPerson(priya, `select id from ${await table(key)} where project = 'mw207'`)).toEqual([]);
      expect((await asPerson(priya, `select id from ${await table(key)} where project = 'mw301'`)).length).toBeGreaterThan(0);
    }
    expect(await asPerson(priya, `select count(*)::int as n from ${await table('etmf.Sponsor')}`)).toEqual([{ n: 1 }]);
    expect((await asPerson<{ title: string }>(priya, `select title from mw.pages where domain = 'etmf'`)).map((p) => p.title)).toEqual(['MW-301 inspection prep']);
    expect((await asPerson<{ project: string }>(priya, `select distinct project from mw.runs`)).map((r) => r.project)).not.toContain('mw207');
    expect(await asPerson(priya, `select id from mw.cases where project = 'mw207'`)).toEqual([]);
    expect(await asPerson(priya, `select id from mw.step_runs where project = 'mw207'`)).toEqual([]);
    expect((await asPerson<{ chat_id: string }>(priya, `select chat_id from mw.chat_anchors where chat_id like 'chat_%'`)).map((c) => c.chat_id)).toEqual(['chat_301']);
    expect(await asPerson(priya, `select record_id from mw.record_versions where project = 'mw207'`)).toEqual([]);
    // Writing into MW-207 is refused too.
    const stranger = await kernel.records.create({ entity: 'etmf.Person', values: { name: 'Eve Intruder' }, project: 'mw207' }, priya);
    expect(stranger.applied).toBe(false);

    // Through the kernel: records, cases, Waiting for you.
    const q = await kernel.records.query({ entity: 'etmf.Site' }, priya);
    expect(q.total).toBe(12);
    expect(await kernel.getCaseView(case207, priya)).toBeUndefined();
    expect(await kernel.getCaseView(case301, priya)).toBeDefined();
    expect((await kernel.listCases({}, priya)).map((c) => c.project)).not.toContain('mw207');
    expect((await kernel.listCases({ project: 'mw207' }, anika)).length).toBeGreaterThan(0);
    expect((await kernel.inbox(priya)).map((i) => i.project)).not.toContain('mw207');
    // The switcher lists only her study; MW-207 isn't there to open.
    const apps = await kernel.projects.apps(priya);
    expect(apps.find((a) => a.id === 'etmf')!.projects.map((p) => p.id)).toEqual(['mw301']);
    expect(await kernel.projects.get('mw207', priya)).toBeUndefined();
    // A project-scoped query narrows to one study.
    expect((await kernel.records.query({ entity: 'etmf.Site', project: 'mw207' }, anika)).total).toBe(6);
  }, 60_000);

  test('exit 4: MW-310 is copied from MW-301, a draft with no records until Start study', async () => {
    const created = await kernel.projects.create({ copyFrom: 'mw301', name: 'Study MW-310', study: 'MW-310', id: 'mw310' }, anika);
    // Her grants now reach MW-310 too (she is in its people, copied from MW-301).
    anika = await kernel.people.actorFor(anika.personId);
    priya = await kernel.people.actorFor(priya.personId);
    expect(anika.grants!.filter((g) => g.project === 'mw310')).toEqual([{ role: 'study_manager', domain: 'etmf', project: 'mw310' }]);
    expect(created).toMatchObject({ id: 'mw310', app: 'etmf', status: 'draft', from: { project: 'mw301' }, templateVersion: 4, canEdit: true });
    expect(created.overrides.map((o) => o.path)).toEqual(['workflows/chase-missing/workflow.yaml']);
    expect(created.people.map((p) => p.email)).toEqual(['anika.rao@northlight.example', 'priya.shah@northlight.example', 'tom.okafor@northlight.example']);
    expect(created.connections.map((c) => c.id)).toEqual(['storage', 'email', 'pubmed', 'vault']);
    expect(existsSync(join(root, 'projects/mw310/project.yaml'))).toBe(true);
    expect(readFileSync(join(root, 'projects/mw310/project.yaml'), 'utf8')).toContain('copied_from: mw301');
    expect(await rows(`select status, created_by from mw.projects where id = 'mw310'`)).toEqual([{ status: 'draft', created_by: anika.personId }]);
    // No records came with it: not one row of any project-scoped table, nor runs.
    const tables = await rows(`select table_name from information_schema.columns where table_schema = 'domain' and column_name = 'project'`);
    for (const t of tables) expect(await rows(`select id from domain."${t.table_name}" where project = 'mw310'`)).toEqual([]);
    expect(await rows(`select id from mw.runs where project = 'mw310'`)).toEqual([]);
    // A draft runs nothing.
    await expect(kernel.startRun({ workflowId: 'chase-missing', case: {}, project: 'mw310' })).rejects.toThrow('is a draft');
    // Start study.
    const started = await kernel.projects.start('mw310', anika);
    expect(started.status).toBe('active');
    expect(readFileSync(join(root, 'projects/mw310/project.yaml'), 'utf8')).not.toContain('status: draft');
    // A person not managing the study can't change it.
    await expect(kernel.projects.archive('mw310', priya)).rejects.toThrow('only the Study manager');
    // A second draft can be discarded; a started study can't.
    await kernel.projects.create({ app: 'etmf', name: 'Study MW-999', template: 'phase1' }, anika);
    anika = await kernel.people.actorFor(anika.personId); // she made it, so she is in it
    expect((await kernel.projects.get('study-mw-999', anika))!.without).toEqual(['workflows/chase-missing']);
    await kernel.projects.discard('study-mw-999', anika);
    expect(existsSync(join(root, 'projects/study-mw-999'))).toBe(false);
    expect(await rows(`select id from mw.projects where id = 'study-mw-999'`)).toEqual([]);
    await expect(kernel.projects.discard('mw310', anika)).rejects.toThrow('only a draft');
  }, 60_000);

  test('exit 3: template v5 makes "Review template update" for MW-207; MW-301 already does that', async () => {
    const v4 = readFileSync(join(root, 'domains/etmf/workflows/chase-missing/workflow.yaml'), 'utf8');
    const v5 = v4.replace('version: 1', 'version: 2').replace(/(wait_for_documents:[\s\S]*?timeout: )3d/, '$15d');
    expect(v5).not.toBe(v4);
    await expect(kernel.projects.publishTemplate('etmf', { 'workflows/chase-missing/workflow.yaml': v5 }, priya)).rejects.toThrow('only the Study manager');
    const published = await kernel.projects.publishTemplate('etmf', { 'workflows/chase-missing/workflow.yaml': v5 }, anika);
    expect(published.version).toBe(5);
    expect(published.updates.map((u) => u.project).sort()).toEqual(['mw207', 'mw301', 'mw310']);
    expect(existsSync(join(root, 'domains/etmf/versions/4/workflows/chase-missing/workflow.yaml'))).toBe(true);

    // Waiting for you: Anika (study manager everywhere) has all three; Priya none.
    const items = await kernel.projects.templateUpdates(anika);
    expect(items.find((i) => i.project === 'mw207')).toMatchObject({ kind: 'template-update', app: 'etmf', from: 4, to: 5, title: 'Review template update: eTMF v5' });
    expect(await kernel.projects.templateUpdates(priya)).toEqual([]);
    const waiting = await kernel.projects.waiting(anika);
    expect(waiting.find((g) => g.project === 'mw207')!.updates).toHaveLength(1);

    const r207 = (await kernel.projects.reviewUpdate('mw207', anika, { test: true }))!;
    expect(r207.nothingChanges).toBe(false);
    expect(r207.changes).toEqual([expect.objectContaining({
      path: 'workflows/chase-missing/workflow.yaml', kind: 'changed', workflow: 'chase-missing', project: 'takes', title: 'Chase missing documents',
    })]);
    // The test run: MW-207's own case replayed on v5 (and the playbook's example cases).
    expect(r207.test).toMatchObject({ workflowId: 'chase-missing', caseId: case207, status: 'same', examples: { passed: 2, total: 2 } });
    expect(runnerCalls.at(-1)!.workflowId).toBe('chase-missing');
    expect(runnerCalls.at(-1)!.extra[0]!.case.site).toBe(await siteIn('mw207', 'AT-005'));

    const r301 = (await kernel.projects.reviewUpdate('mw301', anika))!;
    expect(r301.nothingChanges).toBe(true);
    expect(r301.changes[0]).toMatchObject({ project: 'overridden-same', note: 'This project already does that, so nothing changes here.' });
    expect(r301.summary).toContain('already does');
    expect(r301.test).toBeUndefined();

    // MW-301 takes it: its override goes (the template says the same now); it stays at 5 days.
    const taken = await kernel.projects.takeUpdate('mw301', anika);
    expect(taken).toEqual({ version: 5, removed: ['workflows/chase-missing/workflow.yaml'] });
    const p301 = (await kernel.project()).project.projects!.mw301!;
    expect(p301.version).toBe(5);
    expect(p301.overrides).toEqual([]);
    expect(p301.workflows['chase-missing']!.overridden).toBeUndefined();
    expect(p301.workflows['chase-missing']!.version).toBe(2);
    expect(p301.workflows['chase-missing']!.hash).not.toBe(hash301);
    // MW-207 skips it: no item for v5 again.
    await kernel.projects.skipUpdate('mw207', anika);
    expect((await kernel.projects.templateUpdates(anika)).map((i) => i.project)).toEqual(['mw310']);
    // Runs already going keep the version they started on.
    expect((await rows(`select workflow_hash from mw.runs where id = $1`, [run301]))[0]!.workflow_hash).toBe(hash301);
  }, 120_000);

  test('exit 5: "TMF across studies" shows both running studies', async () => {
    const home = await kernel.projects.home('etmf', anika);
    expect(home).toMatchObject({ app: 'etmf', title: 'TMF across studies', link: 'All studies', nouns: { one: 'study', many: 'studies' } });
    expect(home.columns.map((c) => c.label)).toEqual(['Phase', 'Sites', 'Filed', 'Missing', 'Waiting for QC']);
    const row = (id: string) => home.rows.find((r) => r.project === id)!;
    expect(row('mw301')).toMatchObject({ name: 'Study MW-301', status: 'active', study: 'MW-301', next: { label: 'Inspection', date: '2026-11-16' } });
    expect(row('mw207')).toMatchObject({ name: 'Study MW-207', status: 'active', next: { label: 'Lock', date: '2026-11-30' } });
    // Phase 3, 12 sites, 63 of 72 expected documents filed (9 missing at UK-207, CA-118, JP-009), 8 waiting for QC.
    expect(row('mw301').values.slice(0, 2)).toEqual([3, 12]);
    expect(row('mw301').values[2]).toBeCloseTo(87.5, 0);
    expect(row('mw301').values.slice(3)).toEqual([9, 8]);
    expect(row('mw207').values[0]).toBe(2);
    expect(row('mw207').values[1]).toBe(6);
    expect(row('mw207').values[4]).toBe(10);
    // MW-310 started with nothing in it.
    expect(row('mw310').values.slice(1)).toEqual([0, null, 0, 0]);
    expect(home.totals).toEqual({ projects: 3, active: 3, draft: 0, archived: 0 });
    expect(home.headline!.label).toBe('Filed');
    expect(home.milestones.find((m) => m.project === 'mw207')).toEqual({ project: 'mw207', name: 'Study MW-207', label: 'Lock', date: '2026-11-30' });
    expect(home.milestones[0]!.date).toBe('2026-11-16');
    // Tom sent JP-009's and AT-005's reminders; the chases of the sites seeded as activating wait on him.
    expect(home.bottlenecks.find((b) => b.name === 'Tom Okafor')).toMatchObject({
      roles: ['TMF specialist'], total: 4,
      waiting: [{ project: 'mw207', projectName: 'Study MW-207', count: 2 }, { project: 'mw301', projectName: 'Study MW-301', count: 2 }],
    });

    // One more chase in MW-207 waits on him there.
    const { runId } = await kernel.startRun({ workflowId: 'chase-missing', case: { site: await siteIn('mw207', 'FR-114') }, project: 'mw207' });
    await kernel.waitForRun(runId, { until: (r) => r.state === 'send_reminder', timeoutMs: 30_000 });
    await until('the reminder step', () => rows(`select id from mw.step_runs where run_id = $1 and status = 'waiting'`, [runId]), (x) => x.length > 0);
    const after = await kernel.projects.home('etmf', anika);
    expect(after.bottlenecks.find((b) => b.name === 'Tom Okafor')).toMatchObject({ total: 5, waiting: [{ project: 'mw207', count: 3 }, { project: 'mw301', count: 2 }] });
    expect(after.rows.find((r) => r.project === 'mw207')!.waiting).toBe(0); // Anika isn't a TMF specialist
    // Priya's home has only her studies: MW-301, and MW-310, whose people were copied from it.
    expect((await kernel.projects.home('etmf', priya)).rows.map((r) => r.project)).toEqual(['mw301', 'mw310']);
  }, 60_000);

  test('describe it in chat: the create-project conversation makes a draft study', async () => {
    const { runId, stepRunId } = await kernel.projects.describe({ app: 'etmf', request: 'A phase 1 study MW-311 in healthy volunteers' }, anika);
    const run = await kernel.waitForRun(runId, { until: (r) => r.state === 'interview', timeoutMs: 30_000 });
    // An app playbook: it runs in the app's own project, which everyone in the app sees.
    expect((await rows(`select project from mw.runs where id = $1`, [runId]))[0]!.project).toBe('etmf');
    expect((await kernel.project()).project.projects!.mw301!.workflows['create-project']).toBeUndefined();
    const item = await until('the conversation', async () => (await kernel.inbox(anika)).find((i) => i.kind === 'conversation' && i.runId === runId), (x) => !!x);
    // The conversation's tools, as its step calls them.
    const tools = projectTools(() => kernel.projects, (id) => kernel.people.actorFor(id));
    const ctx = { token: { runId, onBehalfOf: anika.personId } } as never;
    const options = await tools.find((t) => t.name === 'projects.options')!.execute({ app: 'etmf' }, ctx) as { templates: { id: string }[] };
    expect(options.templates.map((t) => t.id)).toEqual(['phase3', 'phase1']);
    const made = await tools.find((t) => t.name === 'projects.create_draft')!.execute({ app: 'etmf', name: 'Study MW-311', template: 'phase1', study: 'MW-311' }, ctx);
    expect(made).toEqual({ project: 'study-mw-311', name: 'Study MW-311', status: 'draft' });
    // Asked again (a retried call): the same draft.
    expect(await tools.find((t) => t.name === 'projects.create_draft')!.execute({ app: 'etmf', name: 'Study MW-311' }, ctx)).toEqual(made);
    if (item?.kind !== 'conversation') throw new Error('no conversation');
    expect(item.stepRunId).toBe(stepRunId);
    const done = await kernel.submitStep({ stepRunId: item.stepRunId, outcome: 'drafted', values: { project: 'study-mw-311', name: 'Study MW-311' }, by: anika, via: { chatId: 'chat_mw311' } });
    expect(done).toMatchObject({ applied: true });
    await kernel.waitForRun(run.id, { until: (r) => r.status === 'done', timeoutMs: 30_000 });
    // She is in the new study's people, as the one who made it.
    anika = await kernel.people.actorFor(anika.personId);
    expect((await kernel.projects.get('study-mw-311', anika))!).toMatchObject({ status: 'draft', templateTitle: 'Phase 1 study', study: 'MW-311' });
  }, 60_000);

  test('save as template: a project\'s way of working becomes the next version', async () => {
    // MW-310 still has MW-301's override (5 days), which v5 also says: nothing differs, so v6 changes nothing.
    const before = (await kernel.project()).project.apps!.etmf!.version;
    const r = await kernel.projects.saveAsTemplate('mw310', {}, anika);
    expect(r).toEqual({ app: 'etmf', version: before + 1 });
  }, 60_000);

  test('exit 6: single-domain examples still load, each as one project', async () => {
    const intake = (await loadProject(join(EXAMPLES, 'intake'))).project;
    expect(Object.keys(intake.projects ?? {})).toEqual(['domain']);
    expect(intake.projects!.domain).toMatchObject({ implicit: true, app: 'domain' });
    const literature = (await loadProject(join(EXAMPLES, 'literature'))).project;
    expect(Object.keys(literature.projects ?? {})).toEqual(['literature']);
    expect(literature.projects!.literature).toMatchObject({ name: 'Literature search', app: 'literature' });
    expect(literature.projects!.literature!.implicit).toBeUndefined();
  });

  test("every example's seed.yaml names only record types its project's apps have", async () => {
    for (const example of ['etmf', 'intake', 'literature']) {
      const { project } = await loadProject(join(EXAMPLES, example));
      for (const p of Object.values(project.projects ?? {})) {
        if (!p.dir) continue;
        const file = join(EXAMPLES, example, p.dir, SEED_FILE);
        if (!existsSync(file)) continue;
        for (const e of parseSeed(readFileSync(file, 'utf8'))) {
          const found = (p.apps?.length ? p.apps : [p.app]).some((app) => resolveEntity(project.entities, app, e.entity));
          expect({ example, project: p.id, key: e.key, found }).toEqual({ example, project: p.id, key: e.key, found: true });
        }
      }
    }
  });
});
