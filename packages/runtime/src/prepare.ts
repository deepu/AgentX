// Everything a step run needs, read and fixed once inside a journaled DBOS step, so a replay
// after a crash hands the step workflow byte-identical input (D38, D39).
import { domainOf, type CaseSnapshot, type StepDef, type StepToken, type WorkflowDef } from '@memwise/defs';
import { compilePolicy, layersFor, pluginLayers } from '@memwise/policy';
import type { StepRunInput } from '@memwise/step-engine';
import { PgCaseStore } from '@memwise/db';
import { loadPluginPolicies, loadPolicySources, policyLayersFor, type Queryable, type RunRow } from './runs.ts';

const DEFAULT_TOKEN_TTL_MS = 3600_000;

export type PreparedStep = { input: StepRunInput } | { stop: string };

export async function prepareAgentStep(db: Queryable, run: RunRow, workflow: WorkflowDef, stepRunId: string): Promise<PreparedStep> {
  const step = workflow.steps[run.state];
  if (!step) throw new Error(`state ${run.state} has no step`);
  const plugins = pluginLayers(await loadPluginPolicies(db), workflow, step);
  const { effective, violations } = compilePolicy(layersFor({ ...policyLayersFor(await loadPolicySources(db), domainOf(workflow)), plugins, workflow, step }));
  if (violations.length) {
    return { stop: `policy violations: ${violations.map((v) => `${v.source ?? v.name} ${v.path}: ${v.message}`).join('; ')}` };
  }
  const snapshot = await new PgCaseStore().get(db, run.caseId);
  if (!snapshot) throw new Error(`no case ${run.caseId}`);
  const taintedReads = await taintedFieldsRead(db, step, snapshot);
  const prev = await db.query(
    `select attempt, status, outcome, rationale, started_at from mw.step_runs
      where run_id = $1 and step_id = $2 and id <> $3 order by started_at, id`, [run.id, run.state, stepRunId]);
  // A person who sent the case back said why (submitStep's comment): the next attempt of this
  // step is told, as repair context, about every comment made since its last attempt began.
  const comments = await commentsSince(db, run.id, run.state, stepRunId, prev.rows.at(-1)?.started_at ?? new Date(0));
  // What earlier step runs of this run used, so run budgets cover the whole run (StepRunInput.runSpent).
  const spent = await db.query(
    `select coalesce(sum((usage->>'tokens')::float8), 0) as tokens, coalesce(sum((usage->>'modelCalls')::float8), 0) as model_calls,
            coalesce(sum((usage->>'durationMs')::float8), 0) as duration_ms
       from mw.step_runs where run_id = $1 and id <> $2`, [run.id, stepRunId]);
  const s = spent.rows[0];
  // Money spent by earlier step runs, when it was all in one currency (otherwise not compared).
  const money = await db.query(
    `select usage->'cost'->>'currency' as currency, coalesce(sum((usage->'cost'->>'amount')::float8), 0) as amount
       from mw.step_runs where run_id = $1 and id <> $2 and usage ? 'cost' group by 1`, [run.id, stepRunId]);
  const now = Date.now();
  const ttl = step.budget?.timeMs ?? effective.budgets.timeMs?.value ?? DEFAULT_TOKEN_TTL_MS;
  return {
    input: {
      stepRunId, runId: run.id,
      workflow: { id: workflow.id, version: workflow.version, hash: workflow.hash },
      step, recordTypes: workflow.caseType.types, case: snapshot, policy: effective,
      token: tokenFor(run, workflow, stepRunId, now, ttl),
      attempt: prev.rows.length + 1,
      priorAttempts: [
        ...prev.rows.map((p, i) => ({
          attempt: p.attempt ?? i + 1, ...(p.outcome ? { outcome: p.outcome } : {}), reason: p.rationale ?? `ended ${p.status}`,
        })),
        ...comments.map((c) => ({
          attempt: prev.rows.length, outcome: `${c.stepId}: ${c.outcome ?? 'answered'}`,
          reason: `${workflow.steps[c.stepId]?.title ?? c.stepId} — ${c.who} wrote: ${c.comment}`,
        })),
      ],
      startedAt: now,
      ...(taintedReads.length ? { tainted: true, taintedReads } : {}),
      runSpent: {
        tokens: Number(s.tokens), modelCalls: Number(s.model_calls), elapsedMs: Number(s.duration_ms),
        ...(money.rows.length === 1 ? { money: { amount: Number(money.rows[0].amount), currency: money.rows[0].currency } } : {}),
      },
    },
  };
}

interface ReturnedComment { stepId: string; outcome?: string; comment: string; by?: string; who: string; at: string }

