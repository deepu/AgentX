// Example cases as acceptance tests (05 §12): each runs on a fresh database with a scripted
// model, stubbed tools and scripted approval answers, and is compared with its `expect`.
import { createTestDatabase } from '@memwise/db';
import { DEFAULT_DOMAIN, END_STATE, isConversationStep, keyOf, type ExampleCase, type ExampleSubmission, type ExampleTrace, type ProjectDefs, type StepDef, type WorkflowDef } from '@memwise/defs';
import { scriptedProvider, stubTools, type ToolDefinition } from '@memwise/gateway';
import { isDeepStrictEqual } from 'node:util';
import { authoringToolDefinitions } from './authoring-tools.ts';
import { kernelKey, linkStatus, tokenOf, type LinkRow } from './external/links.ts';
import { externalToolDefinitions } from './external/service.ts';
import { bindingToolDefinitions } from './plugins/kernel-tools.ts';
import { pageToolDefinitions } from './pages/tools.ts';
import { McpConnections } from './plugins/routes.ts';
import { boundPlugins, pluginTool, toolClass } from './plugins/tools.ts';
import { createKernel } from './kernel.ts';
import { entityByName } from './records/context.ts';
import { sampleTools } from './sample-tools.ts';
import type { Actor, Kernel, RunRecord } from './types.ts';

export type ExampleResult =
  | { status: 'pass' | 'fail'; workflow: string; example: string; differences: string[]; run?: RunRecord; trace?: ExampleTrace }
  | { status: 'skip'; workflow: string; example: string; reason: string };

export interface RunExampleOptions {
  /** Admin URL of a Postgres server to create the throwaway database on; default a throwaway cluster. */
  adminUrl?: string;
  /** Tools before stubbing; default the sample tool set. */
  tools?: (databaseUrl: string) => ToolDefinition[];
  timeoutMs?: number;
}

const show = (v: unknown) => JSON.stringify(v);

/** The public address links are made from in example cases (nothing is served there). */
export const EXAMPLE_PUBLIC_URL = 'https://memwise.example';

