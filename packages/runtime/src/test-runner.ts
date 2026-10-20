// The default TestRunner (20 §5): example cases run in a child process, because DBOS is
// process-wide and the app's kernel can't host a second one. The child is the `memwise` CLI:
// from source under Bun, else the bundled CLI the app ships (`MEMWISE_CLI_JS`) on Electron's Node.
import type { ExampleOutcome } from '@memwise/defs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestRunner } from './types.ts';

export interface TestRunnerOptions {
  /** Admin URL of the Postgres server for the throwaway databases (`--database-url`). */
  adminUrl?: string;
  /** The command that runs the CLI, before its arguments. Default: see `cliCommand`. */
  command?: string[];
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** Default 10 minutes: every example makes a database and a kernel. */
  timeoutMs?: number;
}

/** How to run the CLI here: `bun cli.ts` under Bun, else the bundled `MEMWISE_CLI_JS` with Electron as Node. */
export function cliCommand(): { command: string[]; env: Record<string, string> } {
  if (process.versions.bun) return { command: [process.execPath, fileURLToPath(new URL('./cli.ts', import.meta.url))], env: {} };
  const bundled = process.env.MEMWISE_CLI_JS;
  if (!bundled) throw new Error('example cases need the memwise CLI: set MEMWISE_CLI_JS to the bundled memwise-cli.js');
  return { command: [process.execPath, bundled], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** The CLI's `--json` output as outcomes: a list, or an object holding one. */
export function parseOutcomes(stdout: string): ExampleOutcome[] | undefined {
  let data: unknown;
  const text = stdout.trim();
  try { data = JSON.parse(text); } catch {
    // Anything printed before the JSON (a warning) is skipped: take the last line that parses.
    const line = text.split('\n').reverse().find((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    if (!line) return undefined;
    data = JSON.parse(line);
  }
  const list = Array.isArray(data) ? data
    : data && typeof data === 'object' ? (['examples', 'results', 'outcomes'].map((k) => (data as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined)
    : undefined;
  if (!list) return undefined;
  return list.map((r) => {
    const o = r as Record<string, unknown>;
    const status = o.status === 'pass' || o.status === 'fail' || o.status === 'skip' ? o.status : 'fail';
    return {
      name: String(o.name ?? o.example ?? '(unnamed)'),
      status,
      differences: Array.isArray(o.differences) ? o.differences.map(String) : [],
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    };
  });
}

export function defaultTestRunner(opts: TestRunnerOptions = {}): TestRunner {
  return async ({ projectDir, workflowId, extraExamples }) => {
    const { command, env } = opts.command ? { command: opts.command, env: {} } : cliCommand();
    const args = ['test', projectDir, '--workflow', workflowId, '--json'];
    let tmp: string | undefined;
    if (extraExamples?.length) {
      tmp = mkdtempSync(join(tmpdir(), 'mw-examples-'));
      const file = join(tmp, 'examples.json');
      writeFileSync(file, JSON.stringify(extraExamples));
      args.push('--examples-file', file);
    }
    const adminUrl = opts.adminUrl ?? process.env.MEMWISE_TEST_DATABASE_URL;
    if (adminUrl) args.push('--database-url', adminUrl);
    try {
      const { code, stdout, stderr } = await run(command, args, { ...env, ...opts.env }, opts.timeoutMs ?? 600_000);
      const outcomes = parseOutcomes(stdout);
      if (outcomes) return outcomes;
      const tail = (stderr || stdout).trim().split('\n').slice(-12).join('\n');
      return [{ name: '(example cases)', status: 'fail', differences: [`the example cases could not run (exit ${code ?? 'killed'})`], reason: tail || 'no output' }];
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      if (adminUrl) await dropAbandonedExampleDatabases(adminUrl, opts.timeoutMs ?? 600_000).catch(() => undefined);
    }
  };
}

/**
 * A CLI killed on timeout never drops its example databases (`mw_example_<base36 time>_<hex>`).
 * Anything older than the timeout (and a minute) can't belong to a run still going: drop it.
 */
export async function dropAbandonedExampleDatabases(adminUrl: string, timeoutMs: number): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const cutoff = Date.now() - timeoutMs - 60_000;
    const { rows } = await client.query<{ datname: string }>(`select datname from pg_database where datname like 'mw\\_example\\_%'`);
    const old = rows.map((r) => r.datname).filter((name) => {
      const at = parseInt(name.split('_')[2] ?? '', 36);
      return Number.isFinite(at) && at < cutoff;
    });
    for (const name of old) await client.query(`drop database if exists "${name.replace(/"/g, '""')}" with (force)`).catch(() => undefined);
    return old;
  } finally {
    await client.end();
  }
}

function run(command: string[], args: string[], env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const [cmd, ...pre] = command;
    const child = spawn(cmd!, [...pre, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { stderr += `\ntimed out after ${timeoutMs} ms`; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
