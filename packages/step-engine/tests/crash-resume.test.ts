/**
 * Crash and resume (17: every runtime package ships with these): a step run is killed with
 * SIGKILL at a crash point in a child process, then rerun so DBOS recovers it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepResult } from '../src/index.ts';
import { createDatabase } from './helpers.ts';

const CHILD = join(import.meta.dir, 'fixtures/crash-child.ts');

async function child(env: Record<string, string>) {
  const proc = Bun.spawn(['bun', CHILD], { env: { ...process.env, MEMWISE_CRASH_AT: '', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, signal: proc.signalCode, stderr };
}

async function crashAndResume(crashAt: string, scenario: Record<string, string> = {}, resume: Record<string, string> = {}) {
  const db = await createDatabase('crash');
  const dir = mkdtempSync(join(tmpdir(), 'mw-step-crash-'));
  try {
    const env = { DB_URL: db.url, OUT_DIR: dir, ...scenario };
    const first = await child({ ...env, MEMWISE_CRASH_AT: crashAt });
    expect(first.signal).toBe('SIGKILL');
    expect(first.stderr).toContain(`MEMWISE_CRASH_AT=${crashAt}`);
    const second = await child({ ...env, ...resume });
    expect(second.stderr).not.toContain('MEMWISE_CRASH_AT');
    expect(second.code).toBe(0);
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
    return {
      result: JSON.parse(read('result.json')) as StepResult,
      modelCalls: read('model-calls.log').trim().split('\n'),
      executions: read('executions.log').trim().split('\n').filter(Boolean),
      effects: read('provider.jsonl').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { key: string; applied: boolean }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
}

describe('crash and resume', () => {
  test('killed after the first model call: no model call repeats and the effect happens once', async () => {
    const r = await crashAndResume('after-model-call@1');
    expect(r.result).toMatchObject({ status: 'completed', outcome: 'checked' });
    expect(r.modelCalls).toEqual(['checker 0', 'checker 1', 'checker 2', 'verifier 0']);
    expect(r.executions.map((l) => l.split(' ')[0])).toEqual(['gst.validate_gstin', 'intake.extract_fields', 'crm.add_note']);
    expect(r.effects.filter((e) => e.applied)).toHaveLength(1);
  }, 60_000);

  test('killed after the tool effect, before the ledger: the provider dedups the retry on the same key', async () => {
    const r = await crashAndResume('after-tool-effect@crm.add_note');
    expect(r.result).toMatchObject({ status: 'completed', outcome: 'checked' });
    expect(r.modelCalls).toEqual(['checker 0', 'checker 1', 'checker 2', 'verifier 0']);
    // The tool step was in flight, so it ran again, with the same key; the effect applied once.
    const notes = r.executions.filter((l) => l.startsWith('crm.add_note'));
    expect(notes).toHaveLength(2);
    expect(new Set(notes).size).toBe(1);
    expect(r.effects.map((e) => e.applied)).toEqual([true, false]);
  }, 60_000);

  test('killed while waiting for an approval: the wait survives the restart and the answer resumes it', async () => {
    const r = await crashAndResume('waiting-approval@email.send', { SCENARIO: 'approval' }, { APPROVE: '1' });
    expect(r.result).toMatchObject({ status: 'completed', outcome: 'needs_info' });
    expect(r.modelCalls).toEqual(['checker 0', 'checker 1', 'checker 2', 'verifier 0']);
    expect(r.executions.map((l) => l.split(' ')[0])).toEqual(['gst.validate_gstin', 'intake.extract_fields', 'email.send']);
  }, 60_000);
});
