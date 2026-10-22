/**
 * Flags (24 §4): an invariant that doesn't hold on a record. Invariants never block a write;
 * the kernel evaluates them after each one and raises a flag (one open flag per record and
 * invariant), which closes itself when the invariant holds again.
 */
import { splitEntityKey } from '@memwise/defs';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { iso } from '../rows.ts';

/** Same shape as `RecordFlag` in @memwise/runtime, plus the domain. */
export interface FlagRow {
  id: string;
  entity: string;
  domain: string;
  recordId: string;
  invariant: string;
  message: string;
  raisedAt: string;
  closedAt?: string;
  /** Stage 3: the record's project (absent for an app-scoped record). */
  project?: string;
}

type FlagDbRow = { id: string; entity: string; domain: string; record_id: string; invariant: string; message: string; raised_at: Date; closed_at: Date | null; project: string | null };
const toFlag = (r: FlagDbRow): FlagRow => ({
  id: r.id, entity: r.entity, domain: r.domain, recordId: r.record_id, invariant: r.invariant, message: r.message,
  raisedAt: iso(r.raised_at), ...(r.closed_at ? { closedAt: iso(r.closed_at) } : {}), ...(r.project ? { project: r.project } : {}),
});

export class PgFlagStore {
  /**
   * Raises a flag unless one is already open for this record and invariant (then its message is
   * brought up to date). `raised` is true only for a new flag.
   */
  async raise(db: Queryable, f: { entity: string; recordId: string; invariant: string; message: string; project?: string }): Promise<{ id: string; raised: boolean }> {
    const { domain } = splitEntityKey(f.entity);
    const { rows } = await db.query<{ id: string; raised: boolean }>(
      `insert into mw.record_flags (id, entity, domain, record_id, invariant, message, project) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (entity, record_id, invariant) where closed_at is null
         do update set message = excluded.message
       returning id, (xmax = 0) as raised`,
      [`flag_${ulid()}`, f.entity, domain, f.recordId, f.invariant, f.message, f.project ?? null]);
    return rows[0]!;
  }

  /** Closes the open flag, if any; true when one was closed. */
  async close(db: Queryable, entity: string, recordId: string, invariant: string): Promise<boolean> {
    const r = await db.query(
      `update mw.record_flags set closed_at = clock_timestamp()
       where entity = $1 and record_id = $2 and invariant = $3 and closed_at is null`, [entity, recordId, invariant]);
    return !!r.rowCount;
  }

  /** Flags, newest first; `open` (default true) only the open ones, false only the closed ones. */
  async list(db: Queryable, filter: { domain?: string; entity?: string; recordId?: string; open?: boolean; limit?: number } = {}): Promise<FlagRow[]> {
    const { rows } = await db.query<FlagDbRow>(
      `select id, entity, domain, record_id, invariant, message, raised_at, closed_at, project from mw.record_flags
       where ($1::text is null or domain = $1) and ($2::text is null or entity = $2) and ($3::text is null or record_id = $3)
         and ($4::boolean is null or (closed_at is null) = $4)
       order by raised_at desc, id desc limit $5`,
      [filter.domain ?? null, filter.entity ?? null, filter.recordId ?? null, filter.open === undefined ? true : filter.open, filter.limit ?? 500]);
    return rows.map(toFlag);
  }
}
