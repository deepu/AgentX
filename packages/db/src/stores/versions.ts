/**
 * The version index (Phase 3, 20 §2): which content hash of a playbook was live as which
 * version, and how it got there. Written by the kernel as system; people only read it.
 */
import type { Queryable } from '../pool.ts';
import { compact, iso } from '../rows.ts';

export interface VersionRow {
  workflowId: string;
  version: number;
  hash: string;
  publishedAt: string;
  publishedBy?: string;
  source: 'app' | 'cli' | 'files';
  draftId?: string;
  runId?: string;
}

export type NewVersion = Omit<VersionRow, 'publishedAt'>;

export class PgVersionStore {
  /**
   * Records a published version. A hash already recorded as found on disk (`files`) takes the
   * publish's details; one already recorded by a publish keeps them (a later index never wins).
   */
  async record(db: Queryable, v: NewVersion): Promise<void> {
    await db.query(
      `insert into mw.workflow_versions (workflow_id, version, hash, published_by, source, draft_id, run_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workflow_id, hash) do update
         set source = excluded.source, published_by = excluded.published_by, draft_id = excluded.draft_id,
             run_id = excluded.run_id, version = excluded.version
         where excluded.source <> 'files'`,
      [v.workflowId, v.version, v.hash, v.publishedBy ?? null, v.source, v.draftId ?? null, v.runId ?? null]);
  }

  /** Records hashes found on disk that are not in the index yet; returns the ones it added. */
  async recordFound(db: Queryable, found: { workflowId: string; version: number; hash: string }[]): Promise<NewVersion[]> {
    if (!found.length) return [];
    const { rows } = await db.query<{ workflow_id: string; version: number; hash: string }>(
      `insert into mw.workflow_versions (workflow_id, version, hash, source)
       select x.workflow_id, x.version, x.hash, 'files'
         from jsonb_to_recordset($1::jsonb) as x(workflow_id text, version int, hash text)
       on conflict (workflow_id, hash) do nothing
       returning workflow_id, version, hash`,
      [JSON.stringify(found.map((f) => ({ workflow_id: f.workflowId, version: f.version, hash: f.hash })))]);
    return rows.map((r) => ({ workflowId: r.workflow_id, version: r.version, hash: r.hash, source: 'files' as const }));
  }

  /** Newest first. */
  async list(db: Queryable, workflowId: string): Promise<VersionRow[]> {
    const { rows } = await db.query<Row>(
      `select * from mw.workflow_versions where workflow_id = $1 order by published_at desc, version desc, hash`, [workflowId]);
    return rows.map(toVersion);
  }

  async get(db: Queryable, workflowId: string, hash: string): Promise<VersionRow | undefined> {
    const { rows } = await db.query<Row>(`select * from mw.workflow_versions where workflow_id = $1 and hash = $2`, [workflowId, hash]);
    return rows[0] && toVersion(rows[0]);
  }
}

interface Row {
  workflow_id: string; version: number; hash: string; published_at: Date; published_by: string | null;
  source: VersionRow['source']; draft_id: string | null; run_id: string | null;
}

function toVersion(r: Row): VersionRow {
  return {
    workflowId: r.workflow_id, version: r.version, hash: r.hash, publishedAt: iso(r.published_at), source: r.source,
    ...compact({ publishedBy: r.published_by, draftId: r.draft_id, runId: r.run_id }),
  };
}
