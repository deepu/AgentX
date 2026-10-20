// Crash and resume of the run driver (fake step): SIGKILL after the step returned but before
// the transition committed, and inside the commit transaction. After a plain restart the
// transition happens exactly once, the step's case write is applied once, and the step's
// work is not repeated.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { fileURLToPath } from 'node:url';
import { WORK_TABLE_SQL } from './fixtures/fake-step.ts';
import { intakeShape } from './fixtures/workflows.ts';
import { kernelDatabase, putWorkflow, runChild, workerResult, pgAvailable } from './helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/kernel-worker.ts', import.meta.url));
let db: TestDatabase;

describe.skipIf(!pgAvailable)('run driver crash and resume', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_crash');
    await putWorkflow(db, intakeShape);
    await db.pool.query(WORK_TABLE_SQL);
  });
  afterAll(async () => { await db?.drop(); });

  const one = async (sql: string, params: unknown[]) => (await db.pool.query(sql, params)).rows[0];

  describe('driver crash and resume', () => {
    for (const point of ['after-step-before-commit@check', 'in-commit@check']) {
      test(point, async () => {
        const runId = `run_crash_${point.split('@')[0]!.replaceAll('-', '_')}`;
        const crashed = await runChild(WORKER, ['fake', db.url, runId], { MEMWISE_CRASH_AT: point });
        expect(crashed.signal).toBe('SIGKILL');
        expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${point}`);

        // Nothing committed: the step finished, the transition did not (in-commit rolled back).
        expect(await one('select state, seq from mw.runs where id = $1', [runId])).toEqual({ state: 'check', seq: 0 });
        expect((await one('select count(*)::int as n from mw.transitions where run_id = $1', [runId])).n).toBe(0);
        const { case_id: caseId } = await one('select case_id from mw.runs where id = $1', [runId]);
        expect((await one('select seq from mw.cases where id = $1', [caseId])).seq).toBe(1);

        const resumed = await runChild(WORKER, ['fake', db.url, runId], {});
        expect(resumed.code).toBe(0);
        expect(workerResult(resumed.output)).toEqual({ state: 'fill', status: 'active', seq: 1 });

        const transitions = await db.pool.query('select seq, from_state, to_state, accepted from mw.transitions where run_id = $1', [runId]);
        expect(transitions.rows).toEqual([{ seq: 1, from_state: 'check', to_state: 'fill', accepted: true }]);
        expect((await one('select seq from mw.cases where id = $1', [caseId])).seq).toBe(2);
        expect((await one(`select count(*)::int as n from mw.case_events where case_id = $1 and field = 'flags'`, [caseId])).n).toBe(1);
        // The step's work ran once, in the first process.
        const work = await db.pool.query('select pid from public.fake_step_work where step_run_id = $1', [`${runId}/0/check`]);
        expect(work.rows.length).toBe(1);
        expect((await one('select status from dbos.workflow_status where workflow_uuid = $1', [`${runId}/0/check`])).status).toBe('SUCCESS');
      }, 90_000);
    }
  });
});
