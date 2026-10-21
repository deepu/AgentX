// The Phase 3 CLI end to end, in child processes: init, draft, diff, push, convert, test --json.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { loadProject, readDraft } from '@memwise/defs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelDatabase, pgAvailable, runChild } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CHECK = 'workflows/client-intake/steps/check.md';
const SHAPE = 'workflows/client-intake/workflow.yaml';
const admin = process.env.MEMWISE_TEST_DATABASE_URL;
const testDb = admin ? ['--test-database-url', admin] : [];

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'mw-cli3-')); temps.push(d); return d; };

const cli = (args: string[], timeoutMs?: number) => runChild(CLI, args, {}, timeoutMs);
/** The last line of stdout+stderr that is a path (draft and convert print the folder there). */
const folderIn = (output: string) => output.trim().split('\n').reverse().find((l) => l.startsWith('/'))!;

/** A fresh copy of the intake sample made with `memwise init`. */
async function intakeProject(): Promise<string> {
  const dir = join(tempDir(), 'proj');
  const r = await cli(['init', dir, '--template', 'intake']);
  expect(r.code, r.output).toBe(0);
  return dir;
}

describe('memwise init, draft, diff, convert', () => {
  test('init: an empty project checks clean; a non-empty folder is refused', async () => {
    const dir = join(tempDir(), 'empty');
    const r = await cli(['init', dir]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('domain/roles.yaml');
    expect(existsSync(join(dir, 'domain/policy.yaml'))).toBe(true);
    // The meta playbooks come with every project (20 §3).
    expect(existsSync(join(dir, 'workflows/create-playbook/workflow.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'workflows/change-playbook/workflow.yaml'))).toBe(true);
    const c = await cli(['check', dir]);
    expect(c.code, c.output).toBe(0);
    expect(c.output).toContain('0 error(s)');
    const again = await cli(['init', dir]);
    expect(again.code).toBe(1);
    expect(again.output).toContain('is not empty');
  });

  test('draft prints its folder; diff shows the file hunks and the change in plain words', async () => {
    const root = await intakeProject();
    const r = await cli(['draft', root, 'client-intake', '--title', 'Stricter check']);
    expect(r.code, r.output).toBe(0);
    const folder = folderIn(r.output);
    expect(folder).toStartWith(join(root, 'drafts', 'client-intake-'));
    const id = folder.split('/').pop()!;
    expect((await readDraft(root, id))?.meta).toMatchObject({ title: 'Stricter check', kind: 'change', baseVersion: 2, createdBy: 'cli' });
    writeFileSync(join(folder, CHECK), readFileSync(join(folder, CHECK), 'utf8').replace(/\n*$/, '\n\nAlso check the PAN twice.\n'));

    const d = await cli(['diff', root, folder]);
    expect(d.code, d.output).toBe(0);
    expect(d.output).toContain(`--- live/${SHAPE}`);
    expect(d.output).toContain('-version: 2\n+version: 3');
    expect(d.output).toContain(`+++ draft/${CHECK}`);
    expect(d.output).toContain('+Also check the PAN twice.');
    expect(d.output).toContain('== in plain words');
    expect(d.output).toContain('Version 2 → 3.');
    expect(d.output).toContain('Step `check`: instructions changed.');

    // A draft folder is a project: memwise check works on it.
    const c = await cli(['check', folder]);
    expect(c.code, c.output).toBe(0);
    const none = await cli(['diff', root, 'nope-123']);
    expect(none.code).toBe(1);
  }, 30_000); // four CLI processes: over bun's 5 s default on a loaded machine

  test('convert makes a create draft from a task.yaml that checks clean', async () => {
    const root = await intakeProject();
    const task = join(tempDir(), 'task.yaml');
    writeFileSync(task, `id: research-brief
title: Research brief
goal: Write a short brief
params: [{ name: topic, type: string }]
nodes:
  - { id: gather, prompt: 'Find sources about \${params.topic}' }
  - { id: write, type: session, depends_on: [gather], approval: true, prompt: 'Write the brief from \${nodes.gather.output}' }
`);
    const r = await cli(['convert', task, root]);
    expect(r.code, r.output).toBe(0);
    const folder = folderIn(r.output);
    expect(readdirSync(join(folder, 'workflows/research-brief/steps')).sort()).toEqual(['gather.md', 'write.md', 'write_approval.md']);
    const meta = (await readDraft(root, folder.split('/').pop()!))!.meta;
    expect(meta).toMatchObject({ kind: 'create', title: 'Research brief', workflowId: 'research-brief' });
    const c = await cli(['check', folder]);
    expect(c.code, c.output).toBe(0);
    expect(c.output).toContain('0 error(s)');
    // The domain permits no `worker` model role, so the steps name one it does.
    expect(readFileSync(join(folder, 'workflows/research-brief/steps/gather.md'), 'utf8')).toContain('model: checker');
    expect(existsSync(join(root, 'workflows/research-brief'))).toBe(false);
  });
});

let db: TestDatabase;

describe.skipIf(!pgAvailable)('memwise push and test --json', () => {
  beforeAll(async () => { db = await kernelDatabase('mw_rt_cli3'); });
  afterAll(async () => { await db?.drop(); });

  test('push checks, runs the example cases, publishes and records the version', async () => {
    const root = await intakeProject();
    const before = (await loadProject(root)).project.workflows['client-intake']!;
    const folder = folderIn((await cli(['draft', root, 'client-intake'])).output);
    writeFileSync(join(folder, CHECK), readFileSync(join(folder, CHECK), 'utf8').replace(/\n*$/, '\n\nBe brief.\n'));
    const r = await cli(['push', root, folder, '--database-url', db.url, ...testDb], 300_000);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('0 error(s)');
    expect(r.output).toContain('5 passed, 0 failed, 0 skipped');
    expect(r.output).toContain('published client-intake version 3 (2 file(s))');
    const live = (await loadProject(root)).project.workflows['client-intake']!;
    expect(live.version).toBe(3);
    expect(live.steps.check!.instructions).toEndWith('Be brief.');
    expect(live.hash).not.toBe(before.hash);
    const { rows } = await db.pool.query('select version, hash, source, draft_id from mw.workflow_versions where workflow_id = $1', ['client-intake']);
    expect(rows).toEqual([{ version: 3, hash: live.hash, source: 'cli', draft_id: folder.split('/').pop() }]);
    // Published drafts are done.
    const again = await cli(['push', root, folder]);
    expect(again.code).toBe(1);
    expect(again.output).toContain('already published');
  }, 300_000);

  test('push refuses a draft with check errors, and one whose live files changed meanwhile', async () => {
    const root = await intakeProject();
    const broken = folderIn((await cli(['draft', root, 'client-intake'])).output);
    writeFileSync(join(broken, SHAPE), readFileSync(join(broken, SHAPE), 'utf8').replace('checked:      verify', 'checked:      nowhere'));
    const r1 = await cli(['push', root, broken]);
    expect(r1.code, r1.output).toBe(1);
    expect(r1.output).toContain('unknown-target');
    expect(r1.output).toContain('not published: fix the errors first');

    // A draft with no example cases left to run, so the refusal comes from the conflict.
    const stale = folderIn((await cli(['draft', root, 'client-intake'])).output);
    for (const f of readdirSync(join(stale, 'workflows/client-intake/examples'))) rmSync(join(stale, 'workflows/client-intake/examples', f));
    writeFileSync(join(root, SHAPE), `${readFileSync(join(root, SHAPE), 'utf8')}# edited live\n`);
    const r2 = await cli(['push', root, stale], 120_000);
    expect(r2.code, r2.output).toBe(1);
    expect(r2.output).toContain(`these live files changed since the draft was made:\n  ${SHAPE}`);
    expect(readFileSync(join(root, SHAPE), 'utf8')).toContain('version: 2');
  }, 120_000);

  test('test --json prints only the outcomes, extra examples included', async () => {
    const extra = join(tempDir(), 'extra.json');
    writeFileSync(extra, JSON.stringify([
      { name: 'replay-onboard', startAt: 'onboard', case: { client_name: 'Ravi', client_email: 'ravi@example.com', pan: 'AAACA1234A', gstin: '29AAACA1234A1Z5' }, expect: { state: 'end', entities: { Customer: 1 } } },
      { name: 'replay-wrong', startAt: 'onboard', case: { client_name: 'Ravi' }, expect: { state: 'fill' } },
    ]));
    const root = await intakeProject();
    const r = await runChildSplit(['test', root, '--workflow', 'client-intake', '--example', 'replay-onboard', '--json', '--examples-file', extra, ...(admin ? ['--database-url', admin] : [])]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ name: 'replay-onboard', status: 'pass', differences: [] }]);
    const all = await runChildSplit(['test', root, '--workflow', 'client-intake', '--json', '--examples-file', extra, ...(admin ? ['--database-url', admin] : [])]);
    expect(all.code, all.stderr).toBe(1);
    const outcomes = JSON.parse(all.stdout) as { name: string; status: string; differences: string[] }[];
    expect(outcomes.map((o) => [o.name, o.status])).toEqual([
      ['clean-application', 'pass'], ['full-intake', 'pass'], ['onboard-creates-customer', 'pass'], ['pan-mismatch', 'pass'],
      ['staff-fill-for-client', 'pass'], ['replay-onboard', 'pass'], ['replay-wrong', 'fail'],
    ]);
    expect(outcomes[6]!.differences[0]).toContain('state: expected fill, got end');
    const unknown = await runChildSplit(['test', root, '--workflow', 'nope', '--json']);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
  }, 300_000);
});

/** Like runChild, with stdout and stderr apart (test --json keeps stdout for the JSON). */
function runChildSplit(args: string[], timeoutMs = 300_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { child.kill(9); reject(new Error('child timed out')); }, timeoutMs);
    Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([stdout, stderr, code]) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }, reject);
  });
}
