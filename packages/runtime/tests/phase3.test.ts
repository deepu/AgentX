// Phase 3 kernel (docs/memwise/20-phase-3-interfaces.md) on a temp copy of examples/intake:
// the version index, conversation steps, the playbooks.* tools, Authoring end to end (a new
// playbook built and published as v1, with the REAL TestRunner spawning the CLI; a change to
// client intake published as v2 while a v1 case stays on v1), and a finished case replayed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { draftContentHash, loadProject, type ExampleCase, type ExampleOutcome } from '@memwise/defs';
import { scriptedProvider, stubTools } from '@memwise/gateway';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { returnedComments } from '../src/prepare.ts';
import { sampleTools } from '../src/sample-tools.ts';
import pg from 'pg';
import { defaultTestRunner, dropAbandonedExampleDatabases } from '../src/test-runner.ts';
import type { Actor, Authoring, Kernel, TestRunner } from '../src/types.ts';
import { INTAKE_DIR } from './fixtures/exit-setup.ts';
import { step, workflow } from './fixtures/workflows.ts';
import { kernelDatabase, pgAvailable, putWorkflow } from './helpers.ts';

type PersonActor = Extract<Actor, { kind: 'person' }>;

const PROJECT = mkdtempSync(join(tmpdir(), 'mw-p3-project-'));
cpSync(INTAKE_DIR, PROJECT, { recursive: true });
const { project: loaded } = await loadProject(PROJECT);
const fullIntake = loaded.workflows['client-intake']!.examples.find((e) => e.name === 'full-intake')! as ExampleCase;
const FILL_VALUES = (fullIntake.submit!.fill as { values: Record<string, unknown> }).values;

/** A tiny new playbook: one person step that approves or declines a note. */
const TINY: Record<string, string> = {
  'workflows/tiny-approval/workflow.yaml': `workflow: tiny-approval
version: 1
title: Tiny approval
owner: manager
case: ./case.yaml
start: approve
steps:
  approve:
    on: { approved: end, declined: end }
    wait: { timeout: 7d → end }
`,
  'workflows/tiny-approval/case.yaml': `case: tiny_note
fields:
  note: Text
`,
  'workflows/tiny-approval/steps/approve.md': `---
title: Approve the note
performer: person
assignee: manager
strictness: strict
reads: [case.note]
outcomes: [approved, declined]
---
Read the note and approve it, or decline it.
`,
  'workflows/tiny-approval/examples/approved.yaml': `name: approved
case: { note: Buy more paper }
submit:
  approve: { outcome: approved }
expect:
  outcome: approved
  state: end
`,
};

let db: TestDatabase;
let kernel: Kernel;
let authoring: Authoring;
let staff: PersonActor, manager: PersonActor;
let adminUrl: string;
const runnerCalls: Parameters<TestRunner>[0][] = [];
const fakeOutcomes: ExampleOutcome[] = [{ name: 'fake-example', status: 'pass', differences: [] }];
let runner: TestRunner = async (req) => { runnerCalls.push(req); return fakeOutcomes; };

