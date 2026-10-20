// Example cases as acceptance tests (05 §12): each runs on a fresh database with a scripted
// model, stubbed tools and scripted approval answers, and is compared with its `expect`.
import { createTestDatabase } from '@memwise/db';
import type { ExampleCase, ExampleSubmission, ProjectDefs, WorkflowDef } from '@memwise/defs';
import { scriptedProvider, stubTools, type ToolDefinition } from '@memwise/gateway';
import { isDeepStrictEqual } from 'node:util';
import { createKernel } from './kernel.ts';
import { stateKind } from './machine.ts';
import { sampleTools } from './sample-tools.ts';
import type { Actor, Kernel, RunRecord } from './types.ts';

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
  const startKind = stateKind(workflow, example.startAt ?? workflow.start);
  // Without a model script only an example that never reaches an agent step can run (e.g. onboard).
  if (!example.model && (startKind === 'agent-step' || example.submit)) return { ...ids, status: 'skip', reason: 'no model script; it needs a live model' };
  if (opts.adminUrl) process.env.MEMWISE_TEST_DATABASE_URL = opts.adminUrl;
  const db = await createTestDatabase('mw_example');
  try {
    const kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: project.root,
      tools: stubTools((opts.tools ?? ((url) => sampleTools({ databaseUrl: url })))(db.url), example.tools ?? {}),
      modelRoles: Object.fromEntries(Object.keys(example.model ?? {}).map((role) => [role, { provider: 'scripted', model: 'scripted' }])),
      providers: [scriptedProvider(example.model ?? {})],
      logLevel: 'error', // the run is left waiting at shutdown on purpose; DBOS warns about that
    });
    try {
      await kernel.index();
      const startAt = example.startAt ?? workflow.start;
      // One person with every role answers the example's person steps.
      const person = await kernel.people.create({ name: 'Example', email: 'example@memwise.invalid', roles: Object.keys(project.roles ?? {}) });
      const by: Actor = { kind: 'person', personId: person.id, roles: person.roles };
      const { runId, caseId } = await kernel.startRun({ workflowId: workflow.id, workflowHash: workflow.hash, case: example.case, startAt });
      const differences: string[] = [];
      const run = await settle(kernel, runId, workflow, example, opts.timeoutMs ?? 60_000, by, differences);

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
      for (const [entity, expected] of Object.entries(want.entities ?? {})) {
        const rows = await kernel.listEntities(entity, { kind: 'system' });
        const count = typeof expected === 'number' ? expected : expected.length;
        if (rows.length !== count) differences.push(`entities.${entity}: expected ${count} row(s), got ${rows.length}`);
        if (typeof expected === 'number') continue;
        expected.forEach((fields, i) => {
          const hit = rows.some((r) => Object.entries(fields).every(([k, v]) => isDeepStrictEqual(r.values[k], v)));
          if (!hit) differences.push(`entities.${entity}[${i}]: no row with ${show(fields)}`);
        });
      }
      return { ...ids, status: differences.length ? 'fail' : 'pass', differences, run };
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await db.drop();
  }
}

const runsItself = (workflow: WorkflowDef, state: string) => {
  const kind = stateKind(workflow, state);
  return kind === 'agent-step' || kind === 'system-step';
};

/**
 * Until the run waits (a state that is not an agent or system step) without an answer left in
 * the example, or stops; answering approvals and person steps as the example says.
 */
async function settle(kernel: Kernel, runId: string, workflow: WorkflowDef, example: ExampleCase, timeoutMs: number, by: Actor, differences: string[]) {
  const deadline = Date.now() + timeoutMs;
  const startsWaiting = !runsItself(workflow, example.startAt ?? workflow.start);
  const used: Record<string, number> = {};
  const answerFor = (state: string): ExampleSubmission | undefined => {
    const a = example.submit?.[state];
    if (!a) return undefined;
    if (!Array.isArray(a)) return a;
    return a[used[state] ?? 0];
  };
  for (;;) {
    for (const a of await kernel.pendingApprovals()) {
      const answer = example.approvals?.[a.tool];
      if (answer && a.stepRunId.startsWith(`${runId}/`)) {
        await kernel.decideApproval({ id: a.id, status: answer === 'approve' ? 'approved' : 'rejected', by: 'example', at: new Date().toISOString() });
      }
    }
    const run = (await kernel.getRun(runId))!;
    const waits = run.status === 'active' && !runsItself(workflow, run.state);
    const answer = waits ? answerFor(run.state) : undefined;
    if (answer && by.kind === 'person') {
      const stepRunId = `${runId}/${run.enteredSeq}/${run.state}`;
      const record = await kernel.getStepRecord(stepRunId);
      if (record?.status === 'waiting') {
        const r = await kernel.submitStep({ stepRunId, outcome: answer.outcome, values: answer.values, comment: answer.comment, by });
        if (!r.applied) {
          differences.push(`submit.${run.state}: ${r.status}${r.message ? ` (${r.message})` : ''}${r.errors ? ` ${show(r.errors)}` : ''}`);
          return run;
        }
        used[run.state] = (used[run.state] ?? 0) + 1;
        if (Object.values(used).reduce((a, b) => a + b, 0) > 50) {
          differences.push('submit: more than 50 answers; the run loops');
          return run;
        }
        await kernel.waitForRun(runId, { until: (x) => x.seq > run.seq, timeoutMs: Math.max(1000, deadline - Date.now()) });
        continue;
      }
    } else if (run.status !== 'active' || ((run.seq > 0 || startsWaiting) && waits)) return run;
    if (Date.now() > deadline) throw new Error(`example ${example.name}: run still in ${run.state} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
