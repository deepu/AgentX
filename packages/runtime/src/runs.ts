// SQL over mw.runs, mw.transitions, mw.timers and mw.definitions (0001_kernel.sql). Every function
// takes the caller's connection so it can run inside the commit transaction.
import type { PolicyDoc, WorkflowDef } from '@memwise/defs';
import type { RunEvent } from './machine.ts';
import type { RunRecord, TimerRecord, TransitionRecord } from './types.ts';

export type { Queryable } from '@memwise/db';
import type { Queryable } from '@memwise/db';

/** What the driver keeps between iterations; plain JSON, because DBOS journals it. */
export interface RunRow {
  id: string;
  workflowId: string;
  workflowHash: string;
  caseId: string;
  state: string;
  status: RunRecord['status'];
  seq: number;
  enteredSeq: number;
  snapshot: { value: string; status: string; context: unknown };
  /** Pending timers, earliest first. */
  timers: { timerId: string; armedSeq: number; event: RunEvent; fireAtMs: number }[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function loadRunRow(db: Queryable, runId: string): Promise<RunRow> {
  const { rows } = await db.query(
    `select id, workflow_id, workflow_hash, case_id, state, status, seq, entered_seq, snapshot from mw.runs where id = $1`, [runId]);
  const r = rows[0];
  if (!r) throw new Error(`no run ${runId}`);
  const t = await db.query(
    `select timer_id, armed_seq, event, (extract(epoch from fire_at) * 1000)::bigint as fire_at_ms
       from mw.timers where run_id = $1 and status = 'pending' order by fire_at, timer_id`, [runId]);
  return {
    id: r.id, workflowId: r.workflow_id, workflowHash: r.workflow_hash, caseId: r.case_id, state: r.state,
    status: r.status, seq: r.seq, enteredSeq: r.entered_seq, snapshot: r.snapshot,
    timers: t.rows.map((x) => ({ timerId: x.timer_id, armedSeq: x.armed_seq, event: x.event, fireAtMs: Number(x.fire_at_ms) })),
  };
}

export async function getRunRecord(db: Queryable, runId: string): Promise<RunRecord | undefined> {
  const { rows } = await db.query(`select * from mw.runs where id = $1`, [runId]);
  const r = rows[0];
  if (!r) return undefined;
  const t = await db.query(
    `select timer_id, armed_seq, event, fire_at, status from mw.timers where run_id = $1 and status = 'pending' order by fire_at`, [runId]);
  return {
    id: r.id, workflowId: r.workflow_id, workflowVersion: r.workflow_version, workflowHash: r.workflow_hash,
    caseId: r.case_id, state: r.state, status: r.status, seq: r.seq, enteredSeq: r.entered_seq,
    ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
    timers: t.rows.map((x): TimerRecord => ({ timerId: x.timer_id, armedSeq: x.armed_seq, event: x.event, fireAt: iso(x.fire_at), status: x.status })),
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export async function getTransitions(db: Queryable, runId: string): Promise<TransitionRecord[]> {
  const { rows } = await db.query(`select * from mw.transitions where run_id = $1 order by seq`, [runId]);
  return rows.map((r) => ({
    seq: r.seq, from: r.from_state, to: r.to_state, event: r.event, source: r.source, accepted: r.accepted,
    ...(r.note ? { note: r.note } : {}), ...(r.step_run_id ? { stepRunId: r.step_run_id } : {}), at: iso(r.at),
  }));
}

// ---------------------------------------------------------------- definitions

/** The run's pinned snapshot (D36). */
export async function loadWorkflowDef(db: Queryable, id: string, hash: string): Promise<WorkflowDef> {
  const { rows } = await db.query(`select body from mw.definitions where kind = 'workflow' and id = $1 and hash = $2`, [id, hash]);
  if (!rows[0]) throw new Error(`workflow ${id}@${hash} is not indexed`);
  return rows[0].body;
}

export async function latestWorkflowDef(db: Queryable, id: string): Promise<WorkflowDef | undefined> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = 'workflow' and id = $1 order by indexed_at desc limit 1`, [id]);
  return rows[0]?.body;
}

/** The domain policy layer is not part of the workflow snapshot; the latest indexed one applies. */
export async function loadDomainPolicy(db: Queryable): Promise<PolicyDoc | undefined> {
  const { rows } = await db.query(
    `select body from mw.definitions where kind = 'policy' and id = 'domain' order by indexed_at desc limit 1`);
  return rows[0]?.body;
}