export async function runExample(project: ProjectDefs, workflow: WorkflowDef, example: ExampleCase, opts: RunExampleOptions = {}): Promise<ExampleResult> {
  const ids = { workflow: workflow.id, example: example.name };
  // Without a model script only an example that can't reach an agent step on our own engine can
  // run (e.g. onboard, or a meta playbook whose only agent step is a conversation answered by `submit:`).
  if (!example.model && reachesModelStep(workflow, example)) return { ...ids, status: 'skip', reason: 'no model script; it needs a live model' };
  if (opts.adminUrl) process.env.MEMWISE_TEST_DATABASE_URL = opts.adminUrl;
  const db = await createTestDatabase('mw_example');
  try {
    // The playbooks.* and plugins.* definitions too, so meta-playbook examples can stub them.
    const tools = new Map<string, ToolDefinition>();
    const base = (opts.tools ?? ((url) => sampleTools({ databaseUrl: url })))(db.url);
    for (const t of [...base, ...authoringToolDefinitions(), ...bindingToolDefinitions(), ...pageToolDefinitions()]) {
      if (!tools.has(t.name)) tools.set(t.name, t);
    }
    // `external.invite` is the kernel's own, sending through the (sample or stubbed) channel
    // tools; an example that stubs it binds the stub instead.
    for (const t of externalToolDefinitions()) {
      if (!tools.has(t.name) && Object.hasOwn(example.tools ?? {}, t.name)) tools.set(t.name, t);
    }
    // Plugin tools the example stubs (Phase 4): bound here, stubbed, so they win over the kernel's own.
    const noMcp = new McpConnections();
    for (const bp of boundPlugins(project)) {
      for (const t of Object.values(bp.manifest.tools)) {
        if (tools.has(t.name) || !Object.hasOwn(example.tools ?? {}, t.name) || toolClass(t, bp.binding).off) continue;
        tools.set(t.name, pluginTool(t, bp, { root: project.root, builtins: new Map(base.map((b) => [b.name, b])), mcp: noMcp }));
      }
    }
    const kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: project.root,
      tools: stubTools([...tools.values()], example.tools ?? {}),
      builtins: base,
      modelRoles: Object.fromEntries(Object.keys(example.model ?? {}).map((role) => [role, { provider: 'scripted', model: 'scripted' }])),
      providers: [scriptedProvider(example.model ?? {})],
      logLevel: 'error', // the run is left waiting at shutdown on purpose; DBOS warns about that
      publicUrl: () => EXAMPLE_PUBLIC_URL,
      businessName: 'Example Business',
    });
    try {
      await kernel.index();
      const startAt = example.startAt ?? workflow.start;
      // One person with every role answers the example's person steps.
      const person = await kernel.people.create({
        name: 'Example', email: 'example@memwise.invalid', roles: Object.keys(project.roles ?? {}), password: EXAMPLE_PASSWORD,
      });
      const by: Actor = { kind: 'person', personId: person.id, roles: person.roles };
      // Phase 6: the records the example starts from, created as the system (with their ids and status).
      const seeded = await seedRecords(kernel, project, workflow, example);
      if (seeded.length) return { ...ids, status: 'fail', differences: seeded };
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
        const key = entityKeyIn(project, workflow, entity);
        const rows = key ? await kernel.listEntities(key, { kind: 'system' }) : [];
        if (!key) { differences.push(`entities.${entity}: there is no entity type ${entity}`); continue; }
        const count = typeof expected === 'number' ? expected : expected.length;
        if (rows.length !== count) differences.push(`entities.${entity}: expected ${count} row(s), got ${rows.length}`);
        if (typeof expected === 'number') continue;
        expected.forEach((fields, i) => {
          const hit = rows.some((r) => Object.entries(fields).every(([k, v]) => isDeepStrictEqual(r.values[k], v)));
          if (!hit) differences.push(`entities.${entity}[${i}]: no row with ${show(fields)}`);
        });
      }
      const trace = await traceOf(kernel, workflow, run.id, values, new Set(Object.keys(example.tools ?? {}))).catch(() => undefined);
      return { ...ids, status: differences.length ? 'fail' : 'pass', differences, run, ...(trace ? { trace } : {}) };
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await db.drop();
  }
}

/** What the run did (Stage 4 test runs show it): its step runs, tool calls and values, in order. */
async function traceOf(kernel: Kernel, workflow: WorkflowDef, runId: string, values: Record<string, { value: unknown }>, stubbed: Set<string>): Promise<ExampleTrace> {
  const run = (await kernel.getRun(runId))!;
  const { rows: steps } = await kernel.pool.query<{ id: string; step_id: string; status: string; outcome: string | null }>(
    `select id, step_id, status, outcome from mw.step_runs where run_id = $1 order by started_at, id`, [runId]);
  const { rows: calls } = await kernel.pool.query<{ step_id: string; name: string; request: { args?: Record<string, unknown> } | null; error: string | null }>(
    `select s.step_id, j.name, j.request, j.error from mw.step_journal j join mw.step_runs s on s.id = j.step_run_id
      where s.run_id = $1 and j.kind = 'tool' order by s.started_at, s.id, j.started_at, j.journal_key`, [runId]);
  return {
    steps: steps.map((s) => {
      const step = stepIn(workflow, s.step_id);
      return {
        state: s.step_id, status: s.status,
        ...(step?.title ? { title: step.title } : {}), ...(step ? { performer: step.performer } : {}), ...(s.outcome ? { outcome: s.outcome } : {}),
      };
    }),
    state: run.state,
    status: run.status,
    calls: calls.map((c) => ({
      state: c.step_id, tool: c.name, args: c.request?.args ?? {},
      ...(stubbed.has(c.name) ? { stubbed: true } : {}), ...(c.error ? { error: c.error } : {}),
    })),
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value])),
  };
}