/** Comments people made on other steps of the run since `since` (a send-back's reason). */
async function commentsSince(db: Queryable, runId: string, stepId: string, stepRunId: string, since: Date | string): Promise<ReturnedComment[]> {
  const { rows } = await db.query(
    `select s.step_id, s.outcome, s.comment, s.decided_by, coalesce(p.name, s.decided_by) as who, coalesce(s.finished_at, s.started_at) as at
       from mw.step_runs s left join mw.people p on p.id = s.decided_by
      where s.run_id = $1 and s.comment is not null and s.id <> $2 and s.step_id <> $3 and s.started_at >= $4
      order by s.started_at, s.id`, [runId, stepRunId, stepId, since]);
  return rows.map((c) => ({
    stepId: c.step_id, ...(c.outcome ? { outcome: c.outcome } : {}), comment: c.comment, ...(c.decided_by ? { by: c.decided_by } : {}),
    who: c.who, at: c.at instanceof Date ? c.at.toISOString() : String(c.at),
  }));
}

/**
 * What the case came back with to this step run (Phase 3): the comments people made on other
 * steps since the previous attempt of this step began (all of them for a first attempt), e.g. a
 * reviewer's "changes requested".
 * An agent step gets them as prior attempts; a conversation step's chat shows them in its context.
 */
export async function returnedComments(db: Queryable, stepRunId: string): Promise<ReturnedComment[]> {
  const { rows } = await db.query(`select run_id, step_id, started_at from mw.step_runs where id = $1`, [stepRunId]);
  const s = rows[0];
  if (!s) return [];
  const prev = await db.query(
    `select max(started_at) as last from mw.step_runs where run_id = $1 and step_id = $2 and id <> $3 and started_at < $4`,
    [s.run_id, s.step_id, stepRunId, s.started_at]);
  return commentsSince(db, s.run_id, s.step_id, stepRunId, prev.rows[0]?.last ?? new Date(0));
}

/** The case fields a step reads: its `reads` and, for a system step, what its `map` passes to tools. */
export function stepReadFields(step: StepDef): string[] {
  const head = (path: string) => (path.startsWith('case.') ? path.slice(5) : path).split('.')[0]!;
  const fields = new Set(step.reads.map(head));
  for (const args of Object.values(step.map ?? {})) {
    for (const src of Object.values(args)) if ('case' in src) fields.add(head(src.case));
  }
  for (const path of Object.values(step.each ?? {})) fields.add(head(path));
  return [...fields].sort();
}

/**
 * Which of those hold untrusted content: in mw.cases.tainted_fields (kept by the commit) or
 * marked in the value's provenance. Taint follows the value into every later step (D21).
 */
async function taintedFieldsRead(db: Queryable, step: StepDef, snapshot: CaseSnapshot): Promise<string[]> {
  const { rows } = await db.query('select tainted_fields from mw.cases where id = $1', [snapshot.id]);
  const tainted = new Set<string>(rows[0]?.tainted_fields ?? []);
  for (const [field, v] of Object.entries(snapshot.values)) if ((v.provenance as { tainted?: boolean }).tainted) tainted.add(field);
  return stepReadFields(step).filter((f) => tainted.has(f) && snapshot.values[f] !== undefined);
}

export function tokenFor(run: RunRow, workflow: WorkflowDef, stepRunId: string, now: number, ttlMs: number): StepToken {
  return {
    runId: run.id, caseId: run.caseId, stepId: run.state, stepRunId,
    workflowId: workflow.id, workflowVersion: workflow.version,
    agentRole: `${workflow.id}.${run.state}`, ...(run.actsFor ? { actsFor: run.actsFor } : {}),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

/**
 * Person and external steps have no step workflow: they get a `waiting` step run, assigned to
 * the step's role, that the inbox shows and submitStep answers; the commit that leaves the state completes it.
 */
export async function openWaitingStep(db: Queryable, run: RunRow, workflow: WorkflowDef, stepRunId: string) {
  const step = workflow.steps[run.state]!;
  const prev = await db.query(`select count(*)::int as n from mw.step_runs where run_id = $1 and step_id = $2 and id <> $3`,
    [run.id, run.state, stepRunId]);
  const now = Date.now();
  await db.query(
    `insert into mw.step_runs (id, run_id, case_id, step_id, attempt, workflow_id, workflow_version, workflow_hash,
                               step_hash, performer, status, token, started_at, assignee)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'waiting', $11, $12, $13)
     on conflict (id) do nothing`,
    [stepRunId, run.id, run.caseId, run.state, prev.rows[0].n + 1, workflow.id, workflow.version, workflow.hash,
      step.hash, step.performer, JSON.stringify(tokenFor(run, workflow, stepRunId, now, DEFAULT_TOKEN_TTL_MS)), new Date(now),
      step.assignee ?? null]);
}
