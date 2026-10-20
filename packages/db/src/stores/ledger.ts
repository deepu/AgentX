/**
 * The effect ledger (07 §2): one row per idempotency key, so an effect whose key is `done`
 * never runs again, even when a resumed step asks for it a second time.
 */
import type { EffectClass, EffectLedger, LedgerState } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { iso, json } from '../rows.ts';

export class PgEffectLedger implements EffectLedger {
  constructor(private readonly db: Queryable) {}

  /**
   * Claims the key in one statement: a new key is inserted as `pending`, and a `failed` key is
   * set back to `pending` (a retry). Either way the caller owns the effect and gets `new`.
   * Otherwise the existing row says what happened.
   */
  async begin(key: string, entry: { stepRunId: string; tool: string; effect: EffectClass; args: unknown }): Promise<LedgerState> {
    const claimed = await this.db.query(
      `insert into mw.effects (idempotency_key, step_run_id, tool, effect, args, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (idempotency_key) do update
         set status = 'pending', args = excluded.args, error = null, result = null, started_at = now(), completed_at = null
         where mw.effects.status = 'failed'
       returning 1`,
      [key, entry.stepRunId, entry.tool, entry.effect, json(entry.args)],
    );
    if (claimed.rowCount) return { status: 'new' };
    const { rows } = await this.db.query<{ status: string; result: unknown; error: string | null; started_at: Date }>(
      'select status, result, error, started_at from mw.effects where idempotency_key = $1', [key]);
    const row = rows[0];
    if (!row) throw new Error(`Effect ledger: key ${key} vanished while claiming it`);
    if (row.status === 'done') return { status: 'done', result: row.result };
    if (row.status === 'failed') return { status: 'failed', error: row.error ?? '' };
    return { status: 'pending', startedAt: iso(row.started_at) };
  }

  /** Marks the effect done. A key already done keeps its first result. */
  async complete(key: string, result: unknown): Promise<void> {
    const r = await this.db.query(
      `update mw.effects set status = 'done', result = $2, error = null, completed_at = now()
       where idempotency_key = $1 and status <> 'done'`, [key, json(result)]);
    if (!r.rowCount) await this.mustExist(key);
  }

  /** Marks a pending effect failed. A done key is never downgraded. */
  async fail(key: string, error: string): Promise<void> {
    const r = await this.db.query(
      `update mw.effects set status = 'failed', error = $2, completed_at = now()
       where idempotency_key = $1 and status = 'pending'`, [key, error]);
    if (!r.rowCount) await this.mustExist(key);
  }

  private async mustExist(key: string): Promise<void> {
    const { rowCount } = await this.db.query('select 1 from mw.effects where idempotency_key = $1', [key]);
    if (!rowCount) throw new Error(`Effect ledger: no effect was begun for key ${key}`);
  }
}
