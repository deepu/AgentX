/**
 * Cases (04 §7): current values with provenance, and an append-only event log.
 *
 * `seq` counts change events: one write batch (a step's commit, or the case's creation) is one
 * event, and every field it writes gets a `case_events` row at that seq. Methods take the
 * caller's connection so writes join the caller's transaction (the run commit, D39).
 */
import type { CaseSnapshot, CaseValue, Provenance } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

export interface NewCase {
  id: string;
  caseType: string;
  workflowId: string;
  workflowHash: string;
  values: Record<string, CaseValue>;
  /** Stage 3: the project the case belongs to (absent: its workflow's domain's own project). */
  project?: string;
}

/** One field change from the case's event log. */
export interface CaseEvent {
  caseId: string;
  seq: number;
  field: string;
  value: unknown;
  provenance: Provenance;
  stepRunId?: string;
  at: string;
}

export class PgCaseStore {
  /** Idempotent: a case that already exists is returned as it is. */
  async create(db: Queryable, c: NewCase): Promise<CaseSnapshot> {
    const values = c.values ?? {};
    const inserted = await db.query(
      `insert into mw.cases (id, case_type, workflow_id, workflow_hash, values, seq, project)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [c.id, c.caseType, c.workflowId, c.workflowHash, json(values), Object.keys(values).length ? 1 : 0, c.project ?? null],
    );
    if (inserted.rowCount && Object.keys(values).length) await appendEvents(db, c.id, 1, values);
    const snapshot = await this.get(db, c.id);
    if (!snapshot) throw new Error(`Case ${c.id} was not created`);
    return snapshot;
  }

  async get(db: Queryable, caseId: string): Promise<CaseSnapshot | undefined> {
    const { rows } = await db.query<{ id: string; case_type: string; seq: number; values: Record<string, CaseValue> }>(
      'select id, case_type, seq, values from mw.cases where id = $1', [caseId]);
    const r = rows[0];
    return r && { id: r.id, caseType: r.case_type, seq: r.seq, values: r.values };
  }

  /**
   * Merges `writes` into the case as one change event. Call it inside the transaction that also
   * commits the step's transition, so the two can't disagree. Not idempotent on its own: the
   * caller's sequence guard is what stops a repeat.
   */
  async applyWrites(db: Queryable, caseId: string, writes: Record<string, CaseValue>, stepRunId?: string): Promise<CaseSnapshot> {
    if (!Object.keys(writes).length) {
      const current = await this.get(db, caseId);
      if (!current) throw new Error(`No case ${caseId}`);
      return current;
    }
    const { rows } = await db.query<{ id: string; case_type: string; seq: number; values: Record<string, CaseValue> }>(
      `update mw.cases set values = values || $2::jsonb, seq = seq + 1, updated_at = now()
       where id = $1 returning id, case_type, seq, values`,
      [caseId, json(writes)],
    );
    const r = rows[0];
    if (!r) throw new Error(`No case ${caseId}`);
    await appendEvents(db, caseId, r.seq, writes, stepRunId);
    return { id: r.id, caseType: r.case_type, seq: r.seq, values: r.values };
  }

  /** The case's event log, oldest first. */
  async history(db: Queryable, caseId: string): Promise<CaseEvent[]> {
    const { rows } = await db.query<{ case_id: string; seq: number; field: string; value: unknown; provenance: Provenance; step_run_id: string | null; at: Date }>(
      'select * from mw.case_events where case_id = $1 order by seq, field', [caseId]);
    return rows.map((r) => ({
      caseId: r.case_id, seq: r.seq, field: r.field, value: r.value, provenance: r.provenance, at: iso(r.at),
      ...compact({ stepRunId: r.step_run_id }),
    }));
  }
}

async function appendEvents(db: Queryable, caseId: string, seq: number, writes: Record<string, CaseValue>, stepRunId?: string): Promise<void> {
  await db.query(
    `insert into mw.case_events (case_id, seq, field, value, provenance, step_run_id)
     select $1, $2, w.key, w.value -> 'value', w.value -> 'provenance', $4
     from jsonb_each($3::jsonb) as w`,
    [caseId, seq, json(writes), stepRunId ?? null],
  );
}
