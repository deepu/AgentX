import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runWithCrash(at: string | undefined): { lines: string[]; signal: string | null } {
  const out = join(mkdtempSync(join(tmpdir(), 'gw-crash-')), 'log');
  const env = { ...process.env, MEMWISE_CRASH_AT: at };
  if (!at) delete env.MEMWISE_CRASH_AT;
  const r = Bun.spawnSync(['bun', join(import.meta.dir, 'fixtures/crash-run.ts'), out], { env, stderr: 'pipe' });
  return { lines: readFileSync(out, 'utf8').trim().split('\n'), signal: r.signalCode ?? null };
}

describe('crash points', () => {
  test('no crash point: begin, effect, complete', () => {
    expect(runWithCrash(undefined)).toEqual({ lines: ['begin', 'effect', 'complete', 'returned'], signal: null });
  });

  test('after-tool-effect: the effect happened, the ledger never heard', () => {
    expect(runWithCrash('after-tool-effect@mail.send')).toEqual({ lines: ['begin', 'effect'], signal: 'SIGKILL' });
  });

  test('after-ledger-complete: completed, killed before returning', () => {
    expect(runWithCrash('after-ledger-complete@mail.send')).toEqual({ lines: ['begin', 'effect', 'complete'], signal: 'SIGKILL' });
  });
});
