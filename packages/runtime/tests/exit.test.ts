// THE PHASE 1 EXIT TEST (docs/memwise/17-build-plan.md): the intake "check" step runs from its
// files against the pan-mismatch case. Killed mid-step at several points, it resumes without
// repeating any model call, the outbound email happens exactly once, and its step record and
// the context it saw are queryable.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgDefinitionStore, type TestDatabase } from '@memwise/db';
import { indexProject, loadProject } from '@memwise/defs';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel.ts';
import { exitKernelOptions, INTAKE_DIR } from './fixtures/exit-setup.ts';
import { kernelDatabase, runChild, workerResult, pgAvailable } from './helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/kernel-worker.ts', import.meta.url));
const CASES = [
  { name: 'no crash' },
  { name: 'after the 2nd model call', crash: 'after-model-call@2' },
  { name: 'waiting for the email approval (approved after restart)', crash: 'waiting-approval@email.send' },
  { name: 'after the email went out, before the ledger', crash: 'after-tool-effect@email.send', retried: true },
  { name: 'after the ledger, before DBOS recorded the call', crash: 'after-ledger-complete@email.send' },
  { name: 'after the checkpoint, before the record finished', crash: 'before-finish' },
];
// checker: tools → email → finish; verifier: the checkpoint verdict.
const EXPECTED_CALLS = ['checker:0', 'checker:1', 'checker:2', 'verifier:0'];

let db: TestDatabase;
const dir = mkdtempSync(join(tmpdir(), 'mw-exit-'));
const runIdOf = (i: number) => `run_exit_${i}`;
const counterOf = (i: number) => join(dir, `calls-${i}.txt`);
const stepRunOf = (i: number) => `${runIdOf(i)}/0/check`;

describe.skipIf(!pgAvailable)('Phase 1 exit test', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_exit');
    const { project, diagnostics } = await loadProject(INTAKE_DIR);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    await indexProject(project, new PgDefinitionStore(db.pool));
  });
  afterAll(async () => { await db?.drop(); });

  const rows = async (sql: string, params: unknown[]) => (await db.pool.query(sql, params)).rows;

  describe('Phase 1 exit test: intake check, killed mid-step', () => {
    CASES.forEach((c, i) => {
      test(c.name, async () => {
        const args = ['exit', db.url, runIdOf(i), counterOf(i)];
        if (c.crash) {
          const crashed = await runChild(WORKER, args, { MEMWISE_CRASH_AT: c.crash });
          expect(crashed.signal, crashed.output).toBe('SIGKILL');
          expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${c.crash}`);
          expect((await rows('select state from mw.runs where id = $1', [runIdOf(i)]))[0].state).toBe('check');
        }
        const resumed = await runChild(WORKER, args, {});
        expect(resumed.code, resumed.output).toBe(0);
        expect(workerResult(resumed.output)).toMatchObject({ state: 'fill', status: 'active' });

        // Every model call made exactly once, across both processes.
        const calls = readFileSync(counterOf(i), 'utf8').trim().split('\n');
        expect(calls).toEqual(EXPECTED_CALLS);

        // The outbound email: one outbox row for the step, one done ledger entry.
        const outbox = await rows(`select "to", attempts from mw_sandbox.outbox where idempotency_key like $1`, [`${stepRunOf(i)}:%`]);
        expect(outbox.length).toBe(1);
        expect(outbox[0].to).toBe('ravi@menon-exports.example');
        // Lost result + idempotent tool: retried with the same key, and the retry is visible.
        expect(outbox[0].attempts).toBe(c.retried ? 2 : 1);
        const effects = await rows(`select status from mw.effects where step_run_id = $1 and tool = 'email.send'`, [stepRunOf(i)]);
        expect(effects).toEqual([{ status: 'done' }]);

        // The outcome committed exactly once, with the case writes.
        const t = await rows('select seq, from_state, to_state, accepted from mw.transitions where run_id = $1 order by seq', [runIdOf(i)]);
        expect(t).toEqual([{ seq: 1, from_state: 'check', to_state: 'fill', accepted: true }]);
      }, 120_000);
    });

    test('the step records and the context each step saw are queryable through the kernel', async () => {
      const { options, example } = await exitKernelOptions(db.url, join(dir, 'inspector-calls.txt'));
      // A different executor id, so this kernel does not recover the workers' runs.
      const kernel = await createKernel({ ...options, executorId: 'inspector' });
      try {
        for (let i = 0; i < CASES.length; i++) {
          const record = await kernel.getStepRecord(stepRunOf(i));
          expect(record).toBeDefined();
          expect(record!).toMatchObject({ status: 'completed', outcome: 'needs_info', stepId: 'check', attempt: 1, workflowId: 'client-intake' });
          expect(record!.context?.systemPrompt).toContain('Validate the client');
          expect(record!.context?.tools.map((t) => t.tool)).toContain('gst.validate_gstin');
          expect(record!.context?.pushed.pan?.value).toBe('AAACM9999Z');
          const kinds = new Set(record!.journal.map((j) => j.kind));
          for (const k of ['model', 'tool', 'approval', 'checkpoint']) expect(kinds.has(k as any)).toBe(true);
          expect(record!.journal.filter((j) => j.kind === 'tool' && j.name === 'email.send').length).toBeGreaterThanOrEqual(1);

          const run = await kernel.getRun(runIdOf(i));
          const values = (await kernel.getCase(run!.caseId))!.values;
          for (const [field, want] of Object.entries(example.expect.writes ?? {})) expect(values[field]?.value).toEqual(want);
          expect(values.flags?.provenance).toMatchObject({ stepRunId: stepRunOf(i) });
        }
        expect(existsSync(join(dir, 'inspector-calls.txt'))).toBe(false); // the inspector made no model call
      } finally {
        await kernel.shutdown();
      }
    }, 60_000);
  });
});
