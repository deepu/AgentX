// Phase 6 flow, crash and resume (24 §7, §8): a kernel process is SIGKILLed between a trigger's
// firing and its case, between a consumer's work and its ledger row, and between a hand-off's
// link and its child (or the parent's `started`). After a plain restart there is exactly one
// firing, one case, one child and one event to the parent.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowProject } from './fixtures/flow-project.ts';
import { kernelDatabase, pgAvailable, runChild, workerResult } from './helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/flow-worker.ts', import.meta.url));
let db: TestDatabase;
const project = flowProject();
const files = mkdtempSync(join(tmpdir(), 'mw-flow-crash-files-'));

describe.skipIf(!pgAvailable)('Phase 6 flow crash and resume', () => {
  beforeAll(async () => { db = await kernelDatabase('mw_rt_p6_flow_crash'); });
  afterAll(async () => { await db?.drop(); });

  const TRIGGER_POINTS = ['trigger-before-start@activate-site#0', 'event-before-delivery@triggers'];
  TRIGGER_POINTS.forEach((point, i) => {
    test(`entered trigger, killed at ${point}`, async () => {
      const site = `C-${i}`;
      const crashed = await runChild(WORKER, ['trigger', db.url, project, files, site], { MEMWISE_CRASH_AT: point });
      expect(crashed.signal, crashed.output).toBe('SIGKILL');
      expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${point}`);

      const resumed = await runChild(WORKER, ['trigger', db.url, project, files, site], {});
      expect(resumed.code, resumed.output).toBe(0);
      const r = workerResult(resumed.output) as { firings: { status: string; run_id: string; case_id: string }[]; runs: number };
      expect(r.runs).toBe(1);
      expect(r.firings).toHaveLength(1);
      expect(r.firings[0]).toMatchObject({ status: 'started' });
      expect(r.firings[0]!.case_id).toBeTruthy();
    }, 120_000);
  });

  const HANDOFF_POINTS: [point: string, workflow: string][] = [
    ['handoff-before-start@file_it', 'send-for-filing'],
    ['handoff-before-send@start_fix', 'hand-on'],
  ];
  HANDOFF_POINTS.forEach(([point, workflow], i) => {
    test(`${workflow}, killed at ${point}`, async () => {
      const runId = `run_crash_handoff_${i}`;
      const crashed = await runChild(WORKER, ['handoff', db.url, project, files, runId, workflow], { MEMWISE_CRASH_AT: point });
      expect(crashed.signal, crashed.output).toBe('SIGKILL');
      expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${point}`);

      const resumed = await runChild(WORKER, ['handoff', db.url, project, files, runId, workflow], {});
      expect(resumed.code, resumed.output).toBe(0);
      const r = workerResult(resumed.output) as { links: { child_run_id: string; child_case_id: string }[]; state: string; started: number };
      expect(r.links).toHaveLength(1);
      expect(r.links[0]!.child_case_id).toBeTruthy();
      // Exactly one case was started by this parent (its input provenance names the parent's case).
      const children = await db.pool.query(
        `select count(*)::int as n from mw.cases where values -> 'document' -> 'provenance' ->> 'by' = 'case:' || (select case_id from mw.runs where id = $1)`, [runId]);
      expect(children.rows[0].n).toBe(1);
      if (workflow === 'hand-on') {
        expect(r.state).toBe('after');
        expect(r.started).toBe(1);
      } else {
        expect(r.state).toBe('file_it');
      }
    }, 120_000);
  });
});
