// A fake agent step for driver tests: one journaled unit of "work" (counted in a table, so a
// test can prove it ran once), then a scripted result. The real step engine is used by exit.test.ts.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { PgStepRecorder } from '@memwise/db';
import type { CaseValue, StepRecord } from '@memwise/defs';
import type { StepResult, StepRunInput } from '@memwise/step-engine';
import pg from 'pg';
import type { StepExecutor } from '../../src/types.ts';

export type Script = (input: StepRunInput) => { status?: StepResult['status']; outcome: string; writes?: Record<string, unknown>; reason?: string };

/** Default script: the first attempt asks for more information, the next one passes. */
export const needsInfoThenChecked: Script = (input) => input.attempt === 1
  ? { outcome: 'needs_info', writes: { flags: [{ field: 'pan', problem: 'mismatch', document: 'pan-card.pdf' }] } }
  : { outcome: 'checked', writes: { flags: [] } };

export const WORK_TABLE_SQL = `create table if not exists public.fake_step_work (step_run_id text, attempt int, pid int, at timestamptz default now())`;

export function fakeStep(databaseUrl: string, script: Script = needsInfoThenChecked, seen?: StepRunInput[]): StepExecutor {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, allowExitOnIdle: true });
  pool.on('error', () => {});
  const recorder = new PgStepRecorder(pool);
  return async (input) => {
    seen?.push(input);
    const base = {
      stepRunId: input.stepRunId, runId: input.runId, caseId: input.case.id, stepId: input.step.id, attempt: input.attempt,
      workflowId: input.workflow.id, workflowVersion: input.workflow.version, workflowHash: input.workflow.hash,
      stepHash: input.step.hash, performer: input.step.performer, token: input.token, startedAt: new Date(input.startedAt).toISOString(),
    };
    await DBOS.runStep(() => recorder.start(base), { name: 'record.start' });
    await DBOS.runStep(async () => {
      await pool.query(WORK_TABLE_SQL);
      await pool.query('insert into public.fake_step_work (step_run_id, attempt, pid) values ($1, $2, $3)', [input.stepRunId, input.attempt, process.pid]);
    }, { name: 'work' });
    const r = script(input);
    const at = new Date(input.startedAt).toISOString();
    const writes: Record<string, CaseValue> = {};
    for (const [k, v] of Object.entries(r.writes ?? {})) writes[k] = { value: v, provenance: { kind: 'judgement', at, stepRunId: input.stepRunId } };
    const result: StepResult = {
      stepRunId: input.stepRunId, status: r.status ?? 'completed', outcome: r.outcome, writes, checkpoint: [],
      usage: { tokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 }, tainted: false, ...(r.reason ? { reason: r.reason } : {}),
      rationale: `scripted ${r.outcome}`,
    };
    const record: StepRecord = {
      ...base, status: result.status, outcome: result.outcome, outputs: writes, checkpoint: [], rationale: result.rationale,
      usage: result.usage, tainted: false, finishedAt: at,
    };
    await DBOS.runStep(() => recorder.finish(record), { name: 'record.finish' });
    return result;
  };
}
