// The memwise CLI end to end, in child processes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgDefinitionStore, type TestDatabase } from '@memwise/db';
import { indexProject, loadProject } from '@memwise/defs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTAKE_DIR } from './fixtures/exit-setup.ts';
import { kernelDatabase, runChild, pgAvailable } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const WORKER = fileURLToPath(new URL('./fixtures/kernel-worker.ts', import.meta.url));
let db: TestDatabase;

describe.skipIf(!pgAvailable)('memwise CLI', () => {
  beforeAll(async () => { db = await kernelDatabase('mw_rt_cli'); });
  afterAll(async () => { await db?.drop(); });

  test('memwise check: the sample project has no errors', async () => {
    const r = await runChild(CLI, ['check', INTAKE_DIR], {});
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('0 error(s)');
  });

  test('memwise check: errors print file:line and exit 1', async () => {
    const broken = join(mkdtempSync(join(tmpdir(), 'mw-cli-')), 'intake');
    cpSync(INTAKE_DIR, broken, { recursive: true });
    const shape = join(broken, 'workflows/client-intake/workflow.yaml');
    writeFileSync(shape, readFileSync(shape, 'utf8').replace('checked:      verify', 'checked:      nowhere'));
    const r = await runChild(CLI, ['check', broken], {});
    expect(r.code, r.output).toBe(1);
    expect(r.output).toMatch(/workflows\/client-intake\/workflow\.yaml:\d+  error  \S+  .*nowhere/);
  });

  test('memwise policy shows each rule with its layer', async () => {
    const r = await runChild(CLI, ['policy', INTAKE_DIR, 'client-intake', 'check'], {});
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('outbound: approve  (domain, domain/policy.yaml)');
  });

  test('memwise test runs every example case', async () => {
    const admin = process.env.MEMWISE_TEST_DATABASE_URL;
    const r = await runChild(CLI, ['test', INTAKE_DIR, ...(admin ? ['--database-url', admin] : [])], {}, 180_000);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('PASS client-intake/clean-application');
    expect(r.output).toContain('PASS client-intake/pan-mismatch');
    expect(r.output).toContain('2 passed, 0 failed, 0 skipped');
  }, 180_000);

  test('memwise record prints the record, its context and journal', async () => {
    const { project } = await loadProject(INTAKE_DIR);
    await indexProject(project, new PgDefinitionStore(db.pool));
    const counter = join(mkdtempSync(join(tmpdir(), 'mw-cli-')), 'calls.txt');
    const w = await runChild(WORKER, ['exit', db.url, 'run_cli', counter], {});
    expect(w.code, w.output).toBe(0);
    const r = await runChild(CLI, ['record', 'run_cli/0/check', '--database-url', db.url], {});
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('"outcome": "needs_info"');
    expect(r.output).toContain('== context');
    expect(r.output).toContain('--- system prompt');
    expect(r.output).toMatch(/tool +email\.send/);
  }, 60_000);
});
