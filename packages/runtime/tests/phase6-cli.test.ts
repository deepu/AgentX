// Phase 6 through the memwise CLI, in child processes (one kernel per process): example cases
// that start from records and check entities by key (24 §12), and the validation report a
// regulated customer files (24 §9).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgAvailable, runChild } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const PROJECT = fileURLToPath(new URL('./fixtures/records-project', import.meta.url));
const admin = () => (process.env.MEMWISE_TEST_DATABASE_URL ? ['--database-url', process.env.MEMWISE_TEST_DATABASE_URL] : []);

describe.skipIf(!pgAvailable)('Phase 6 CLI', () => {
  test('memwise test: an example seeds its records, signs its review and checks entities by key', async () => {
    const r = await runChild(CLI, ['test', PROJECT, '--workflow', 'review-report', ...admin()], {}, 300_000);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('PASS review-report/released');
  }, 300_000);

  test('memwise validation-report writes the Markdown report with every playbook and example', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'mw-vr-')), 'report.md');
    const r = await runChild(CLI, ['validation-report', PROJECT, '--out', out, ...admin()], {}, 300_000);
    expect(r.code, r.output).toBe(0);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('# Validation report: Brightwater Labs');
    expect(md).toContain("| Review a test report (`review-report`) | Quality | 1 |");
    expect(md).toContain('released');
    expect(md).toContain('Regulated domains');
  }, 300_000);
});
