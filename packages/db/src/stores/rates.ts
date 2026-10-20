/**
 * Rate limit counting (19 §7): one mw.rate_events row per counted call. Implements
 * `RateCounter` from @memwise/gateway (shape repeated here; the gateway does not depend on db).
 */
import type pg from 'pg';
import { withTransaction } from '../pool.ts';

export class PgRateCounter {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Counts a call of `tool` in `scope` against `limit`: when fewer than `limit.count` calls
   * were counted in the last `limit.perMs`, records this one and allows it. Serialised per
   * tool and scope (advisory lock), so concurrent callers can't both take the last slot.
   */
  async take(tool: string, scope: string, limit: { count: number; perMs: number }): Promise<{ allowed: boolean; used: number }> {
    return withTransaction(this.pool, async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`rate:${scope}:${tool}`]);
      const { rows } = await db.query<{ n: string }>(
        `select count(*) as n from mw.rate_events
         where tool = $1 and scope = $2 and at > clock_timestamp() - make_interval(secs => $3::double precision / 1000)`,
        [tool, scope, limit.perMs]);
      const used = Number(rows[0]?.n ?? 0);
      if (used >= limit.count) return { allowed: false, used };
      await db.query('insert into mw.rate_events (tool, scope, at) values ($1, $2, clock_timestamp())', [tool, scope]);
      return { allowed: true, used: used + 1 };
    });
  }

  /** Drops events older than `olderThanMs` (housekeeping; counting never needs them). */
  async prune(olderThanMs: number): Promise<number> {
    const r = await this.pool.query(
      'delete from mw.rate_events where at < clock_timestamp() - make_interval(secs => $1::double precision / 1000)', [olderThanMs]);
    return r.rowCount ?? 0;
  }
}
