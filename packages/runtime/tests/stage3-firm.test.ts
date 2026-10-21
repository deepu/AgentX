// Stage 3, D105: projects don't assume one app or one case per record. A firm is one project that
// runs several apps (GST, income tax) on the same client records, with a case per client per
// period; a study is one project of one app (stage3-projects.test.ts). Through a real kernel on a
// small workspace written here, and Postgres.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entityTableName, withActor, type TestDatabase } from '@memwise/db';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import type { Actor, Kernel, PersonActor } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const filing = (domain: string, id: string, title: string) => ({
  [`domains/${domain}/domain.yaml`]: `domain: ${domain}\nname: ${title}\nowner: partner\n`,
  [`domains/${domain}/workflows/${id}/workflow.yaml`]: `workflow: ${id}\nversion: 1\ntitle: ${title} return\nowner: partner\nstart: prepare\nsteps:\n  prepare: { on: { filed: end } }\n`,
  [`domains/${domain}/workflows/${id}/case.yaml`]: `case: ${id.replace(/-/g, '_')}\nfields:\n  client: { type: Ref<practice.Client>, required: true }\n  period: { type: Text, required: true }\n  reference: Text\n`,
  [`domains/${domain}/workflows/${id}/steps/prepare.md`]: `---\ntitle: Prepare and file\nperformer: person\nassignee: preparer\nreads: [case.client, case.period]\nwrites:\n  reference: Text\noutcomes: [filed]\n---\nPrepare the return from the client's books and file it.\n`,
});

const FILES: Record<string, string> = {
  'workspace.yaml': 'workspace: Mehta & Rao\nroles:\n  partner:  { title: Partner }\n  preparer: { title: Preparer }\n',
  'domains/practice/domain.yaml': 'domain: practice\nname: Practice\nowner: partner\n',
  'domains/practice/entities/client.yaml': 'entity: Client\ntitle: "{name}"\nfields:\n  name:  { type: Text, required: true }\n  gstin: Text\nlifecycle: [active, left]\n',
  ...filing('gst', 'file-gst', 'GST'),
  ...filing('itr', 'file-itr', 'Income tax'),
  // One firm: its clients (Practice), and the GST and income-tax apps on them.
  'projects/firm/project.yaml': [
    'app: practice', 'also: [gst, itr]', 'name: Mehta & Rao', 'people:',
    '  - { email: meera@mehtarao.example, name: Meera Mehta, roles: [partner] }',
    '  - { email: ravi@mehtarao.example, name: Ravi Kumar, roles: [preparer] }', '',
  ].join('\n'),
  // Another firm on the same apps (GST only): its own clients, people and cases.
  'projects/other/project.yaml': [
    'app: practice', 'also: [gst]', 'name: Other & Co', 'people:',
    '  - { email: ivy@other.example, name: Ivy Shah, roles: [preparer] }', '',
  ].join('\n'),
};

let db: TestDatabase;
let kernel: Kernel;
let root: string;
let meera: PersonActor;
let ravi: PersonActor;
let ivy: PersonActor;
const SYSTEM: Actor = { kind: 'system' };

