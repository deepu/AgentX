// Stage 4 (docs/memwise/26-projects-and-pages.md §5): a change to a playbook in a domain's folder
// (eTMF's Chase missing documents) drafted, run on one site in a throwaway database, and sent for
// review. A real kernel on the eTMF example with the meta playbooks; the live case runs on the
// example's scripted model turns, and the test run goes through the real `memwise test` CLI.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { parseExampleFile } from '@memwise/defs';
import { scriptedProvider } from '@memwise/gateway';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import type { Authoring, Kernel, PersonActor } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const REPO = resolve(import.meta.dir, '../../..');
const CHASE = 'domains/etmf/workflows/remind-site';

let db: TestDatabase;
let kernel: Kernel;
let authoring: Authoring;
let manager: PersonActor;
let cra: PersonActor;
let root = '';
let siteId = '';
let draftId = '';

/** The example's scripted writer turns: the live case drafts its email with them. */
function writerScript() {
  const text = readFileSync(join(REPO, 'examples/etmf', CHASE, 'examples/second-reminder.yaml'), 'utf8');
  const parsed = parseExampleFile(text, 'second-reminder.yaml');
  return parsed.value!.model!;
}

describe.skipIf(!pgAvailable)('Stage 4: a test run of a draft on one record', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_s4');
    const admin = new URL(db.url);
    admin.pathname = '/postgres';
    root = mkdtempSync(join(tmpdir(), 'mw-s4-'));
    cpSync(join(REPO, 'examples/etmf'), root, { recursive: true });
    for (const id of ['create-playbook', 'change-playbook']) cpSync(join(REPO, 'examples/intake/workflows', id), join(root, 'workflows', id), { recursive: true });
    // The email's body is for the study manager's eyes: a CRA doesn't see the whole chase case.
    const caseFile = join(root, CHASE, 'case.yaml');
    writeFileSync(caseFile, readFileSync(caseFile, 'utf8').replace('  email_body:        Text\n', '  email_body:        { type: Text, access: [study_manager] }\n'));
    const script = writerScript();
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: root, filesDir: mkdtempSync(join(tmpdir(), 'mw-s4-files-')),
      tools: [], modelRoles: { writer: { provider: 'scripted', model: 's' } }, providers: [scriptedProvider(script)],
      testDatabaseUrl: admin.toString(), logLevel: 'error',
    });
    const errors = (await kernel.index()).filter((d) => d.severity === 'error')
    expect(errors.filter((d) => d.file?.includes('remind-site'))).toEqual([]);
    authoring = kernel.authoring!;
    manager = await kernel.people.actorFor((await kernel.people.create({
      name: 'Anika Rao', email: 'anika@northlight.example', roles: ['study_manager', 'tmf_specialist', 'manager', 'staff'],
    })).id);
    cra = await kernel.people.actorFor((await kernel.people.create({ name: 'Ola Nowak', email: 'ola@northlight.example', roles: ['cra', 'staff'] })).id);
    // Site DE-104 with three documents missing and one reminder sent; picking it starts the chase.
    const create = async (entity: string, values: Record<string, unknown>, status?: string) => {
      const r = await kernel.records.create({ entity, values, ...(status ? { status } : {}), reason: 'study set-up' }, { kind: 'system' });
      if (!r.applied) throw new Error(`${entity}: ${r.message}`);
      return r.id!;
    };
    const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' });
    const study = await create('etmf.Study', { code: 'MW-301', sponsor });
    siteId = await create('etmf.Site', {
      site_number: 'DE-104', study, coordinator_email: 'coordinator@charite-studien.example',
      cra_name: 'Priya Shah', cra_email: 'priya.shah@northlight.example',
    });
    for (const artifact of ['Protocol signature page', 'Lab normal ranges', 'Sub-investigator CVs']) {
      await create('etmf.ExpectedDocument', { site: siteId, study, artifact, phase: 'start_up' });
    }
    await create('etmf.Reminder', { site: siteId, sent_to: 'coordinator@charite-studien.example', subject: 'MW-301: 3 documents needed' });
    const moved = await kernel.records.transition({ entity: 'etmf.Site', id: siteId, transition: 'picked', reason: 'Selected' }, manager);
    expect(moved.applied).toBe(true);
    await kernel.triggers.settle(30_000);
  }, 180_000);

  afterAll(async () => { await kernel?.shutdown(); await db?.drop(); });

  test('the live chase drafts its email and waits for the study manager', async () => {
    const { rows } = await db.pool.query(`select id from mw.runs where workflow_id = 'remind-site'`);
    expect(rows).toHaveLength(1);
    const run = await kernel.waitForRun(rows[0].id, { until: (r) => r.state === 'approve_email' || r.status !== 'active', timeoutMs: 60_000 });
    expect(run.state).toBe('approve_email');
    const kase = await kernel.getCase(run.caseId);
    expect(kase!.values.missing_documents?.value).toBe(3);
    expect(kase!.values.reminders_sent?.value).toBe(1);
    expect(kase!.values.email_to?.value).toBe('coordinator@charite-studien.example');
  }, 90_000);

  test('a change draft of a playbook in a domain folder copies the domain and keeps to the playbook', async () => {
    const meta = await authoring.createDraft({ workflowId: 'remind-site', title: 'Copy the CRA', kind: 'change', chatId: 'chat-1' }, manager);
    draftId = meta.id;
    expect(meta).toMatchObject({ folder: CHASE, chatId: 'chat-1', baseVersion: 2 });
    const listed = await authoring.read({ draftId });
    expect('files' in listed && listed.files).toContain(`${CHASE}/steps/send.md`);
    expect('files' in listed && listed.files.some((f) => f.startsWith('domains/etmf/workflows/file-document'))).toBe(false);
    const send = await authoring.read({ draftId, path: `${CHASE}/steps/send.md` });
    const text = 'content' in send ? send.content! : '';
    const changed = text
      .replace('title: Send, wait 5 days, remind again', 'title: Send, wait 5 days, remind again, and copy the CRA from the second reminder')
      .replace('    subject: case.email_subject\n', '    copied:  case.email_cc\n    subject: case.email_subject\n');
    expect(changed).not.toBe(text);
    const { edit, diagnostics } = await authoring.write({ draftId, files: [{ path: `${CHASE}/steps/send.md`, content: changed }], summary: 'Copy the CRA from the second reminder', via: 'chat', chatId: 'chat-1' }, manager);
    expect(edit.status).toBe('pending');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Another playbook of the domain can't be written from this draft.
    await expect(authoring.write({ draftId, files: [{ path: 'domains/etmf/workflows/file-document/workflow.yaml', content: 'x' }], summary: 'no', via: 'chat' }, manager))
      .rejects.toThrow('only holds');
    const diff = await authoring.diff(draftId);
    expect(diff.files.map((f) => f.path)).toEqual([`${CHASE}/steps/send.md`, `${CHASE}/workflow.yaml`]);
    expect(diff.structure?.steps.send?.parts).toEqual(expect.arrayContaining(['title', 'map']));
  });

  test('the test run copies the site in, replays the live case and records what it would send', async () => {
    const run = await authoring.testRun(draftId, { entity: 'etmf.Site', id: siteId }, manager);
    expect(run.differences).toEqual([]);
    expect(run.status).toBe('pass');
    expect(run.record).toMatchObject({ entity: 'etmf.Site', id: siteId });
    expect(run.replayedCase).toBeTruthy();
    expect(run.copied).toMatchObject({ 'etmf.Site': 1, 'etmf.ExpectedDocument': 3, 'etmf.Reminder': 1, 'etmf.Study': 1, 'etmf.Sponsor': 1 });
    expect(run.trace?.steps.map((s) => s.state)).toEqual(['find_missing', 'draft_email', 'approve_email', 'send']);
    expect(run.trace?.state).toBe('wait_for_upload');
    const reminder = run.trace?.calls.find((c) => c.tool === 'etmf.reminder.create');
    expect(reminder?.args).toMatchObject({ sent_to: 'coordinator@charite-studien.example', copied: 'priya.shah@northlight.example' });
    expect(await authoring.lastTestRun(draftId)).toMatchObject({ status: 'pass', hash: run.hash });
  }, 180_000);

  test('what the run saw goes back only to who ran it, and never into the project folder', async () => {
    const file = readFileSync(join(root, 'drafts', draftId, 'test-run.json'), 'utf8');
    expect(JSON.parse(file)).toEqual({
      draftId, workflowId: 'remind-site', hash: expect.any(String), at: expect.any(String), by: manager.personId,
      record: { entity: 'etmf.Site', id: siteId }, status: 'pass',
    });
    expect(file).not.toContain('priya.shah@northlight.example');
    expect(file).not.toContain('coordinator@');
    const mine = await authoring.lastTestRun(draftId, manager);
    expect(mine && 'trace' in mine && mine.trace?.calls.length).toBeGreaterThan(0);
    for (const other of [await authoring.lastTestRun(draftId, cra), await authoring.lastTestRun(draftId)]) {
      expect(other).toMatchObject({ status: 'pass', record: { entity: 'etmf.Site', id: siteId } });
      expect(other && ('trace' in other || 'copied' in other || 'title' in other.record)).toBe(false);
    }
  });

  test("someone who can't see the whole last case gets no replay of it", async () => {
    const other = await authoring.createDraft({ workflowId: 'remind-site', title: 'Look at it', kind: 'change', chatId: 'chat-cra' }, cra);
    const run = await authoring.testRun(other.id, { entity: 'etmf.Site', id: siteId }, cra);
    expect(run.replayedCase).toBeUndefined();
    // No model turns to replay, and no live model in a test run: it can't get past the agent step.
    expect(run.status).toBe('skip');
    expect(run.trace?.calls ?? []).toEqual([]);
  }, 120_000);

  test('one test run per draft at a time, and a draft discarded mid-run keeps no result', async () => {
    const other = await authoring.createDraft({ workflowId: 'remind-site', title: 'Thrown away', kind: 'change', chatId: 'chat-3' }, manager);
    const first = authoring.testRun(other.id, { entity: 'etmf.Site', id: siteId }, manager);
    await expect(authoring.testRun(other.id, { entity: 'etmf.Site', id: siteId }, manager)).rejects.toThrow('already running');
    await Bun.sleep(1500); // the throwaway database is being made
    await authoring.discardDraft(other.id, manager);
    await first.catch(() => undefined);
    expect(existsSync(join(root, 'drafts', other.id, 'test-run.json'))).toBe(false);
    expect(await authoring.lastTestRun(other.id, manager)).toBeUndefined();
  }, 180_000);

  test('Send for review starts the change run, which checks the draft and waits for its reviewer', async () => {
    const started = await authoring.submitDraft(draftId, manager);
    const run = await kernel.waitForRun(started.runId, { until: (r) => r.state === 'review' || r.status !== 'active', timeoutMs: 170_000 });
    expect(run.state).toBe('review');
    const kase = await kernel.getCase(started.caseId);
    expect(kase!.values.draft?.value).toBe(draftId);
  }, 180_000);
});
