// The run driver with a fake step workflow, in-process: loops, outside events, stale and
// duplicate answers, timers and reminders, stops.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import type { StepRunInput } from '@memwise/step-engine';
import { createKernel } from '../src/kernel.ts';
import type { Kernel, RunRecord } from '../src/types.ts';
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
const script: Script = (input) => {
  if (input.step.id === 'boom') throw new Error('kaput');
  return needsInfoThenChecked(input);
};

describe.skipIf(!pgAvailable)('run driver', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_driver');
    await putWorkflow(db, intakeShape);
    await putWorkflow(db, timerShape);
    await putWorkflow(db, loosening, { effects: { outbound: 'approve' } });
    await putWorkflow(db, boom);
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

      expect(await kernel.sendEvent(runId, 'submitted', { idemKey: 'sub-1', forSeq: 1 })).toEqual({ sent: true });
      expect(await kernel.sendEvent(runId, 'submitted', { idemKey: 'sub-1', forSeq: 1 })).toEqual({ sent: false });
      run = await kernel.waitForRun(runId, { until: waiting('verify'), timeoutMs: 15_000 });
      expect(run.seq).toBe(3); // fill → check (2), check → verify (3)

      // The second attempt saw the first one.
      const second = seen.find((s) => s.stepRunId === `${runId}/2/check`)!;
      expect(second.attempt).toBe(2);
      expect(second.priorAttempts).toEqual([{ attempt: 1, outcome: 'needs_info', reason: 'scripted needs_info' }]);
      expect(second.case.values.flags!.value).toHaveLength(1);
      expect((await db.pool.query('select status, outcome from mw.step_runs where id = $1', [`${runId}/1/fill`])).rows[0])
        .toEqual({ status: 'completed', outcome: 'submitted' });

      // A late answer to the first fill entry, and an event verify doesn't handle: logged, ignored.
      await kernel.sendEvent(runId, 'approved', { idemKey: 'old', forSeq: 1 });
      await kernel.sendEvent(runId, 'submitted', { idemKey: 'stray' });
      run = await kernel.waitForRun(runId, { until: (r) => r.seq === 5, timeoutMs: 15_000 });
      expect(run.state).toBe('verify');

      await kernel.sendEvent(runId, 'sent_back', { idemKey: 'sb-1', forSeq: 3 });
      run = await kernel.waitForRun(runId, { until: (r) => r.seq === 6, timeoutMs: 15_000 });
      expect(run.state).toBe('fill');

      const t = await kernel.getTransitions(runId);
      expect(t.map((x) => [x.seq, x.from, x.to, x.source, x.accepted])).toEqual([
        [1, 'check', 'fill', 'step', true],
        [2, 'fill', 'check', 'external', true],
        [3, 'check', 'verify', 'step', true],
        [4, 'verify', 'verify', 'external', false],
        [5, 'verify', 'verify', 'external', false],
        [6, 'verify', 'fill', 'external', true],
      ]);
      expect(t[3]!.note).toBe('stale: for entry 1, current entry 3');
      expect(t[4]!.note).toBe('not handled in verify');
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

    test('a system step stops the run (mechanical steps come in Phase 2)', async () => {
      const { runId } = await kernel.startRun({ workflowId: 'client-intake', startAt: 'onboard', case: {} });
      const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
      expect(run.status).toBe('stopped');
      expect(run.stopReason).toBe('mechanical steps run from Phase 2');
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
    }, 30_000);
  });
});