describe.skipIf(!pgAvailable)('Stage 3 (D105): one project, several apps, many cases per record', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mw-firm-'));
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    db = await kernelDatabase('mw_rt_firm');
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: root, tools: [], modelRoles: {}, providers: [],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-firm-files-')), logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    const actor = async (email: string) => kernel.people.actorFor((await kernel.people.byEmail(email))!.id);
    meera = await actor('meera@mehtarao.example');
    ravi = await actor('ravi@mehtarao.example');
    ivy = await actor('ivy@other.example');
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test('the firm runs every app it names, each from its own copies; no app gets a project of its own', async () => {
    const { project } = await kernel.project();
    const firm = project.projects!.firm!;
    expect(firm.apps).toEqual(['practice', 'gst', 'itr']);
    expect(Object.keys(firm.workflows).sort()).toEqual(['file-gst', 'file-itr']);
    expect(firm.workflows['file-gst']!.hash).not.toBe(project.workflows['file-gst']!.hash);
    expect(Object.keys(project.projects!.other!.workflows)).toEqual(['file-gst']);
    // Every app is run by a firm, so none has an implicit project; each app still has its own
    // project's row (D107), where its own runs and what someone with no project makes live.
    expect(Object.keys(project.projects!).sort()).toEqual(['firm', 'other']);
    expect(await db.pool.query(`select id, app, apps from mw.projects order by id`).then((r) => r.rows)).toEqual([
      { id: 'firm', app: 'practice', apps: ['practice', 'gst', 'itr'] },
      { id: 'gst', app: 'gst', apps: ['gst'] },
      { id: 'itr', app: 'itr', apps: ['itr'] },
      { id: 'other', app: 'practice', apps: ['practice', 'gst'] },
      { id: 'practice', app: 'practice', apps: ['practice'] },
    ]);
    // A person's role in the firm holds in each of its apps.
    expect(ravi.grants).toEqual([
      { role: 'preparer', domain: 'gst', project: 'firm' },
      { role: 'preparer', domain: 'itr', project: 'firm' },
      { role: 'preparer', domain: 'practice', project: 'firm' },
    ]);
    // The switcher lists the firm under each app it runs.
    const apps = await kernel.projects.apps(meera);
    expect(apps.map((a) => [a.id, a.projects.map((p) => p.id)])).toEqual(expect.arrayContaining([['gst', ['firm']], ['itr', ['firm']], ['practice', ['firm']]]));
    expect((await kernel.projects.get('firm', meera))!.apps).toEqual(['practice', 'gst', 'itr']);
  });

  test('both apps work on the same client record, with a case per client per period', async () => {
    const made = await kernel.records.create({ entity: 'practice.Client', values: { name: 'Acme Traders', gstin: '27AAACA1234A1Z5' }, project: 'firm' }, meera);
    expect(made).toMatchObject({ applied: true });
    const client = made.id!;
    const runs = [];
    for (const [workflowId, period] of [['file-gst', '2026-07'], ['file-gst', '2026-08'], ['file-itr', 'FY 2025-26']] as const) {
      runs.push(await kernel.startRun({ workflowId, case: { client, period }, project: 'firm', by: meera.personId }));
    }
    const { project } = await kernel.project();
    const rows = (await db.pool.query(`select workflow_id, workflow_hash, project from mw.runs order by created_at`)).rows;
    expect(rows).toEqual([
      { workflow_id: 'file-gst', workflow_hash: project.projects!.firm!.workflows['file-gst']!.hash, project: 'firm' },
      { workflow_id: 'file-gst', workflow_hash: project.projects!.firm!.workflows['file-gst']!.hash, project: 'firm' },
      { workflow_id: 'file-itr', workflow_hash: project.projects!.firm!.workflows['file-itr']!.hash, project: 'firm' },
    ]);
    // Three cases waiting on Ravi, all about the one client.
    const inbox = await (async () => {
      for (let i = 0; i < 100; i++) {
        const items = (await kernel.inbox(ravi)).filter((x) => x.kind === 'input');
        if (items.length === 3) return items;
        await new Promise((r) => setTimeout(r, 100));
      }
      return (await kernel.inbox(ravi)).filter((x) => x.kind === 'input');
    })();
    expect(inbox.map((x) => x.project)).toEqual(['firm', 'firm', 'firm']);
    const cases = await kernel.listCases({ project: 'firm' }, ravi);
    expect(cases.length).toBe(3);
    // Filing one leaves the others of the same client open.
    const first = inbox.find((x) => x.kind === 'input' && x.workflowId === 'file-gst')!;
    if (first.kind !== 'input') throw new Error('not an input item');
    expect(await kernel.submitStep({ stepRunId: first.stepRunId, outcome: 'filed', values: { reference: 'ARN-1' }, by: ravi })).toMatchObject({ applied: true });
    await kernel.waitForRun(first.runId, { until: (r) => r.status === 'done', timeoutMs: 30_000 });
    expect((await db.pool.query(`select count(*)::int as n from mw.runs where status = 'active' and project = 'firm'`)).rows[0].n).toBe(2);
    // The client is the firm's: both apps' people read it there; the other firm doesn't see it.
    const table = `domain."${entityTableName((await kernel.project()).project.entities['practice.Client']!)}"`;
    const seen = (a: Actor) => withActor(db.pool, a, async (c) => (await c.query(`select id from ${table}`)).rows.map((r) => r.id));
    expect(await seen(ravi)).toEqual([client]);
    expect(await seen(ivy)).toEqual([]);
    expect(await seen(SYSTEM)).toEqual([client]);
  }, 60_000);

  test("another firm's preparer sees none of the firm's cases, runs or project", async () => {
    expect((await kernel.inbox(ivy)).filter((x) => x.project === 'firm')).toEqual([]);
    expect(await kernel.listCases({ project: 'firm' }, ivy)).toEqual([]);
    expect(await withActor(db.pool, ivy, async (c) => (await c.query(`select id from mw.runs`)).rows)).toEqual([]);
    expect((await kernel.projects.list(ivy)).map((p) => p.id)).toEqual(['other']);
    expect(await kernel.projects.get('firm', ivy)).toBeUndefined();
  });
});
