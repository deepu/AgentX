// Phase 2 kernel API (docs/memwise/19-phase-2-interfaces.md §4-§8) on examples/intake, with
// scripted models and the REAL quarantined extractor: staff fill the form, the check runs,
// the manager decides in the inbox, onboard writes Customer; plus send-back, effect approvals,
// explain, reminders, hidden fields and change notifications.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { TestDatabase } from '@memwise/db';
import { loadProject, type ExampleCase, type ScriptedTurn } from '@memwise/defs';
import { modelToolName, scriptedProvider, type ModelProvider } from '@memwise/gateway';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_RECORDED } from '../src/explain.ts';
import { createKernel } from '../src/kernel.ts';
import { sampleTools } from '../src/sample-tools.ts';
import { StartRunError, startFields } from '../src/start.ts';
import type { Actor, Kernel, KernelChange } from '../src/types.ts';
import { INTAKE_DIR } from './fixtures/exit-setup.ts';
import { step, workflow } from './fixtures/workflows.ts';
import { kernelDatabase, pgAvailable, putWorkflow } from './helpers.ts';

type PersonActor = Extract<Actor, { kind: 'person' }>;

// A copy of the intake project whose case has one field only finance may see.
const PROJECT = mkdtempSync(join(tmpdir(), 'mw-p2-project-'));
cpSync(INTAKE_DIR, PROJECT, { recursive: true });
const CASE_FILE = join(PROJECT, 'workflows/client-intake/case.yaml');
writeFileSync(CASE_FILE, readFileSync(CASE_FILE, 'utf8').replace('types:', '  bank_account:    { type: Text, access: [finance] }\ntypes:'));

const { project } = await loadProject(PROJECT);
const intake = project.workflows['client-intake']!;
const exampleOf = (name: string) => intake.examples.find((e) => e.name === name)! as ExampleCase;
const clean = exampleOf('clean-application');
const mismatch = exampleOf('pan-mismatch');

/** The checker and verifier scripts of an example, chosen by the PAN in the step's prompt. */
function switchingProvider(): ModelProvider {
  const byPan = (prompt: string) => (prompt.includes('AAACM9999Z') ? mismatch : clean);
  const extractor: ScriptedTurn[] = [{ text: '{"pan": "AAACA1234A", "gstin": "29AAACA1234A1Z5", "legal_name": null}' }];
  return {
    id: 'scripted',
    async complete(model, request, options) {
      if (options.role === 'extractor') return scriptedProvider({ extractor }).complete(model, request, options);
      const prompt = options.role === 'verifier' ? JSON.stringify(request.messages) : request.systemPrompt;
      return scriptedProvider(byPan(prompt).model!).complete(model, request, options);
    },
  };
}

/** The explainer: grounded with real refs, unless the question asks it to invent something. */
const explainer: ModelProvider = {
  id: 'explain-test',
  async complete(model, request) {
    const text = JSON.stringify(request.messages);
    const invent = text.includes('invent');
    const key = /\[(tool:gst\.validate_gstin:[^\]]+)\]/.exec(text)?.[1] ?? 'missing';
    const args = invent
      ? { answer: 'The client has a criminal record.', cites: [{ kind: 'journal', ref: 'police:lookup', label: 'made up' }], grounded: true }
      : { answer: 'The GSTIN was valid in the registry and nothing was flagged.', cites: [
          { kind: 'journal', ref: key, label: 'GST lookup' }, { kind: 'output', ref: 'flags', label: 'flags' },
          { kind: 'output', ref: 'not_a_field', label: 'dropped' }], grounded: true };
    return {
      role: 'assistant', api: 'anthropic-messages', provider: 'explain-test', model, timestamp: 0, stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'toolCall', id: 'call_explain', name: modelToolName('explain.answer'), arguments: args }],
    } satisfies AssistantMessage;
  },
};

let db: TestDatabase;
let kernel: Kernel;
let staff: PersonActor, manager: PersonActor, finance: PersonActor;
const changes: KernelChange[] = [];
const DOCS = { pan: 'PERMANENT ACCOUNT NUMBER\nAAACA1234A\nASHA RAO\n', gst: 'GST REGISTRATION CERTIFICATE\nGSTIN 29AAACA1234A1Z5\nAcme Traders Private Limited\n' };

const stepRun = (runId: string, state: string) => kernel.waitForRun(runId, { until: (r) => r.state === state, timeoutMs: 30_000 })
  .then((r) => `${runId}/${r.enteredSeq}/${state}`);
