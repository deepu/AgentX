import { createTestDatabase, PgDefinitionStore, postgresAvailable, type TestDatabase } from '@memwise/db';
import type { PolicyDoc, WorkflowDef } from '@memwise/defs';
import { spawn } from 'node:child_process';
import { migrateAll } from '../src/kernel.ts';

// A fresh database per test file: on MEMWISE_TEST_DATABASE_URL when set, else on a throwaway
// cluster (@memwise/db createTestDatabase). Suites skip where neither is possible.
export const pgAvailable = postgresAvailable();

export async function kernelDatabase(prefix: string): Promise<TestDatabase> {
  const db = await createTestDatabase(prefix);
  await migrateAll(db.url, db.pool, { sandbox: true });
  return db;
}

export async function putWorkflow(db: TestDatabase, wf: WorkflowDef, domainPolicy?: PolicyDoc) {
  const defs = [{ kind: 'workflow' as const, id: wf.id, version: wf.version, hash: wf.hash, path: wf.dir, body: wf }];
  if (domainPolicy) defs.push({ kind: 'policy' as any, id: 'domain', version: undefined as any, hash: `domain-${wf.hash}`, path: 'domain/policy.yaml', body: domainPolicy as any });
  await new PgDefinitionStore(db.pool).upsert(defs, []);
}

/** Run a child process to completion; resolves with its exit code or the signal that killed it. */
export function runChild(script: string, args: string[], env: Record<string, string | undefined>, timeoutMs = 60_000) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child timed out:\n${output}`)); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

/** The worker's `RESULT {...}` line. */
export function workerResult(output: string): unknown {
  const line = output.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line in worker output:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length));
}
