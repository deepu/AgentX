/**
 * Projects (26 §3, D92): one copy of an app with its own records, pages, runs, chats, people and
 * connections. Definitions (`projects/<id>/project.yaml`) say what a project is; `mw.projects`
 * keeps what happens to it: its status (draft until "Start study", archived), who made it, when.
 * Indexing upserts a row per project definition and never changes a status it didn't set.
 */
import type { MwProjectDef, ProjectSource, ProjectStatus } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { iso, json } from '../rows.ts';

export interface ProjectRow {
  id: string;
  app: string;
  /** Every app it runs, `app` first (`also:`, D105). */
  apps: string[];
  name: string;
  status: ProjectStatus;
  from?: ProjectSource;
  templateVersion: number;
  study?: string;
  settings: Record<string, unknown>;
  /** The app version whose "Review template update" the project skipped (none is offered again until a newer one). */
  skippedVersion?: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

type DbRow = {
  id: string; app: string; apps: string[] | null; name: string; status: ProjectStatus; from: ProjectSource | null; template_version: number; study: string | null;
  settings: Record<string, unknown> | null; skipped_version: number | null; created_by: string | null; created_at: Date; updated_at: Date;
};

const toRow = (r: DbRow): ProjectRow => ({
  id: r.id, app: r.app, apps: r.apps?.length ? r.apps : [r.app], name: r.name, status: r.status, templateVersion: r.template_version, settings: r.settings ?? {},
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  ...(r.from ? { from: r.from } : {}), ...(r.study ? { study: r.study } : {}), ...(r.created_by ? { createdBy: r.created_by } : {}),
  ...(r.skipped_version ? { skippedVersion: r.skipped_version } : {}),
});

export class PgProjectStore {
  async list(db: Queryable): Promise<ProjectRow[]> {
    const { rows } = await db.query<DbRow>('select * from mw.projects order by app, created_at, id');
    return rows.map(toRow);
  }

  async get(db: Queryable, id: string): Promise<ProjectRow | undefined> {
    const { rows } = await db.query<DbRow>('select * from mw.projects where id = $1', [id]);
    return rows[0] && toRow(rows[0]);
  }

  /**
   * Makes or updates the rows of these project definitions: what the files say (app, name, source,
   * template version, study, settings). A new row starts in the file's status; an existing one
   * keeps its own, which only `setStatus` changes.
   */
  async sync(db: Queryable, projects: MwProjectDef[], by?: string): Promise<void> {
    if (!projects.length) return;
    await db.query(
      `insert into mw.projects (id, app, apps, name, status, "from", template_version, study, settings, created_by)
       select x.id, x.app, array(select jsonb_array_elements_text(x.apps)), x.name, x.status, x."from", x.template_version, x.study, coalesce(x.settings, '{}'::jsonb), $2
       from jsonb_to_recordset($1::jsonb) as x(id text, app text, apps jsonb, name text, status text, "from" jsonb, template_version int, study text, settings jsonb)
       on conflict (id) do update set
         app = excluded.app, apps = excluded.apps, name = excluded.name, "from" = excluded."from", template_version = excluded.template_version,
         study = excluded.study, settings = excluded.settings, updated_at = now()
       where (mw.projects.app, mw.projects.apps, mw.projects.name, mw.projects."from", mw.projects.template_version, mw.projects.study, mw.projects.settings)
         is distinct from (excluded.app, excluded.apps, excluded.name, excluded."from", excluded.template_version, excluded.study, excluded.settings)`,
      [json(projects.map((p) => ({
        id: p.id, app: p.app, apps: p.apps?.length ? p.apps : [p.app], name: p.name, status: p.status, from: p.from ?? null, template_version: p.version,
        study: p.study ?? null, settings: p.settings ?? {},
      }))), by ?? null]);
  }

  /** Draft → active ("Start study"), active → archived, archived → active. Returns the row, or undefined when missing. */
  async setStatus(db: Queryable, id: string, status: ProjectStatus): Promise<ProjectRow | undefined> {
    const { rows } = await db.query<DbRow>(
      'update mw.projects set status = $2, updated_at = now() where id = $1 returning *', [id, status]);
    return rows[0] && toRow(rows[0]);
  }

  /** Skip the template update to app version `version` (null: offer updates again). */
  async skipVersion(db: Queryable, id: string, version: number | null): Promise<void> {
    await db.query('update mw.projects set skipped_version = $2, updated_at = now() where id = $1', [id, version]);
  }

  /** Removes a draft project's row (Discard). Refuses anything but a draft. */
  async discardDraft(db: Queryable, id: string): Promise<boolean> {
    const { rowCount } = await db.query(`delete from mw.projects where id = $1 and status = 'draft'`, [id]);
    return !!rowCount;
  }
}
