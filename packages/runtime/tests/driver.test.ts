// The run driver with a fake step workflow, in-process: loops, outside events, stale and
// duplicate answers, timers and reminders, stops.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import type { StepRunInput } from '@memwise/step-engine';
import { createKernel } from '../src/kernel.ts';
import type { Actor, Kernel, RunRecord } from '../src/types.ts';
import { fakeStep, needsInfoThenChecked, type Script } from './fixtures/fake-step.ts';
import { intakeShape, step, timerShape, workflow } from './fixtures/workflows.ts';
import { kernelDatabase, putWorkflow, pgAvailable } from './helpers.ts';

let db: TestDatabase;
let kernel: Kernel;
const seen: StepRunInput[] = [];

// A step whose own policy loosens the domain's: the run must stop before the step runs.
const loosening = workflow('loosening', 'act', { act: { on: { done: 'end' }, step: 'act' } }, [
  step('act', 'agent', { outcomes: ['done'], model: 'checker', policy: { effects: { outbound: 'allow' } } }),
]);

const boom = workflow('boom', 'boom', { boom: { on: { done: 'end' }, step: 'boom' } }, [step('boom', 'agent', { outcomes: ['done'], model: 'checker' })]);

// Two wait states in a row that both take `approved`: one answer must move only one of them.
// (Wait states: a person step is answered through submitStep, never an outside event.)
const twice = workflow('twice', 'a', { a: { on: { approved: 'b' } }, b: { on: { approved: 'end' } } }, []);

const person: Extract<Actor, { kind: 'person' }> = { kind: 'person', personId: 'p_driver_test', roles: [] };

// An agent step that ends needs_person (as when its approval wait times out), then a person step.
const expiry = workflow('expiry', 'ask', {
  ask: { on: { done: 'end', needs_person: 'held' }, step: 'ask' },
  held: { on: { resolved: 'end' }, step: 'held' },
}, [step('ask', 'agent', { outcomes: ['done'], model: 'checker' }), step('held', 'person', { outcomes: ['resolved'] })]);

// Two agent steps in a row: the second sees what the first used (run budgets).
const spend = workflow('spend', 'first', {
  first: { on: { done: 'second' }, step: 'first' },
  second: { on: { done: 'end' }, step: 'second' },
}, [step('first', 'agent', { outcomes: ['done'], model: 'checker' }), step('second', 'agent', { outcomes: ['done'], model: 'checker' })]);

// A tainted write, then steps that read it (an agent step, a system step's map) and one that doesn't.
const carry = workflow('carry', 'taint_a', {
  taint_a: { on: { done: 'taint_b' }, step: 'taint_a' },
  taint_b: { on: { done: 'taint_sys' }, step: 'taint_b' },
  taint_sys: { on: { done: 'taint_c' }, step: 'taint_sys' },
  taint_c: { on: { done: 'end' }, step: 'taint_c' },
}, [
  step('taint_a', 'agent', { outcomes: ['done'], model: 'checker' }),
  step('taint_b', 'agent', { outcomes: ['done'], model: 'checker', reads: ['case.flags', 'case.pan'] }),
  step('taint_sys', 'system', { outcomes: ['done'], map: { 'mail.send': { to: { case: 'flags' } } } }),
  step('taint_c', 'agent', { outcomes: ['done'], model: 'checker', reads: ['case.pan'] }),
]);

const script: Script = (input) => {
  if (input.step.id === 'taint_a') return { outcome: 'done', writes: { flags: [] }, tainted: true };
  if (input.step.id.startsWith('taint_')) return { outcome: 'done' };
  if (input.step.id === 'boom') throw new Error('kaput');
  if (input.step.id === 'ask') return { status: 'needs_person', outcome: 'needs_person', reason: 'no answer in time' };
  if (input.step.id === 'first') return { outcome: 'done', usage: { tokens: 120, modelCalls: 3, toolCalls: 1, durationMs: 40 } };
  if (input.step.id === 'second') return { outcome: 'done' };
  return needsInfoThenChecked(input);
};