const stepRunOf = async (runId: string, state: string, status = 'waiting') => {
  for (let i = 0; i < 300; i++) {
    const run = await kernel.getRun(runId);
    if (run?.state === state) {
      const id = `${runId}/${run.enteredSeq}/${state}`;
      if ((await kernel.getStepRecord(id))?.status === status) return id;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${runId} never had ${state} ${status} (now ${JSON.stringify(await kernel.getRun(runId))})`);
};
const until = (runId: string, state: string, timeoutMs = 60_000) => kernel.waitForRun(runId, { until: (r) => r.state === state || r.status !== 'active', timeoutMs });

describe.skipIf(!pgAvailable)('Phase 3 kernel', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_p3');
    const admin = new URL(db.url);
    admin.pathname = '/postgres';
    adminUrl = admin.toString();
    kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: PROJECT,
      filesDir: mkdtempSync(join(tmpdir(), 'mw-p3-files-')),
      // The full-intake example's stubs and model script: a whole intake case runs here.
      tools: stubTools(sampleTools({ databaseUrl: db.url }), fullIntake.tools ?? {}),
      modelRoles: Object.fromEntries(Object.keys(fullIntake.model!).map((role) => [role, { provider: 'scripted', model: 's' }])),
      providers: [scriptedProvider(fullIntake.model!)],
      testRunner: (req) => runner(req),
      testDatabaseUrl: adminUrl,
      logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    authoring = kernel.authoring!;
    const add = async (name: string, roles: string[]) => kernel.people.actorFor((await kernel.people.create({ name, email: `${name}@acme.example`, roles })).id);
    staff = await add('sam', ['staff']);
    manager = await add('maya', ['manager']);
  }, 120_000);
  afterAll(async () => { await kernel?.shutdown(); await db?.drop(); });

  test('index records every live playbook as a version found on disk', async () => {
    const intake = await kernel.versions('client-intake');
    expect(intake).toEqual([expect.objectContaining({ workflowId: 'client-intake', version: 1, source: 'files', live: true, openCases: 0 })]);
    expect((await kernel.versions('create-playbook'))[0]).toMatchObject({ version: 1, live: true });
    // Indexing again changes nothing.
    await kernel.index();
    expect(await kernel.versions('client-intake')).toHaveLength(1);
  });

  test('vocabulary: bound tools with classes, entities, roles, model roles, value types, playbooks', async () => {
    const v = await authoring.vocabulary();
    expect(v.tools.find((t) => t.name === 'gst.validate_gstin')).toMatchObject({ effect: 'read' });
    expect(v.tools.find((t) => t.name === 'playbooks.write')).toMatchObject({ effect: 'draft', plugin: 'memwise' });
    expect(v.tools.some((t) => t.name === 'playbooks.publish_draft')).toBe(false);
    expect(v.tools.some((t) => t.name === 'domain.customer.create')).toBe(true);
    expect(v.entities.map((e) => e.name).sort()).toEqual(['Customer', 'Engagement']);
    expect(v.roles.map((r) => r.id).sort()).toEqual(['finance', 'manager', 'staff']);
    expect(v.modelRoles).toEqual(expect.arrayContaining(['checker', 'verifier']));
    expect(v.valueTypes).toEqual(expect.arrayContaining(['Money', 'List<T>', 'Customer']));
    expect(v.playbooks).toContainEqual({ id: 'client-intake', title: 'Client intake', version: 1, live: true });
  });

  let finishedCase = '';

  test('a whole intake case, then replayed as an example case by the real TestRunner (the CLI)', async () => {
    const { runId, caseId } = await kernel.startRun({ workflowId: 'client-intake', case: {}, by: staff.personId });
    const fill = await stepRunOf(runId, 'fill');
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: FILL_VALUES, by: staff })).toMatchObject({ applied: true });
    const verify = await stepRunOf(runId, 'verify');
    expect(await kernel.submitStep({ stepRunId: verify, outcome: 'approved', comment: 'Looks right.', by: manager })).toMatchObject({ applied: true });
    expect(await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 })).toMatchObject({ status: 'done', state: 'end' });
    finishedCase = caseId;

    const example = await kernel.caseToExample(caseId);
    expect(example.name).toBe(`case-${caseId.slice(-8).toLowerCase()}`);
    expect(example.startAt).toBeUndefined();
    expect(example.case).toEqual({});
    expect(example.submit).toEqual({
      fill: { outcome: 'submitted', values: FILL_VALUES },
      verify: { outcome: 'approved', comment: 'Looks right.' },
    });
    expect(example.tools).toMatchObject({ 'gst.validate_gstin': fullIntake.tools!['gst.validate_gstin'], 'intake.extract_fields': fullIntake.tools!['intake.extract_fields'] });
    // The journal keeps provider-safe names; the example has the dotted ones, turn by turn.
    expect(example.model!.checker).toEqual(fullIntake.model!.checker!);
    expect(example.model!.verifier).toEqual(fullIntake.model!.verifier!);
    expect(example.expect).toMatchObject({ outcome: 'submitted', state: 'end', effects: { 'domain.customer.create': 1 } });
    expect(example.expect.writes).toMatchObject({ client_name: 'Asha Rao', gstin_ok: true, legal_name: 'Acme Traders Private Limited' });
    expect(example.expect.writes!.customer).toBeUndefined(); // a new record's id differs in a replay

    // A correction starts at that step, with the case as it was then, and expects the outcome it should have had.
    const corrected = await kernel.caseToExample(caseId, { name: 'should-send-back', correction: { step: 'verify', outcome: 'sent_back', note: 'The GST certificate was blurred' } });
    expect(corrected).toMatchObject({
      name: 'should-send-back', startAt: 'verify', expect: { outcome: 'sent_back' },
      submit: { verify: { outcome: 'sent_back' } }, description: expect.stringContaining('The GST certificate was blurred'),
    });
    expect(corrected.case).toMatchObject({ client_name: 'Asha Rao', gstin_ok: true });
    expect(corrected.case.customer).toBeUndefined();

    // The replay, run out of process by the CLI on the project, takes the same path.
    const outcomes = await defaultTestRunner({ adminUrl })({ projectDir: PROJECT, workflowId: 'client-intake', extraExamples: [example] });
    expect(outcomes.find((o) => o.name === example.name), JSON.stringify(outcomes)).toEqual({ name: example.name, status: 'pass', differences: [] });
    expect(outcomes.filter((o) => o.status === 'fail')).toEqual([]);
  }, 300_000);

  test('example databases left behind by a killed run are dropped once they are older than the timeout', async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const old = `mw_example_${(Date.now() - 3_600_000).toString(36)}_dead`;
      const fresh = `mw_example_${Date.now().toString(36)}_live`;
      for (const name of [old, fresh]) await client.query(`create database ${name}`);
      expect(await dropAbandonedExampleDatabases(adminUrl, 600_000)).toEqual([old]);
      const { rows } = await client.query(`select datname from pg_database where datname = any($1::text[])`, [[old, fresh]]);
      expect(rows.map((r) => r.datname)).toEqual([fresh]);
      await client.query(`drop database ${fresh}`);
    } finally {
      await client.end();
    }
  });

  let v1Run = { runId: '', caseId: '', hash: '' };

  test('conversation steps: the inbox shows them; only their chat answers, for the assignee role', async () => {
    // An intake case on v1, waiting in fill: a person step refuses an answer from a chat.
    const started = await kernel.startRun({ workflowId: 'client-intake', case: {}, by: staff.personId });
    const fill = await stepRunOf(started.runId, 'fill');
    v1Run = { ...started, hash: (await kernel.getRun(started.runId))!.workflowHash };
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: FILL_VALUES, by: staff, via: { chatId: 'chat-x' } }))
      .toMatchObject({ applied: false, status: 'forbidden' });

    const { runId, caseId, stepRunId } = await authoring.startBuild({ request: 'A tiny approval for notes', title: 'Tiny approval' }, staff);
    expect(stepRunId).toBe(`${runId}/0/interview`);
    expect(await kernel.getCase(caseId)).toMatchObject({ values: { request: { value: 'A tiny approval for notes' }, title: { value: 'Tiny approval' } } });
    expect(await kernel.inbox(staff)).toContainEqual(expect.objectContaining({ kind: 'conversation', stepRunId, runId, stepId: 'interview', assignee: 'staff' }));
    expect((await kernel.inbox(manager)).some((i) => i.kind === 'conversation')).toBe(false);
    expect(await kernel.sendEvent(runId, 'drafted', { idemKey: 'x' })).toMatchObject({ sent: false, reason: 'use_submit' });

    const draft = await authoring.createDraft({ workflowId: 'tiny-approval', title: 'Tiny approval', kind: 'create', runId }, staff);
    const files = Object.entries(TINY).map(([path, content]) => ({ path, content }));
    const { edit, diagnostics } = await authoring.write({ draftId: draft.id, files, summary: 'The tiny approval playbook', via: 'chat', chatId: 'chat-1' }, staff);
    expect(edit.status).toBe('pending');
    expect(diagnostics).toEqual([]);
    expect(await authoring.keepEdit(draft.id, edit.id, staff)).toEqual({ applied: true });
    expect(await authoring.read({ draftId: draft.id })).toEqual({ files: expect.arrayContaining(['workflows/tiny-approval/steps/approve.md', 'domain/roles.yaml']) });
    await expect(authoring.read({ workflowId: '../../..' })).rejects.toThrow(/not a playbook id/);

    const values = { playbook: 'tiny-approval', title: 'Tiny approval', draft: draft.id, summary: 'A manager approves or declines a note.' };
    expect(await kernel.submitStep({ stepRunId, outcome: 'drafted', values, by: staff })).toMatchObject({ applied: false, status: 'forbidden' });
    expect(await kernel.submitStep({ stepRunId, outcome: 'drafted', values, by: manager, via: { chatId: 'chat-1' } })).toMatchObject({ status: 'forbidden' });
    const { summary: _s, ...noSummary } = values;
    expect(await kernel.submitStep({ stepRunId, outcome: 'drafted', values: noSummary, by: staff, via: { chatId: 'chat-1' } }))
      .toMatchObject({ status: 'invalid', errors: { summary: ['required'] } });

    // The real TestRunner checks this draft: the CLI runs its example case on a throwaway database.
    runner = defaultTestRunner({ adminUrl });
    try {
      expect(await kernel.submitStep({ stepRunId, outcome: 'drafted', values, by: staff, via: { chatId: 'chat-1', rationale: 'They confirmed the steps.' } }))
        .toEqual({ applied: true, status: 'applied' });
      const review = await stepRunOf(runId, 'review');
      const c = (await kernel.getCase(caseId))!;
      expect(c.values.summary!.provenance).toEqual({ kind: 'judgement', at: expect.any(String), stepRunId, rationale: 'They confirmed the steps.', chatId: 'chat-1', by: staff.personId });
      expect(c.values.checked_hash!.value).toBe(await draftContentHash(PROJECT, draft.id));
      expect(c.values.errors!.value).toBe(0);
      expect(c.values.examples_failed!.value).toBe(0);
      const report = (await authoring.getDraft(draft.id))!.report!;
      expect(report).toMatchObject({ outcome: 'passed', errors: 0, examples: [{ name: 'approved', status: 'pass' }], pastCases: [] });
      expect(report.impact).toMatchObject({ workflowId: 'tiny-approval', newVersion: 1, openCases: { total: 0 } });
      expect(c.values.report!.value).toBe(report.summary);
      expect(await kernel.inbox(manager)).toContainEqual(expect.objectContaining({ kind: 'decision', stepRunId: review }));

      expect(await kernel.submitStep({ stepRunId: review, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
      expect(await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 })).toMatchObject({ status: 'done', state: 'end' });
    } finally {
      runner = async (req) => { runnerCalls.push(req); return fakeOutcomes; };
    }
    expect((await kernel.getCase(caseId))!.values.version!.value).toBe(1);
    const versions = await kernel.versions('tiny-approval');
    expect(versions).toEqual([expect.objectContaining({
      version: 1, source: 'app', publishedBy: manager.personId, draftId: draft.id, runId, live: true, openCases: 0,
    })]);
    expect((await authoring.getDraft(draft.id))!.meta).toMatchObject({ status: 'published', publishedVersion: 1 });
    expect(existsSync(join(PROJECT, 'workflows/tiny-approval/steps/approve.md'))).toBe(true);

    // Live and runnable.
    const tiny = await kernel.startRun({ workflowId: 'tiny-approval', case: { note: 'Buy more paper' } });
    const approve = await stepRunOf(tiny.runId, 'approve');
    expect(await kernel.submitStep({ stepRunId: approve, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    expect(await kernel.waitForRun(tiny.runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 })).toMatchObject({ status: 'done' });
  }, 300_000);

  test('a change to client intake: sent back with a comment, then published as v2; the v1 case stays on v1', async () => {
    const { runId, caseId, stepRunId } = await authoring.startBuild({ workflowId: 'client-intake', request: 'Say what to look for in the flags' }, staff);
    expect(stepRunId).toBe(`${runId}/0/edit`);
    const c0 = (await kernel.getCase(caseId))!.values;
    const draftId = c0.draft!.value as string;
    expect(c0.playbook!.value).toBe('client-intake');
    const meta = (await authoring.getDraft(draftId))!.meta;
    expect(meta).toMatchObject({ kind: 'change', baseVersion: 1, runId, workflowId: 'client-intake' });

    const verifyPath = 'workflows/client-intake/steps/verify.md';
    const before = (await authoring.read({ draftId, path: verifyPath })) as { content: string };
    const after = `${before.content.trimEnd()}\nLook hardest at flags that name the PAN card: a mismatch there is the usual reason to send it back.\n`;
    await authoring.write({ draftId, files: [{ path: verifyPath, content: after }], summary: 'Verify: what to look for', via: 'chat', chatId: 'chat-2' }, staff);
    expect((await authoring.diff(draftId)).structure).toMatchObject({ steps: { verify: { change: 'changed', parts: ['instructions'] } }, version: { from: 1, to: 2 } });

    runnerCalls.length = 0;
    expect(await kernel.submitStep({ stepRunId, outcome: 'drafted', values: { summary: 'Verify says what to look for.' }, by: staff, via: { chatId: 'chat-2' } }))
      .toMatchObject({ applied: true });
    const review = await stepRunOf(runId, 'review');
    // The check replayed the finished intake case (a past case of the live version) beside the examples.
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.extraExamples?.map((e) => e.name)).toEqual([`past-${finishedCase.slice(-8).toLowerCase()}`]);
    const report = (await authoring.getDraft(draftId))!.report!;
    expect(report.outcome).toBe('passed');
    expect(report.pastCases).toEqual([expect.objectContaining({ caseId: finishedCase, status: 'skip', livePath: ['fill', 'check', 'verify', 'onboard', 'end'] })]);
    expect(report.impact).toMatchObject({ liveVersion: 1, newVersion: 2, openCases: { total: 1, byState: { fill: 1 } }, newTools: [] });
    expect(report.impact!.summary.join(' ')).toContain('1 case still running (1 in fill) keeps the version it started on.');

    // Sent back: the comment comes back to the chat.
    expect(await kernel.submitStep({ stepRunId: review, outcome: 'changes_requested', comment: 'Also say what to do on a GSTIN flag.', by: manager }))
      .toMatchObject({ applied: true });
    const edit2 = await stepRunOf(runId, 'edit');
    expect(edit2).not.toBe(stepRunId);
    expect(await returnedComments(kernel.pool, edit2)).toEqual([expect.objectContaining({
      stepId: 'review', outcome: 'changes_requested', comment: 'Also say what to do on a GSTIN flag.', by: manager.personId, who: 'maya' })]);
    expect(await kernel.inbox(staff)).toContainEqual(expect.objectContaining({ kind: 'conversation', stepRunId: edit2 }));

    expect(await kernel.submitStep({ stepRunId: edit2, outcome: 'drafted', values: { summary: 'Verify says what to look for, PAN and GSTIN.' }, by: staff, via: { chatId: 'chat-2' } }))
      .toMatchObject({ applied: true });
    const review2 = await stepRunOf(runId, 'review');
    expect(await kernel.submitStep({ stepRunId: review2, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    expect(await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 })).toMatchObject({ status: 'done', state: 'end' });

    const versions = await kernel.versions('client-intake');
    expect(versions.map((v) => [v.version, v.source, v.live, v.openCases])).toEqual([[2, 'app', true, 0], [1, 'files', false, 1]]);
    expect(versions[0]).toMatchObject({ publishedBy: manager.personId, draftId, runId });
    expect(readFileSync(join(PROJECT, verifyPath), 'utf8')).toBe(after);

    // The case started on v1 stays on v1 and finishes there; a new case starts on v2.
    expect((await kernel.getRun(v1Run.runId))!.workflowHash).toBe(v1Run.hash);
    expect(versions[1]!.hash).toBe(v1Run.hash);
    const fill = await stepRunOf(v1Run.runId, 'fill');
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: FILL_VALUES, by: staff })).toMatchObject({ applied: true });
    const verify = await stepRunOf(v1Run.runId, 'verify');
    expect((await kernel.getStepRecord(verify))!.workflowHash).toBe(v1Run.hash);
    const fresh = await kernel.startRun({ workflowId: 'client-intake', case: {} });
    expect((await kernel.getRun(fresh.runId))!).toMatchObject({ workflowVersion: 2, workflowHash: versions[0]!.hash });
  }, 300_000);

  let exampleDraft = '';
  test('a past case saved as an example in a change draft', async () => {
    const r = await authoring.exampleFromCase({ caseId: finishedCase, name: 'Unreadable GST certificate', correction: { step: 'verify', outcome: 'sent_back', note: 'blurred certificate' } }, manager);
    // The file is a slug of the name; the name stays as typed inside it.
    expect(r.path).toBe('workflows/client-intake/examples/unreadable-gst-certificate.yaml');
    expect(r.example.name).toBe('Unreadable GST certificate');
    const text = (await authoring.read({ draftId: r.draftId, path: r.path })) as { content: string };
    expect(text.content).toContain('name: Unreadable GST certificate');
    expect(text.content).toContain('startAt: verify');
    expect(text.content).toContain('outcome: sent_back');
    const d = (await authoring.getDraft(r.draftId))!;
    expect(d.meta).toMatchObject({ kind: 'change', workflowId: 'client-intake' });
    expect(d.edits).toEqual([expect.objectContaining({ via: 'editor', status: 'kept', by: manager.personId })]);
    // The draft loads, with the new example case in it.
    expect(await authoring.quickCheck(r.draftId)).toEqual([]);

    // Saved again under a name with the same slug: a new file beside it, not over it.
    const again = await authoring.exampleFromCase({ caseId: finishedCase, name: 'unreadable GST  certificate!', draftId: r.draftId }, manager);
    expect(again.path).toBe('workflows/client-intake/examples/unreadable-gst-certificate-2.yaml');
    expect(((await authoring.read({ draftId: r.draftId, path: r.path })) as { content: string }).content).toBe(text.content);
    exampleDraft = r.draftId;
  }, 60_000);

  test('a check replays recent finished cases, also those that finished on an earlier version', async () => {
    // client-intake is at v2 now; the finished intake case ran on v1.
    const versions = await kernel.versions('client-intake');
    expect(versions[0]).toMatchObject({ version: 2, live: true });
    const { rows } = await kernel.pool.query(`select workflow_hash from mw.runs where case_id = $1`, [finishedCase]);
    expect(rows[0]!.workflow_hash).toBe(versions.find((v) => v.version === 1)!.hash);
    runnerCalls.length = 0;
    const report = await authoring.check(exampleDraft);
    const past = `past-${finishedCase.slice(-8).toLowerCase()}`;
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]!.extraExamples?.map((e) => e.name)).toEqual([past]);
    expect(report.pastCases).toEqual([expect.objectContaining({ caseId: finishedCase, livePath: ['fill', 'check', 'verify', 'onboard', 'end'] })]);
    // The replays are not reported as the playbook's own example cases.
    expect(report.examples.map((e) => e.name)).not.toContain(past);
  }, 120_000);

  test('submitDraft starts change-playbook at its check; a stale publish is refused', async () => {
    const draft = await authoring.createDraft({ workflowId: 'tiny-approval', title: 'Say please' }, staff);
    expect(draft).toMatchObject({ kind: 'change', baseVersion: 1 });
    const path = 'workflows/tiny-approval/steps/approve.md';
    await authoring.write({ draftId: draft.id, files: [{ path, content: `${TINY[path]}Say please when you decline.\n` }], summary: 'Polite declines', via: 'editor' }, staff);
    const report = await authoring.check(draft.id);
    expect(report.outcome).toBe('passed');
    await authoring.write({ draftId: draft.id, files: [{ path, content: `${TINY[path]}Say thank you.\n` }], summary: 'Changed again', via: 'editor' }, staff);
    expect(await authoring.publish(draft.id, { hash: report.hash, source: 'cli' })).toMatchObject({ status: 'stale' });

    const { runId, caseId } = await authoring.submitDraft(draft.id, staff);
    const review = await stepRunOf(runId, 'review');
    const values = (await kernel.getCase(caseId))!.values;
    expect(values).toMatchObject({ draft: { value: draft.id }, playbook: { value: 'tiny-approval' }, title: { value: 'Say please' } });
    // The reviewer reads the summary: steps by their titles, no ids in code formatting.
    expect(values.summary!.value).toBe('Version 1 → 2. Step “Approve the note”: instructions changed.');
    expect((await kernel.getTransitions(runId))[0]).toMatchObject({ from: 'check', to: 'review' });
    expect(review).toBe(`${runId}/1/review`);
  }, 120_000);

  test('a conversation step gets reminders and times out like a person step', async () => {
    const wf = workflow('chat-timer', 'talk', {
      talk: { on: { drafted: 'end' }, wait: { remindMs: 300, timeout: { afterMs: 2500, target: 'end' } }, step: 'talk' },
    }, [step('talk', 'agent', { engine: 'open', strictness: 'open', assignee: 'staff', outcomes: ['drafted'], title: 'Talk it through' })]);
    await putWorkflow(db, wf);
    const { runId } = await kernel.startRun({ workflowId: 'chat-timer', case: {} });
    const talk = await stepRunOf(runId, 'talk');
    let reminder;
    for (let i = 0; i < 100 && !reminder; i++) {
      reminder = (await kernel.inbox(staff)).find((x) => x.kind === 'reminder' && x.runId === runId);
      if (!reminder) await new Promise((r) => setTimeout(r, 100));
    }
    expect(reminder).toMatchObject({ stepRunId: talk, text: expect.stringContaining('Talk it through') });
    expect(await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 })).toMatchObject({ status: 'done', state: 'end' });
    expect((await kernel.getStepRecord(talk))!.status).toBe('completed');
    expect((await kernel.inbox(staff)).some((x) => x.kind === 'conversation' && x.stepRunId === talk)).toBe(false);
  }, 60_000);

  test('a live file edited outside review without a new version is warned about and recorded', async () => {
    const file = join(PROJECT, 'workflows/tiny-approval/steps/approve.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}Edited by hand.\n`);
    const diagnostics = await kernel.index();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'version-not-bumped', file: 'workflows/tiny-approval/workflow.yaml', message: expect.stringContaining('without a new version'),
    }));
    const versions = await kernel.versions('tiny-approval');
    expect(versions.map((v) => [v.version, v.source, v.live])).toEqual([[1, 'files', true], [1, 'app', false]]);
    expect(diagnostics.some((d) => d.code === 'version-not-bumped' && d.file?.includes('client-intake'))).toBe(false);
  }, 60_000);
});