/** The example person's password, so signed steps can be answered. */
const EXAMPLE_PASSWORD = 'example-signature-password';

/** An entity named in an example (a key, or bare in the workflow's domain) as its key. */
function entityKeyIn(project: ProjectDefs, workflow: WorkflowDef, name: string): string | undefined {
  const def = entityByName(project.entities, name, workflow.domain ?? DEFAULT_DOMAIN);
  return def ? keyOf(def) : undefined;
}

/** Creates the example's `records:` in order, as the system. Returns what went wrong. */
async function seedRecords(kernel: Kernel, project: ProjectDefs, workflow: WorkflowDef, example: ExampleCase): Promise<string[]> {
  const problems: string[] = [];
  for (const [entity, rows] of Object.entries(example.records ?? {})) {
    const key = entityKeyIn(project, workflow, entity);
    if (!key) { problems.push(`records.${entity}: there is no entity type ${entity}`); continue; }
    for (const [i, row] of rows.entries()) {
      const { id, status, ...values } = row as Record<string, unknown> & { id?: string; status?: string };
      const r = await kernel.records.create({
        entity: key, values, ...(typeof status === 'string' ? { status } : {}), ...(typeof id === 'string' ? { id } : {}),
      }, { kind: 'system' });
      if (!r.applied) problems.push(`records.${entity}[${i}]: ${r.message ?? r.status}${r.errors ? ` ${show(r.errors)}` : ''}`);
    }
  }
  return problems;
}

const stepIn = (workflow: WorkflowDef, state: string): StepDef | undefined => {
  const def = workflow.states[state];
  return def ? workflow.steps[def.step ?? state] : undefined;
};

/** Whether the run moves on by itself in `state`: an agent step on our engine, or a system step. Conversations wait. */
const runsItself = (workflow: WorkflowDef, state: string) => {
  const step = stepIn(workflow, state);
  return !!step && (step.performer === 'system' || (step.performer === 'agent' && !isConversationStep(step)));
};

/**
 * Whether the example's run can reach an agent step that needs a model (not a conversation):
 * from its start, through steps that run by themselves and the waits the example answers.
 */
function reachesModelStep(workflow: WorkflowDef, example: ExampleCase): boolean {
  const seen = new Set<string>();
  const queue = [example.startAt ?? workflow.start];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name) || name === END_STATE) continue;
    seen.add(name);
    const step = stepIn(workflow, name);
    if (step?.performer === 'agent' && !isConversationStep(step)) return true;
    // A wait without an answer is where the run stops (timeouts don't fire within an example).
    if (!runsItself(workflow, name) && !workflow.states[name]?.block && !example.submit?.[name]) continue;
    queue.push(...Object.values(workflow.states[name]?.on ?? {}));
  }
  return false;
}

/** The newest open link to `stepId` of the run, with its token. */
async function openLink(kernel: Kernel, runId: string, stepId: string): Promise<string | undefined> {
  const { rows } = await kernel.pool.query<LinkRow>(
    `select * from mw.external_links where kind = 'step' and run_id = $1 and step_id = $2 order by created_at desc, id desc`, [runId, stepId]);
  const row = rows.find((r) => linkStatus(r) === 'open');
  return row ? tokenOf(await kernelKey(kernel.pool, 'links'), row) : undefined;
}

/**
 * Answers an external step as its participant would: documents named in the answer are uploaded
 * through the link first (as small text files with those names), then the form is sent.
 */
