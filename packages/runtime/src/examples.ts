// Example cases as acceptance tests (05 §12): each runs on a fresh database with a scripted
// model, stubbed tools and scripted approval answers, and is compared with its `expect`.
import { createTestDatabase } from '@memwise/db';
import type { ExampleCase, ProjectDefs, WorkflowDef } from '@memwise/defs';
import { scriptedProvider, stubTools, type ToolDefinition } from '@memwise/gateway';
import { isDeepStrictEqual } from 'node:util';
import { createKernel } from './kernel.ts';
import { stateKind } from './machine.ts';
import { sampleTools } from './sample-tools.ts';
import type { RunRecord } from './types.ts';

export type ExampleResult =
  | { status: 'pass' | 'fail'; workflow: string; example: string; differences: string[]; run?: RunRecord }
  | { status: 'skip'; workflow: string; example: string; reason: string };

export interface RunExampleOptions {
  /** Admin URL of a Postgres server to create the throwaway database on; default a throwaway cluster. */
  adminUrl?: string;
  /** Tools before stubbing; default the sample tool set. */
  tools?: (databaseUrl: string) => ToolDefinition[];
  timeoutMs?: number;
}

const show = (v: unknown) => JSON.stringify(v);

export async function runExample(project: ProjectDefs, workflow: WorkflowDef, example: ExampleCase, opts: RunExampleOptions = {}): Promise<ExampleResult> {
  const ids = { workflow: workflow.id, example: example.name };
  if (!example.model) return { ...ids, status: 'skip', reason: 'no model script; it needs a live model' };
  if (opts.adminUrl) process.env.MEMWISE_TEST_DATABASE_URL = opts.adminUrl;
  const db = await createTestDatabase('mw_example');
  try {
    const kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: project.root,
      tools: stubTools((opts.tools ?? ((url) => sampleTools({ databaseUrl: url })))(db.url), example.tools ?? {}),
      modelRoles: Object.fromEntries(Object.keys(example.model).map((role) => [role, { provider: 'scripted', model: 'scripted' }])),
      providers: [scriptedProvider(example.model)],
      logLevel: 'error', // the run is left waiting at shutdown on purpose; DBOS warns about that
    });
    try {
      await kernel.index();
      const startAt = example.startAt ?? workflow.start;
      const { runId, caseId } = await kernel.startRun({ workflowId: workflow.id, workflowHash: workflow.hash, case: example.case, startAt });
      const run = await settle(kernel, runId, workflow, example, opts.timeoutMs ?? 60_000);

      const differences: string[] = [];
      const want = example.expect;
      if (want.outcome !== undefined) {
        const record = await kernel.getStepRecord(`${runId}/0/${startAt}`);
        const outcome = record?.outcome ?? (await kernel.getTransitions(runId))[0]?.event.type;
        if (outcome !== want.outcome) differences.push(`outcome: expected ${want.outcome}, got ${outcome ?? '(none)'}`);
      }
      if (want.state !== undefined && run.state !== want.state) {
        differences.push(`state: expected ${want.state}, got ${run.state}${run.stopReason ? ` (stopped: ${run.stopReason})` : ''}`);
      }
      const values = (await kernel.getCase(caseId))?.values ?? {};
      for (const [field, value] of Object.entries(want.writes ?? {})) {
        if (!isDeepStrictEqual(values[field]?.value, value)) differences.push(`writes.${field}: expected ${show(value)}, got ${show(values[field]?.value)}`);
      }
      if (want.effects) {
        const { rows } = await kernel.pool.query(
          `select tool, count(*)::int as n from mw.effects where step_run_id like $1 and status = 'done' group by tool`, [`${runId}/%`]);
        const done = Object.fromEntries(rows.map((r) => [r.tool, r.n]));
        for (const [tool, n] of Object.entries(want.effects)) {
          if ((done[tool] ?? 0) !== n) differences.push(`effects.${tool}: expected ${n}, got ${done[tool] ?? 0}`);
        }
      }
      return { ...ids, status: differences.length ? 'fail' : 'pass', differences, run };
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await db.drop();
  }
}

/** Until the run waits (a state that is not an agent step) or stops, answering approvals as the example says. */
async function settle(kernel: Awaited<ReturnType<typeof createKernel>>, runId: string, workflow: WorkflowDef, example: ExampleCase, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const startsWaiting = stateKind(workflow, example.startAt ?? workflow.start) !== 'agent-step';
  for (;;) {
    for (const a of await kernel.pendingApprovals()) {
      const answer = example.approvals?.[a.tool];
      if (answer && a.stepRunId.startsWith(`${runId}/`)) {
        await kernel.decideApproval({ id: a.id, status: answer === 'approve' ? 'approved' : 'rejected', by: 'example', at: new Date().toISOString() });
      }
    }
    const run = (await kernel.getRun(runId))!;
    if (run.status !== 'active' || ((run.seq > 0 || startsWaiting) && stateKind(workflow, run.state) !== 'agent-step')) return run;
    if (Date.now() > deadline) throw new Error(`example ${example.name}: run still in ${run.state} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