const waitingStep = async (runId: string, state: string) => {
  const id = await stepRun(runId, state);
  for (let i = 0; i < 100; i++) {
    if ((await kernel.getStepRecord(id))?.status === 'waiting') return id;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${id} never waited`);
};

describe.skipIf(!pgAvailable)('Phase 2 kernel API', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_p2');
    kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: PROJECT,
      filesDir: mkdtempSync(join(tmpdir(), 'mw-p2-files-')),
      // The sample registry knows both GSTINs; the kernel binds the real extractor.
      tools: sampleTools({ databaseUrl: db.url, stubExtractor: false }),
      modelRoles: {
        checker: { provider: 'scripted', model: 's' }, verifier: { provider: 'scripted', model: 's' },
        extractor: { provider: 'scripted', model: 's' }, explainer: { provider: 'explain-test', model: 'e' },
      },
      providers: [switchingProvider(), explainer],
      logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    const add = async (name: string, roles: string[]) => kernel.people.actorFor((await kernel.people.create({ name, email: `${name}@acme.example`, roles })).id);
    staff = await add('sam', ['staff']);
    manager = await add('maya', ['manager']);
    finance = await add('farah', ['finance', 'staff']);
    kernel.onChange((c) => changes.push(c));
  }, 120_000);
  afterAll(async () => { await kernel?.shutdown(); await db?.drop(); });

  let fullRun = { runId: '', caseId: '' };

  test('a full intake: staff fill, the check reads the documents, the manager approves, onboard writes Customer', async () => {
    const pan = await kernel.saveFile({ name: 'pan-card.pdf', mime: 'text/plain', data: new TextEncoder().encode(DOCS.pan) }, staff);
    const gst = await kernel.saveFile({ name: 'gst-certificate.pdf', mime: 'text/plain', data: new TextEncoder().encode(DOCS.gst) }, staff);
    expect(pan.id).toMatch(/^file_/);
    expect((await kernel.readFile(pan.id, staff))?.meta.sha256).toBe(pan.sha256);

    const { runId, caseId } = await kernel.startRun({ workflowId: 'client-intake', case: {}, by: staff.personId });
    fullRun = { runId, caseId };
    const fill = await waitingStep(runId, 'fill');

    const staffInbox = await kernel.inbox(staff);
    expect(staffInbox).toContainEqual(expect.objectContaining({ kind: 'input', stepRunId: fill, stepId: 'fill', assignee: 'staff' }));
    expect((await kernel.inbox(manager)).some((i) => i.kind === 'input' && i.stepRunId === fill)).toBe(false);

    const values = {
      client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', pan: 'AAACA1234A', gstin: '29AAACA1234A1Z5',
      annual_turnover: { amount: 42000000, currency: 'INR' }, documents: [pan, gst], bank_account: '0012 3456 7890',
    };
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values, by: manager })).toMatchObject({ applied: false, status: 'forbidden' });
    const invalid = await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: { ...values, pan: 'nope', colour: 'red' }, by: staff });
    expect(invalid).toMatchObject({ applied: false, status: 'invalid' });
    expect(Object.keys(invalid.errors!).sort()).toEqual(['bank_account', 'colour', 'pan']); // fill does not write bank_account
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'done', values, by: staff })).toMatchObject({ status: 'unknown-outcome' });
    const { bank_account: _b, ...fillValues } = values;
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: fillValues, by: staff })).toEqual({ applied: true, status: 'applied' });
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: fillValues, by: staff })).toMatchObject({ applied: false, status: 'stale' });

    const verify = await waitingStep(runId, 'verify');
    const c = (await kernel.getCase(caseId))!;
    expect(c.values.client_name!.provenance).toMatchObject({ kind: 'person', by: staff.personId, stepRunId: fill });
    expect((await kernel.getCaseView(caseId, staff))!.stepRuns.find((s) => s.stepRunId === fill)).toMatchObject({ decidedBy: staff.personId, status: 'completed', outcome: 'submitted' });

    // The check read the uploaded documents through the quarantined extractor: tainted.
    const check = (await kernel.getStepRecord(`${runId}/1/check`))!;
    const extract = check.journal.find((j) => j.kind === 'tool' && j.name === 'intake.extract_fields')!;
    expect((extract.response as any).result.fields, JSON.stringify(extract.response)).toContainEqual({ name: 'pan', value: 'AAACA1234A', document: 'pan-card.pdf' });
    expect(check.tainted).toBe(true);
    const view = (await kernel.getCaseView(caseId, staff))!;
    expect(view.values.flags).toMatchObject({ value: [], tainted: true });
    expect(view.values.legal_name!.tainted).toBeUndefined();

    expect((await kernel.inbox(manager))).toContainEqual(expect.objectContaining({ kind: 'decision', stepRunId: verify }));
    expect((await kernel.inbox(staff)).some((i) => i.kind === 'decision')).toBe(false);
    expect(await kernel.submitStep({ stepRunId: verify, outcome: 'approved', by: staff })).toMatchObject({ status: 'forbidden' });
    expect(await kernel.submitStep({ stepRunId: verify, outcome: 'approved', by: manager })).toMatchObject({ applied: true });

    const done = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 });
    expect(done).toMatchObject({ status: 'done', state: 'end' });
    const customerId = (await kernel.getCase(caseId))!.values.customer!.value as string;
    const rows = await kernel.listEntities('Customer', staff);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: customerId, values: { name: 'Asha Rao', gstin: '29AAACA1234A1Z5', bank_account: null }, hidden: ['bank_account'] });
    expect((await kernel.listEntities('customer', finance))[0]!.hidden).toEqual([]);

    const final = (await kernel.getCaseView(caseId, staff))!;
    expect(final.path).toEqual(['fill', 'check', 'verify', 'onboard', 'end']);
    expect(final.summary).toMatchObject({ status: 'done', state: 'end' });
    const live = await kernel.liveCounts('client-intake');
    for (const edge of ['fill>check', 'check>verify', 'verify>onboard', 'onboard>end']) expect(live.edges[edge]).toBeGreaterThanOrEqual(1);
    expect((await kernel.listCases({ workflowId: 'client-intake' }, staff)).map((s) => s.caseId)).toContain(caseId);
    // The run's changes reached onChange.
    expect(changes.some((ch) => ch.kind === 'run' && ch.runId === runId)).toBe(true);
    expect(changes.some((ch) => ch.kind === 'inbox')).toBe(true);
  }, 120_000);

  test('hidden case fields are nulled for roles without access', async () => {
    const { caseId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'verify', case: { client_name: 'Ravi', bank_account: '9999' } });
    const asStaff = (await kernel.getCaseView(caseId, staff))!;
    expect(asStaff.values.bank_account).toMatchObject({ value: null, hidden: true });
    expect(asStaff.summary.values.bank_account).toBeUndefined();
    expect((await kernel.getCaseView(caseId, finance))!.values.bank_account).toMatchObject({ value: '9999' });
    expect((await kernel.getCaseView(caseId, finance))!.values.bank_account!.hidden).toBeUndefined();
  }, 60_000);

  test('a send-back: the comment is repair context for the next check', async () => {
    const { runId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'check', case: clean.case });
    const verify = await waitingStep(runId, 'verify');
    expect(await kernel.submitStep({ stepRunId: verify, outcome: 'sent_back', comment: 'Please upload a clearer GST certificate.', by: manager })).toMatchObject({ applied: true });
    const fill = await waitingStep(runId, 'fill');
    expect((await kernel.getStepRecord(verify))!.status).toBe('completed');
    expect((await kernel.pool.query('select comment, decided_by from mw.step_runs where id = $1', [verify])).rows[0])
      .toEqual({ comment: 'Please upload a clearer GST certificate.', decided_by: manager.personId });
    expect(await kernel.submitStep({ stepRunId: fill, outcome: 'submitted', values: { pan: 'AAACA1234A' }, by: staff })).toMatchObject({ applied: true });
    const verify2 = await waitingStep(runId, 'verify');
    expect(verify2).not.toBe(verify);
    const check2 = (await kernel.pool.query(`select id from mw.step_runs where run_id = $1 and step_id = 'check' order by started_at desc limit 1`, [runId])).rows[0].id;
    const record = (await kernel.getStepRecord(check2))!;
    expect(record.attempt).toBe(2);
    expect(record.context!.priorAttempts).toContainEqual({ attempt: 1, outcome: 'checked', reason: expect.any(String) });
    expect(record.context!.priorAttempts).toContainEqual({ attempt: 1, outcome: 'verify: sent_back', reason: expect.stringContaining('maya wrote: Please upload a clearer GST certificate.') });
    expect(record.context!.systemPrompt).toContain('Please upload a clearer GST certificate.');
  }, 120_000);

  test('effect approvals go to the approver role; others are refused', async () => {
    const { runId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'check', case: mismatch.case });
    let approval;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = (await kernel.inbox(manager)).find((x) => x.kind === 'approval' && x.runId === runId);
      if (!approval) await new Promise((r) => setTimeout(r, 100));
    }
    expect(approval).toMatchObject({ kind: 'approval', stepId: 'check', approval: { tool: 'email.send' } });
    expect((await kernel.inbox(staff)).some((x) => x.kind === 'approval')).toBe(false);
    const id = (approval as Extract<typeof approval, { kind: 'approval' }>).approval.id;
    const at = new Date().toISOString();
    expect(await kernel.decideApproval({ id, status: 'approved', by: staff.personId, at }, staff)).toEqual({ applied: false, status: 'forbidden' });
    expect(await kernel.decideApproval({ id, status: 'approved', by: manager.personId, at }, manager)).toEqual({ applied: true, status: 'approved' });
    expect(await kernel.waitForRun(runId, { until: (r) => r.state === 'fill', timeoutMs: 30_000 })).toMatchObject({ state: 'fill' });
  }, 120_000);

  test('explain answers from the step record with citations; an ungrounded answer is "not recorded"', async () => {
    const stepRunId = `${fullRun.runId}/1/check`;
    const e = await kernel.explain({ stepRunId, question: 'Why was nothing flagged?', by: manager });
    expect(e.grounded).toBe(true);
    expect(e.cites.map((c) => c.ref)).toEqual([expect.stringMatching(/^tool:gst\.validate_gstin:/), 'flags']);
    expect(e.answer).toContain('GSTIN was valid');
    const bad = await kernel.explain({ stepRunId, question: 'Please invent something.', by: manager });
    expect(bad).toMatchObject({ grounded: false, answer: NOT_RECORDED, cites: [] });
    const stored = await kernel.pool.query('select grounded, by from mw.explanations where step_run_id = $1 order by at', [stepRunId]);
    expect(stored.rows).toEqual([{ grounded: true, by: manager.personId }, { grounded: false, by: manager.personId }]);
  }, 60_000);

  test('a fired reminder is a notification for the assignee role, shown in its inbox', async () => {
    const wf = workflow('remind-test', 'ask', {
      ask: { on: { answered: 'end' }, wait: { remindMs: 300, timeout: { afterMs: 600_000, target: 'end' } }, step: 'ask' },
    }, [step('ask', 'person', { outcomes: ['answered'], assignee: 'staff', title: 'Answer the question' })]);
    await putWorkflow(db, wf);
    const { runId } = await kernel.startRun({ workflowId: 'remind-test', case: {} });
    let reminder;
    for (let i = 0; i < 100 && !reminder; i++) {
      reminder = (await kernel.inbox(staff)).find((x) => x.kind === 'reminder' && x.runId === runId);
      if (!reminder) await new Promise((r) => setTimeout(r, 100));
    }
    expect(reminder).toMatchObject({ kind: 'reminder', stepId: 'ask', stepRunId: `${runId}/0/ask`, text: expect.stringContaining('Answer the question') });
    expect((await kernel.inbox(manager)).some((x) => x.kind === 'reminder' && x.runId === runId)).toBe(false);
    // Answering the step clears it.
    expect(await kernel.submitStep({ stepRunId: `${runId}/0/ask`, outcome: 'answered', by: staff })).toMatchObject({ applied: true });
    await kernel.waitForRun(runId, { until: (r) => r.status === 'done', timeoutMs: 15_000 });
    expect((await kernel.inbox(staff)).some((x) => x.kind === 'reminder' && x.runId === runId)).toBe(false);
  }, 60_000);

  test('project, effective policy and roles come from the indexed definitions', async () => {
    const { project: p } = await kernel.project();
    expect(Object.keys(p.roles).sort()).toEqual(['finance', 'manager', 'staff']);
    expect((await kernel.people.roles()).map((r) => r.id)).toEqual(['finance', 'manager', 'staff']);
    const policy = await kernel.effectivePolicy('client-intake', 'onboard');
    expect(policy.violations).toEqual([]);
    expect(policy.effective.effects.irreversible.value).toBe('deny');
  });
  // ---------------------------------------------------------------- review findings

  test('an outside event cannot decide a person step; a wait state needs its role or the owner\'s', async () => {
    const wf = {
      ...workflow('gate', 'ask', {
        ask: { on: { approved: 'held' }, step: 'ask' },
        held: { on: { resolved: 'end' }, assignee: 'manager' },
      }, [step('ask', 'person', { outcomes: ['approved'], assignee: 'manager' })]),
      owner: 'finance',
    };
    await putWorkflow(db, wf);
    const { runId } = await kernel.startRun({ workflowId: 'gate', case: {} });
    const ask = await waitingStep(runId, 'ask');
    // Staff sending `approved` must not skip the manager, and neither may anyone else, nor an internal caller.
    for (const [key, by] of [['e1', staff], ['e2', manager], ['e3', undefined]] as const) {
      expect(await kernel.sendEvent(runId, 'approved', { idemKey: key, ...(by ? { by } : {}) }))
        .toEqual({ sent: false, reason: 'use_submit', message: expect.any(String) });
    }
    expect((await kernel.getRun(runId))!).toMatchObject({ state: 'ask', seq: 0 });
    expect(await kernel.submitStep({ stepRunId: ask, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    await kernel.waitForRun(runId, { until: (r) => r.state === 'held', timeoutMs: 15_000 });

    expect(await kernel.sendEvent(runId, 'resolved', { idemKey: 'r1', by: staff })).toMatchObject({ sent: false, reason: 'forbidden' });
    // The owner's role may decide too; the sender is recorded, whatever the event claims.
    expect(await kernel.sendEvent(runId, { type: 'resolved', by: 'someone-else' }, { idemKey: 'r2', by: finance })).toEqual({ sent: true });
    await kernel.waitForRun(runId, { until: (r) => r.status === 'done', timeoutMs: 15_000 });
    expect((await kernel.getTransitions(runId)).at(-1)).toMatchObject({ from: 'held', to: 'end', accepted: true, event: { type: 'resolved', by: finance.personId } });
  }, 60_000);

  test('startRun takes only the fields a person enters at the start, each of its type', async () => {
    expect(startFields(intake)).toEqual(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents']);
    const before = (await kernel.pool.query('select count(*)::int as n from mw.runs')).rows[0].n;
    const err = await kernel.startRun({
      workflowId: 'client-intake', by: staff.personId,
      case: { client_name: 'Asha Rao', pan: 'nope', colour: 'red', flags: [], gstin_ok: true, customer: 'cus_1', bank_account: '1' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StartRunError);
    expect(err.status).toBe('invalid');
    expect(Object.keys(err.errors).sort()).toEqual(['bank_account', 'colour', 'customer', 'flags', 'gstin_ok', 'pan']);
    expect(err.errors.colour).toEqual(['not a field of this case']);
    expect(err.errors.flags).toEqual(['filled in by a step, not when the case starts']);
    expect((await kernel.pool.query('select count(*)::int as n from mw.runs')).rows[0].n).toBe(before);

    const { caseId } = await kernel.startRun({ workflowId: 'client-intake', case: { client_name: 'Asha Rao', pan: 'AAACA1234A', gstin: null }, by: staff.personId });
    const values = (await kernel.getCase(caseId))!.values;
    expect(Object.keys(values).sort()).toEqual(['client_name', 'pan']);
    expect(values.pan).toMatchObject({ value: 'AAACA1234A', provenance: { kind: 'input', by: staff.personId } });
  }, 60_000);

  // Last: it edits the project's definitions.
  test('re-indexing a changed entity type rebuilds its domain tools', async () => {
    const edit = (rel: string, from: string, to: string) => {
      const file = join(PROJECT, rel);
      const text = readFileSync(file, 'utf8');
      if (!text.includes(from)) throw new Error(`${rel} has no ${from}`);
      writeFileSync(file, text.replace(from, to));
    };
    edit('domain/entities/customer.yaml', '  credit_limit:', '  phone:        Phone\n  credit_limit:');
    edit('workflows/client-intake/case.yaml', 'types:', '  client_phone:    Phone\ntypes:');
    edit('workflows/client-intake/steps/onboard.md', '    pan:   case.pan', '    pan:   case.pan\n    phone: case.client_phone');
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    const { runId, caseId } = await kernel.startRun({
      workflowId: 'client-intake', startAt: 'onboard',
      case: { client_name: 'Nina Shah', client_email: 'nina@shah.example', pan: 'AAACS1234S', gstin: '27AAACS1234S1Z5', client_phone: '+91 98200 12345' },
    });
    const done = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 });
    expect(done, done.stopReason).toMatchObject({ status: 'done', state: 'end' });
    const customerId = (await kernel.getCase(caseId))!.values.customer!.value;
    const row = (await kernel.listEntities('Customer', finance)).find((r) => r.id === customerId);
    expect(row!.values).toMatchObject({ name: 'Nina Shah', phone: '+91 98200 12345' });
  }, 120_000);
});
