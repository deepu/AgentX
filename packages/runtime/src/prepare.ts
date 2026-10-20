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
    `select attempt, status, outcome, rationale from mw.step_runs
      where run_id = $1 and step_id = $2 and id <> $3 order by started_at, id`, [run.id, run.state, stepRunId]);
  const now = Date.now();
  const ttl = step.budget?.timeMs ?? effective.budgets.timeMs?.value ?? DEFAULT_TOKEN_TTL_MS;
  return {
    input: {
      stepRunId, runId: run.id,
      workflow: { id: workflow.id, version: workflow.version, hash: workflow.hash },
      step, recordTypes: workflow.caseType.types, case: snapshot, policy: effective,
      token: tokenFor(run, workflow, stepRunId, now, ttl),
      attempt: prev.rows.length + 1,
      priorAttempts: prev.rows.map((p, i) => ({
        attempt: p.attempt ?? i + 1, ...(p.outcome ? { outcome: p.outcome } : {}), reason: p.rationale ?? `ended ${p.status}`,
      })),
      startedAt: now,
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
 * Person and external steps have no step workflow yet (forms and inbox come in Phase 2), but
 * get a `waiting` step run so they are visible; the commit that leaves the state completes it.
 */
export async function openWaitingStep(db: Queryable, run: RunRow, workflow: WorkflowDef, stepRunId: string) {
  const step = workflow.steps[run.state]!;
  const prev = await db.query(`select count(*)::int as n from mw.step_runs where run_id = $1 and step_id = $2 and id <> $3`,
    [run.id, run.state, stepRunId]);
  const now = Date.now();
  await db.query(
    `insert into mw.step_runs (id, run_id, case_id, step_id, attempt, workflow_id, workflow_version, workflow_hash,
                               step_hash, performer, status, token, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'waiting', $11, $12)
     on conflict (id) do nothing`,
    [stepRunId, run.id, run.caseId, run.state, prev.rows[0].n + 1, workflow.id, workflow.version, workflow.hash,
      step.hash, step.performer, JSON.stringify(tokenFor(run, workflow, stepRunId, now, DEFAULT_TOKEN_TTL_MS)), new Date(now)]);
}
