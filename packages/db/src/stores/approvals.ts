/** Approval requests (07 §4). The step recorder writes them; a person decides them once. */
import type { ApprovalDecision, ApprovalRequest, ApprovalStatus } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { compact, iso } from '../rows.ts';

export interface ApprovalRecord extends ApprovalRequest {
  status: ApprovalStatus;
  decidedBy?: string;
  comment?: string;
  decidedAt?: string;
}

export class PgApprovalStore {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const { rows } = await this.db.query<ApprovalRow>('select * from mw.approvals where id = $1', [id]);
    return rows[0] && toApproval(rows[0]);
  }

  /** Approvals waiting for a person, oldest first. */
  async pending(): Promise<ApprovalRecord[]> {
    const { rows } = await this.db.query<ApprovalRow>(
      `select * from mw.approvals where status = 'pending' order by requested_at, id`);
    return rows.map(toApproval);
  }

  /**
   * Records a decision on a pending approval. Returns false when it was already decided (or
   * doesn't exist), so a second click or a race can't change the answer. Takes the caller's
   * connection so the decision can commit with the message that wakes the step.
   */
  async decide(db: Queryable, d: ApprovalDecision): Promise<boolean> {
    const r = await db.query(
      `update mw.approvals set status = $2, decided_by = $3, comment = $4, decided_at = $5
       where id = $1 and status = 'pending'`,
      [d.id, d.status, d.by, d.comment ?? null, d.at],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

interface ApprovalRow {
  id: string; step_run_id: string; tool: string; effect: ApprovalRequest['effect']; treatment: ApprovalRequest['treatment'];
  args: unknown; preview: ApprovalRequest['preview']; status: ApprovalStatus; decided_by: string | null;
  comment: string | null; requested_at: Date; decided_at: Date | null;
}

function toApproval(r: ApprovalRow): ApprovalRecord {
  return {
    id: r.id, stepRunId: r.step_run_id, tool: r.tool, effect: r.effect, treatment: r.treatment, args: r.args,
    preview: r.preview, requestedAt: iso(r.requested_at), status: r.status,
    ...compact({ decidedBy: r.decided_by, comment: r.comment, decidedAt: iso(r.decided_at) }),
  };
}