async function submitThroughLink(kernel: Kernel, token: string, step: StepDef, answer: ExampleSubmission): Promise<{ applied: boolean; status: string; message?: string; errors?: Record<string, string[]> }> {
  const values: Record<string, unknown> = { ...(answer.values ?? {}) };
  for (const [field, w] of Object.entries(step.writes)) {
    const isDocs = w.type.kind === 'list' && w.type.of.kind === 'scalar' && ['Document', 'File', 'Image'].includes(w.type.of.name);
    const isDoc = w.type.kind === 'scalar' && ['Document', 'File', 'Image'].includes(w.type.name);
    if ((!isDocs && !isDoc) || values[field] === undefined) continue;
    const ids: string[] = [];
    for (const d of (Array.isArray(values[field]) ? values[field] : [values[field]]) as unknown[]) {
      const name = typeof d === 'string' ? d : String((d as { name?: unknown })?.name ?? 'document.txt');
      const up = await kernel.external.upload(token, { name, mime: 'text/plain', data: new TextEncoder().encode(`Example document: ${name}\n`) });
      if (!('document' in up)) return { applied: false, status: 'invalid', message: up.message };
      ids.push(up.document.id);
    }
    values[field] = isDocs ? ids : ids[0];
  }
  const r = await kernel.external.submit(token, { outcome: answer.outcome, values });
  return r.status === 'applied'
    ? { applied: true, status: 'applied' }
    : { applied: false, status: r.status, message: r.message, ...('errors' in r && r.errors ? { errors: r.errors } : {}) };
}

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
    let unanswered = false;
    for (const a of await kernel.pendingApprovals()) {
      if (!a.stepRunId.startsWith(`${runId}/`)) continue;
      const answer = example.approvals?.[a.tool];
      if (answer) {
        await kernel.decideApproval({ id: a.id, status: answer === 'approve' ? 'approved' : 'rejected', by: 'example', at: new Date().toISOString() });
      } else {
        unanswered = true;
      }
    }
    const run = (await kernel.getRun(runId))!;
    // A block state (Phase 6: start, call, for_each, wait_until) moves on through the flow's
    // dispatcher: let it catch up; still there afterwards, the run waits (on data or on other cases).
    if (run.status === 'active' && workflow.states[run.state]?.block) {
      await kernel.triggers.settle(Math.max(1000, Math.min(10_000, deadline - Date.now())));
      // The block's event (met, started, a child's outcome) reaches the run just after the flow settles.
      const after = await kernel.waitForRun(runId, { until: (x) => x.seq !== run.seq || x.status !== run.status, timeoutMs: 3000 })
        .catch(async () => (await kernel.getRun(runId))!);
      if (after.seq !== run.seq || after.status !== run.status) continue;
      return run;
    }
    // A step waiting on an approval the example doesn't answer waits for a person: the run settles there.
    if (unanswered && run.status === 'active' && runsItself(workflow, run.state)) {
      const waiting = (await kernel.pendingApprovals()).some((a) => a.stepRunId === `${runId}/${run.enteredSeq}/${run.state}`);
      if (waiting) return run;
    }
    const waits = run.status === 'active' && !runsItself(workflow, run.state);
    const answer = waits ? answerFor(run.state) : undefined;
    if (answer && by.kind === 'person') {
      const stepRunId = `${runId}/${run.enteredSeq}/${run.state}`;
      const record = await kernel.getStepRecord(stepRunId);
      if (record?.status === 'waiting') {
        // A conversation step is answered by its chat; here the example plays the chat.
        const step = stepIn(workflow, run.state);
        const via = step && isConversationStep(step) ? { via: { chatId: 'example', ...(answer.comment ? { rationale: answer.comment } : {}) } } : {};
        // An external step the client was sent a link to is answered through that link, as the client.
        const link = step?.performer === 'external' ? await openLink(kernel, runId, step.id) : undefined;
        const r = link
          ? await submitThroughLink(kernel, link, step!, answer)
          : await kernel.submitStep({
            stepRunId, outcome: answer.outcome, values: answer.values, comment: answer.comment, by, ...via,
            // A signed step (Phase 6) is signed with the example person's password.
            ...(step?.sign ? { signature: { password: EXAMPLE_PASSWORD } } : {}),
          });
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
