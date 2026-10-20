// Crash and resume of a system (mechanical) step: the onboard step of examples/intake calls
// domain.customer.create and writes the customer's id to the case. Killed after the row was
// written but before the ledger recorded it, after DBOS recorded the call, after the step
// returned and inside the commit: after a restart the Customer exists exactly once, and the
// case points at it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelDatabase, runChild, workerResult, pgAvailable } from './helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/kernel-worker.ts', import.meta.url));
const POINTS = [
  'after-tool-effect@domain.customer.create',
  'after-ledger-complete@domain.customer.create',
  'after-system-tool@domain.customer.create',
  'after-step-before-commit@onboard',
  'in-commit@onboard',
];
let db: TestDatabase;
const files = mkdtempSync(join(tmpdir(), 'mw-sys-files-'));

describe.skipIf(!pgAvailable)('system step crash and resume', () => {
  beforeAll(async () => { db = await kernelDatabase('mw_rt_syscrash'); });
  afterAll(async () => { await db?.drop(); });

  const one = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows[0];

  POINTS.forEach((point, i) => {
    test(point, async () => {
      const runId = `run_sys_${i}`;
      const crashed = await runChild(WORKER, ['onboard', db.url, runId, files], { MEMWISE_CRASH_AT: point });
      expect(crashed.signal, crashed.output).toBe('SIGKILL');
      expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${point}`);
      expect((await one('select state from mw.runs where id = $1', [runId])).state).toBe('onboard');

      const resumed = await runChild(WORKER, ['onboard', db.url, runId, files], {});
      expect(resumed.code, resumed.output).toBe(0);
      expect(workerResult(resumed.output)).toMatchObject({ state: 'end', status: 'done' });

      const stepRunId = `${runId}/0/onboard`;
      const customers = await db.pool.query('select id, name, gstin, created_by_step from domain.customer where created_by_step = $1', [stepRunId]);
      expect(customers.rows.length).toBe(1);
      expect(customers.rows[0]).toMatchObject({ name: 'Asha Rao', gstin: '29AAACA1234A1Z5' });
      const { case_id: caseId } = await one('select case_id from mw.runs where id = $1', [runId]);
      const c = await one('select values from mw.cases where id = $1', [caseId]);
      expect(c.values.customer.value).toBe(customers.rows[0].id);
      expect(c.values.customer.provenance).toMatchObject({ kind: 'tool', tool: 'domain.customer.create', stepRunId });
      expect((await one(`select count(*)::int as n from mw.effects where step_run_id = $1 and status = 'done'`, [stepRunId])).n).toBe(1);
      const t = await db.pool.query('select from_state, to_state from mw.transitions where run_id = $1 order by seq', [runId]);
      expect(t.rows).toEqual([{ from_state: 'onboard', to_state: 'end' }]);
      expect(await one('select status, outcome, performer from mw.step_runs where id = $1', [stepRunId]))
        .toEqual({ status: 'completed', outcome: 'done', performer: 'system' });
    }, 120_000);
  });
});
