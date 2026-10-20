/** The definitions index (D13): parsed definitions by content hash, plus what each refers to. */
import type { DefinitionRef, DefinitionStore, IndexedDefinition, WorkflowDef } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { json } from '../rows.ts';

export class PgDefinitionStore implements DefinitionStore {
  constructor(private readonly db: Queryable) {}

  async upsert(defs: IndexedDefinition[], refs: DefinitionRef[]): Promise<void> {
    if (defs.length) {
      // A hash already indexed keeps its row. The one exception: a hash that is back after a
      // newer one (a file reverted) gets a fresh indexed_at, so it is the latest again.
      // Re-indexing the current hashes therefore changes nothing.
      await this.db.query(
        `insert into mw.definitions (kind, id, hash, version, path, body)
         select x.kind, x.id, x.hash, x.version, x.path, x.body
         from jsonb_to_recordset($1::jsonb) as x(kind text, id text, hash text, version int, path text, body jsonb)
         on conflict (kind, id, hash) do update set indexed_at = now()
         where mw.definitions.indexed_at < (
           select max(d.indexed_at) from mw.definitions d where d.kind = excluded.kind and d.id = excluded.id)`,
        [json(defs.map((d) => ({ kind: d.kind, id: d.id, hash: d.hash, version: d.version ?? null, path: d.path, body: d.body ?? null })))],
      );
    }
    if (refs.length) {
      await this.db.query(
        `insert into mw.definition_refs (from_kind, from_id, from_hash, to_kind, to_id)
         select x."fromKind", x."fromId", x."fromHash", x."toKind", x."toId"
         from jsonb_to_recordset($1::jsonb) as x("fromKind" text, "fromId" text, "fromHash" text, "toKind" text, "toId" text)
         on conflict do nothing`,
        [json(refs)],
      );
    }
  }

  async getWorkflow(id: string, hash: string): Promise<WorkflowDef | undefined> {
    const { rows } = await this.db.query<{ body: WorkflowDef }>(
      `select body from mw.definitions where kind = 'workflow' and id = $1 and hash = $2`, [id, hash]);
    return rows[0]?.body;
  }

  async latestWorkflow(id: string): Promise<WorkflowDef | undefined> {
    const { rows } = await this.db.query<{ body: WorkflowDef }>(
      `select body from mw.definitions where kind = 'workflow' and id = $1
       order by indexed_at desc, version desc nulls last limit 1`, [id]);
    return rows[0]?.body;
  }
}
