// A run committed without its driver (a crash between startRun's transaction and its
// DBOS.startWorkflow) is picked up when the next kernel starts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgCaseStore, withTransaction, type TestDatabase } from '@memwise/db';
import { initialTransition } from 'xstate';
import { applyTimerActions } from '../src/driver.ts';
import { driverIdOf } from '../src/ids.ts';
import { createKernel } from '../src/kernel.ts';
import { compileMachine } from '../src/machine.ts';
import type { Kernel } from '../src/types.ts';
import { fakeStep } from './fixtures/fake-step.ts';
import { step, workflow } from './fixtures/workflows.ts';
import { kernelDatabase, putWorkflow, pgAvailable } from './helpers.ts';

const orphan = workflow('orphan', 'act', { act: { on: { done: 'end' }, step: 'act' } }, [step('act', 'agent', { outcomes: ['done'], model: 'checker' })]);

describe.skipIf(!pgAvailable)('runs without a driver', () => {
  let db: TestDatabase;
  let kernel: Kernel | undefined;

  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_recovery');
    await putWorkflow(db, orphan);
  });

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
  });

  test('an active run whose driver never started is started at kernel start', async () => {
    const runId = 'run_orphan_test';
    // What startRun commits, without the DBOS.startWorkflow that follows it.
    await withTransaction(db.pool, async (c) => {
      await new PgCaseStore().create(c, { id: 'case_orphan_test', caseType: orphan.caseType.id, workflowId: orphan.id, workflowHash: orphan.hash, values: {} });
      const machine = compileMachine(orphan);
      const [snap, actions] = initialTransition(machine);
      await c.query(
        `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id)
         values ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
        [runId, orphan.id, orphan.version, orphan.hash, 'case_orphan_test', String(snap.value),
          JSON.stringify(machine.getPersistedSnapshot(snap)), driverIdOf(runId)]);
      await applyTimerActions(c, runId, 0, actions);
    });

    kernel = await createKernel({
      databaseUrl: db.url, tools: [], modelRoles: {}, providers: [],
      stepExecutor: fakeStep(db.url, () => ({ outcome: 'done' })),
    });
    const run = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 15_000 });
    expect(run).toMatchObject({ state: 'end', status: 'done', seq: 1 });
  }, 60_000);
});