describe.skipIf(!pgAvailable)('run driver', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_driver');
    await putWorkflow(db, intakeShape);
    await putWorkflow(db, timerShape);
    await putWorkflow(db, loosening, { effects: { outbound: 'approve' } });
    await putWorkflow(db, boom);
    await putWorkflow(db, twice);
    await putWorkflow(db, expiry);
    await putWorkflow(db, spend);
    await putWorkflow(db, carry);
    kernel = await createKernel({ databaseUrl: db.url, tools: [], modelRoles: {}, providers: [], stepExecutor: fakeStep(db.url, script, seen) });
  });

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
  });

  const waiting = (state: string) => (r: RunRecord) => r.state === state && r.status === 'active';

  describe('run driver', () => {
    test('check → needs_info loops back to fill and waits; events move it; stale and duplicate answers do not', async () => {
      const { runId, caseId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'check', case: { pan: 'AAACM9999Z' } });
      let run = await kernel.waitForRun(runId, { until: waiting('fill'), timeoutMs: 15_000 });
      expect(run.seq).toBe(1);
      expect(run.enteredSeq).toBe(1);
      expect(run.timers.map((t) => t.timerId).sort()).toEqual(['remind.fill', 'xstate.after.604800000.client-intake.fill']);

      const c = await kernel.getCase(caseId);
      expect(c!.seq).toBe(2); // created, then the step's write batch
      expect(c!.values.flags!.value).toEqual([{ field: 'pan', problem: 'mismatch', document: 'pan-card.pdf' }]);
      expect(c!.values.flags!.provenance).toMatchObject({ kind: 'judgement', stepRunId: `${runId}/0/check` });

      // The external fill step is visible as a waiting step run.
      const fill = await db.pool.query('select status, performer from mw.step_runs where id = $1', [`${runId}/1/fill`]);
      expect(fill.rows[0]).toEqual({ status: 'waiting', performer: 'external' });

      // A person or external step is answered through submitStep, never by an outside event.
      expect(await kernel.sendEvent(runId, 'submitted', { idemKey: 'sub-0', forSeq: 1 })).toMatchObject({ sent: false, reason: 'use_submit' });
      const fillId = `${runId}/1/fill`;
      expect(await kernel.submitStep({ stepRunId: fillId, outcome: 'submitted', by: person })).toEqual({ applied: true, status: 'applied' });
      expect(await kernel.submitStep({ stepRunId: fillId, outcome: 'submitted', by: person })).toMatchObject({ applied: false, status: 'stale' });
      run = await kernel.waitForRun(runId, { until: waiting('verify'), timeoutMs: 15_000 });
      expect(run.seq).toBe(3); // fill → check (2), check → verify (3)

      // The second attempt saw the first one.
      const second = seen.find((s) => s.stepRunId === `${runId}/2/check`)!;
      expect(second.attempt).toBe(2);
      expect(second.priorAttempts).toEqual([{ attempt: 1, outcome: 'needs_info', reason: 'scripted needs_info' }]);
      expect(second.case.values.flags!.value).toHaveLength(1);
      expect((await db.pool.query('select status, outcome from mw.step_runs where id = $1', [`${runId}/1/fill`])).rows[0])
        .toEqual({ status: 'completed', outcome: 'submitted' });

      // Outside events cannot decide the person step verify either (review finding: a staff
      // client sending `approved` skipped the manager); a late answer to the first fill is stale.
      expect(await kernel.sendEvent(runId, 'approved', { idemKey: 'ap-0' })).toMatchObject({ sent: false, reason: 'use_submit' });
      expect(await kernel.submitStep({ stepRunId: fillId, outcome: 'submitted', by: person })).toMatchObject({ status: 'stale' });
      expect((await kernel.getRun(runId))!.seq).toBe(3);

      expect(await kernel.submitStep({ stepRunId: `${runId}/3/verify`, outcome: 'sent_back', by: person })).toMatchObject({ applied: true });
      run = await kernel.waitForRun(runId, { until: (r) => r.seq === 4, timeoutMs: 15_000 });
      expect(run.state).toBe('fill');

      const t = await kernel.getTransitions(runId);
      expect(t.map((x) => [x.seq, x.from, x.to, x.source, x.accepted])).toEqual([
        [1, 'check', 'fill', 'step', true],
        [2, 'fill', 'check', 'external', true],
        [3, 'check', 'verify', 'step', true],
        [4, 'verify', 'fill', 'external', true],
      ]);
      expect(t[3]!.event).toMatchObject({ type: 'sent_back', by: person.personId });
      // The fake step ran once per entry of check.
      const work = await db.pool.query('select step_run_id from public.fake_step_work where step_run_id like $1 order by at', [`${runId}/%`]);
      expect(work.rows.map((r) => r.step_run_id)).toEqual([`${runId}/0/check`, `${runId}/2/check`]);
    }, 60_000);

    test('a timeout fires after its deadline; a reminder is recorded without moving the run', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'timer-test', case: {} });
      const run = await kernel.waitForRun(runId, { until: waiting('needs_person'), timeoutMs: 15_000 });
      const t = await kernel.getTransitions(runId);
      expect(t.map((x) => [x.from, x.to, x.event.type, x.source, x.accepted])).toEqual([
        ['waiting', 'waiting', 'remind', 'timer', true],
        ['waiting', 'needs_person', 'xstate.after.2000.timer-test.waiting', 'timer', true],
      ]);
      expect(t[0]!.note).toContain('reminder');
      expect(run.enteredSeq).toBe(2);
      const timers = await db.pool.query('select timer_id, status from mw.timers where run_id = $1 order by timer_id', [runId]);
      expect(timers.rows).toEqual([
        { timer_id: 'remind.waiting', status: 'fired' },
        { timer_id: 'xstate.after.2000.timer-test.waiting', status: 'fired' },
      ]);
      const elapsed = Date.parse(t[1]!.at) - Date.parse(run.createdAt);
      expect(elapsed).toBeGreaterThanOrEqual(1900);
    }, 30_000);

    test('a system step runs without a model and finishes with its one outcome', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'onboard', case: {} });
      const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
      expect(run.status).toBe('done');
      const record = await kernel.getStepRecord(`${runId}/0/onboard`);
      expect(record).toMatchObject({ performer: 'system', status: 'completed', outcome: 'done' });
    }, 30_000);

    test('needs_person without a transition of that name stops the run', async () => {
      seen.length = 0;
      const k = kernel;
      // `verify` has no needs_person transition; drive a step there by starting a one-state workflow.
      const wf = workflow('np', 'act', { act: { on: { done: 'end' }, step: 'act' } }, [step('act', 'agent', { outcomes: ['done'], model: 'checker' })]);
      await putWorkflow(db, wf);
      const { runId } = await k.startRun({ workflowId: 'np', case: {}, runId: 'run_np_test' });
      // The default script says needs_info, which `act` doesn't handle: the run stops instead of looping.
      const run = await k.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
      expect(run.status).toBe('stopped');
      expect(run.stopReason).toBe('outcome "needs_info" has no transition from act');
      // Starting the same run id again is harmless.
      expect((await k.startRun({ workflowId: 'np', case: {}, runId: 'run_np_test' })).runId).toBe('run_np_test');
    }, 30_000);

    test('a policy violation stops the run before the step runs', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'loosening', case: {} });
      const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
      expect(run.status).toBe('stopped');
      expect(run.stopReason).toContain('policy violations');
      expect(run.stopReason).toContain('effects.outbound');
      const work = await db.pool.query('select count(*)::int as n from public.fake_step_work where step_run_id like $1', [`${runId}/%`]);
      expect(work.rows[0].n).toBe(0);
    }, 30_000);

    test('a step workflow that throws stops the run instead of leaving it hanging', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'boom', case: {} });
      const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
      expect(run.status).toBe('stopped');
      expect(run.stopReason).toBe('step workflow failed: kaput');
      // The step run is closed too, not left `running`.
      const sr = await db.pool.query('select status, rationale, finished_at from mw.step_runs where id = $1', [`${runId}/0/boom`]);
      expect(sr.rows[0]).toMatchObject({ status: 'failed', rationale: 'step workflow failed: kaput' });
      expect(sr.rows[0].finished_at).not.toBeNull();
    }, 30_000);

    test('an event without `for` answers the state entry current when it was sent, never a later one', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'twice', case: {} });
      await kernel.waitForRun(runId, { until: waiting('a'), timeoutMs: 15_000 });
      // Hold the driver's commit (it reads mw.timers first; sendEvent never does) so both
      // answers are sent while the run is still in `a`, as when the driver is busy elsewhere.
      const hold = await db.pool.connect();
      try {
        await hold.query('begin');
        await hold.query('lock table mw.timers in access exclusive mode');
        expect(await kernel.sendEvent(runId, 'approved', { idemKey: 'ap-1' })).toEqual({ sent: true });
        expect(await kernel.sendEvent(runId, 'approved', { idemKey: 'ap-2' })).toEqual({ sent: true });
        await hold.query('commit');
      } finally { hold.release(); }
      const run = await kernel.waitForRun(runId, { until: (r) => r.seq === 2, timeoutMs: 15_000 });
      expect(run.state).toBe('b');
      const t = await kernel.getTransitions(runId);
      expect(t.map((x) => [x.from, x.to, x.event, x.accepted])).toEqual([
        ['a', 'b', { type: 'approved', for: 0 }, true],
        ['b', 'b', { type: 'approved', for: 0 }, false],
      ]);
      expect(t[1]!.note).toBe('stale: for entry 0, current entry 1');
      // An event the state doesn't handle: logged, ignored.
      await kernel.sendEvent(runId, 'submitted', { idemKey: 'stray' });
      const after = await kernel.waitForRun(runId, { until: (r) => r.seq === 3, timeoutMs: 15_000 });
      expect(after.state).toBe('b');
      expect((await kernel.getTransitions(runId))[2]).toMatchObject({ accepted: false, note: 'not handled in b' });
    }, 30_000);

    test('approvals of a step run that is no longer waiting expire and cannot be decided', async () => {
      const runId = 'run_expiry_test';
      const approval = (id: string, stepRunId: string) => db.pool.query(
        `insert into mw.approvals (id, step_run_id, tool, effect, treatment, args, preview, status, requested_at)
         values ($1, $2, 'mail.send', 'outbound', 'approve', '{}', '{"summary":"send"}', 'pending', now())`, [id, stepRunId]);
      // The step asked for an approval, then gave up waiting and ended needs_person.
      await approval(`${runId}/0/ask:call-1`, `${runId}/0/ask`);
      await kernel.startRun({ workflowId: 'expiry', case: {}, runId });
      await kernel.waitForRun(runId, { until: waiting('held'), timeoutMs: 15_000 });
      // The driver opens the person step's waiting step run right after entering `held`.
      for (let i = 0; i < 100; i++) {
        const r = await db.pool.query('select status from mw.step_runs where id = $1', [`${runId}/1/held`]);
        if (r.rows[0]?.status === 'waiting') break;
        await new Promise((res) => setTimeout(res, 100));
      }
      const status = async (id: string) => (await db.pool.query('select status from mw.approvals where id = $1', [id])).rows[0].status;
      expect(await status(`${runId}/0/ask:call-1`)).toBe('expired');
      const decision = { id: `${runId}/0/ask:call-1`, status: 'approved' as const, by: 'me', at: new Date().toISOString() };
      expect(await kernel.decideApproval(decision)).toEqual({ applied: false, status: 'expired' });

      // Still pending, but its step run is not waiting (it finished without the driver committing yet).
      await approval(`${runId}/0/ask:call-2`, `${runId}/0/ask`);
      expect(await kernel.decideApproval({ ...decision, id: `${runId}/0/ask:call-2` })).toEqual({ applied: false, status: 'expired' });
      expect(await status(`${runId}/0/ask:call-2`)).toBe('pending');
      // A pending approval of a waiting step run is listed; the other is not.
      await approval(`${runId}/1/held:call-3`, `${runId}/1/held`);
      const listed = (await kernel.pendingApprovals()).map((a) => a.id).filter((id) => id.startsWith(runId));
      expect(listed).toEqual([`${runId}/1/held:call-3`]);
    }, 30_000);

    test('taint follows a case value into the later steps that read it (review finding)', async () => {
      const { runId, caseId } = await kernel.startRun({ workflowId: 'carry', case: { pan: 'AAACA1234A' } });
      await kernel.waitForRun(runId, { until: (r) => r.status === 'done', timeoutMs: 15_000 });
      expect((await db.pool.query('select tainted_fields from mw.cases where id = $1', [caseId])).rows[0].tainted_fields).toEqual(['flags']);
      const input = (id: string) => seen.find((s) => s.stepRunId === `${runId}/${id}`)!;
      expect(input('0/taint_a').tainted).toBeUndefined();
      expect(input('1/taint_b')).toMatchObject({ tainted: true, taintedReads: ['flags'] });
      expect(input('3/taint_c').tainted).toBeUndefined();
      // The system step maps the tainted field into a call: it ran tainted too.
      expect((await kernel.getStepRecord(`${runId}/2/taint_sys`))!).toMatchObject({ status: 'completed', tainted: true });
    }, 30_000);

    test('a step run gets what earlier step runs of the run used', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'spend', case: {} });
      await kernel.waitForRun(runId, { until: (r) => r.status === 'done', timeoutMs: 15_000 });
      expect(seen.find((s) => s.stepRunId === `${runId}/0/first`)!.runSpent).toEqual({ tokens: 0, modelCalls: 0, elapsedMs: 0 });
      expect(seen.find((s) => s.stepRunId === `${runId}/1/second`)!.runSpent).toEqual({ tokens: 120, modelCalls: 3, elapsedMs: 40 });
    }, 30_000);
  });
});
