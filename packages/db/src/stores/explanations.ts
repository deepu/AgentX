/** Explanations (19 §6): questions asked about a step record, and the grounded answers. */
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

export interface ExplanationCite { kind: 'journal' | 'output' | 'checkpoint' | 'context'; ref: string; label: string }

/** Same shape as `Explanation` in @memwise/runtime, plus who asked and which model answered. */
export interface StoredExplanation {
  id: string;
  stepRunId: string;
  question: string;
  answer: string;
  cites: ExplanationCite[];
  grounded: boolean;
  at: string;
  by?: string;
  model?: unknown;
}

export class PgExplanationStore {
  async save(db: Queryable, e: Omit<StoredExplanation, 'id' | 'at'> & { id?: string; at?: string }): Promise<StoredExplanation> {
    const id = e.id ?? `expl_${ulid()}`;
    const { rows } = await db.query<ExplanationRow>(
      `insert into mw.explanations (id, step_run_id, question, answer, cites, grounded, model, by, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
       on conflict (id) do update set id = excluded.id
       returning *`,
      [id, e.stepRunId, e.question, e.answer, json(e.cites), e.grounded, json(e.model), e.by ?? null, e.at ?? null]);
    return toExplanation(rows[0]!);
  }

  async get(db: Queryable, id: string): Promise<StoredExplanation | undefined> {
    const { rows } = await db.query<ExplanationRow>('select * from mw.explanations where id = $1', [id]);
    return rows[0] && toExplanation(rows[0]);
  }

  /** A step run's explanations, oldest first. */
  async forStep(db: Queryable, stepRunId: string): Promise<StoredExplanation[]> {
    const { rows } = await db.query<ExplanationRow>('select * from mw.explanations where step_run_id = $1 order by at, id', [stepRunId]);
    return rows.map(toExplanation);
  }
}

interface ExplanationRow {
  id: string; step_run_id: string; question: string; answer: string; cites: ExplanationCite[]; grounded: boolean;
  model: unknown; by: string | null; at: Date;
}

function toExplanation(r: ExplanationRow): StoredExplanation {
  return {
    id: r.id, stepRunId: r.step_run_id, question: r.question, answer: r.answer, cites: r.cites, grounded: r.grounded,
    at: iso(r.at), ...compact({ by: r.by, model: r.model }),
  };
}
