// Everything a step run needs, read and fixed once inside a journaled DBOS step, so a replay
// after a crash hands the step workflow byte-identical input (D38, D39).
import type { StepToken, WorkflowDef } from '@memwise/defs';
import { compilePolicy, layersFor } from '@memwise/policy';
import type { StepRunInput } from '@memwise/step-engine';
import { PgCaseStore } from '@memwise/db';
import { loadDomainPolicy, type Queryable, type RunRow } from './runs.ts';

const DEFAULT_TOKEN_TTL_MS = 3600_000;

export type PreparedStep = { input: StepRunInput } | { stop: string };

export async function prepareAgentStep(db: Queryable, run: RunRow, workflow: WorkflowDef, stepRunId: string): Promise<PreparedStep> {
  const step = workflow.steps[run.state];
  if (!step) throw new Error(`state ${run.state} has no step`);
  const { effective, violations } = compilePolicy(layersFor({ domainPolicy: await loadDomainPolicy(db), workflow, step }));
  if (violations.length) {
    return { stop: `policy violations: ${violations.map((v) => `${v.source ?? v.name} ${v.path}: ${v.message}`).join('; ')}` };
  }
  const snapshot = await new PgCaseStore().get(db, run.caseId);
  if (!snapshot) throw new Error(`no case ${run.caseId}`);
  const prev = await db.query(
    `select attempt, status, outcome, rationale, started_at from mw.step_runs
      where run_id = $1 and step_id = $2 and id <> $3 order by started_at, id`, [run.id, run.state, stepRunId]);
  // A person who sent the case back said why (submitStep's comment): the next attempt of this
  // step is told, as repair context, about every comment made since its last attempt began.
  const last = prev.rows.at(-1)?.started_at ?? null;
  const comments = last === null ? { rows: [] as any[] } : await db.query(
    `select s.step_id, s.outcome, s.comment, s.decided_by, coalesce(p.name, s.decided_by) as who from mw.step_runs s
       left join mw.people p on p.id = s.decided_by
      where s.run_id = $1 and s.comment is not null and s.id <> $2 and s.step_id <> $3 and s.started_at >= $4
      order by s.started_at, s.id`, [run.id, stepRunId, run.state, last]);
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
        ...comments.rows.map((c) => ({
          attempt: prev.rows.length, outcome: `${c.step_id}: ${c.outcome ?? 'answered'}`,
          reason: `${workflow.steps[c.step_id]?.title ?? c.step_id} — ${c.who} wrote: ${c.comment}`,
        })),
      ],
      startedAt: now,
      runSpent: {
        tokens: Number(s.tokens), modelCalls: Number(s.model_calls), elapsedMs: Number(s.duration_ms),
        ...(money.rows.length === 1 ? { money: { amount: Number(money.rows[0].amount), currency: money.rows[0].currency } } : {}),
      },
    },
  };
}

export function tokenFor(run: RunRow, workflow: WorkflowDef, stepRunId: string, now: number, ttlMs: number): StepToken {
  return {
    runId: run.id, caseId: run.caseId, stepId: run.state, stepRunId,
    workflowId: workflow.id, workflowVersion: workflow.version,
    agentRole: `${workflow.id}.${run.state}`,
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
