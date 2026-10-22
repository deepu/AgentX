/**
 * What the kernel needs to know about a project at run time (26 §3): its row in `mw.projects`
 * (status) and its indexed definition (which playbook copies it runs). Both are read from the
 * database, so a kernel without a project folder (the server's workers) knows them too.
 */
import type { Queryable } from '@memwise/db';
import type { ProjectStatus } from '@memwise/defs';

/** The `project` definition row's body (index-project.ts): the project file without its resolved definitions. */
export interface IndexedProjectBody {
  id: string;
  app: string;
  /** Every app it runs, `app` first (D105); absent in bodies indexed before it. */
  apps?: string[];
  name: string;
  version: number;
  status: ProjectStatus;
  implicit?: boolean;
  without: string[];
  overrides: string[];
  /** Playbook id → the hash of the copy this project runs. */
  workflows: Record<string, string>;
  study?: string;
  settings?: Record<string, unknown>;
}

export interface ProjectAtRunTime {
  id: string;
  app: string;
  /** Every app it runs, `app` first. */
  apps: string[];
  name: string;
  status: ProjectStatus;
  /** Absent for a project the definitions don't know (an app's own project from before projects). */
  def?: IndexedProjectBody;
}

/** A project as of the last index and its row; undefined when neither knows it. */
export async function projectAtRunTime(db: Queryable, id: string): Promise<ProjectAtRunTime | undefined> {
  const [def, row] = await Promise.all([
    db.query<{ body: IndexedProjectBody }>(
      `select body from mw.definitions where kind = 'project' and id = $1 order by indexed_at desc limit 1`, [id]),
    db.query<{ app: string; apps: string[] | null; name: string; status: ProjectStatus }>(`select app, apps, name, status from mw.projects where id = $1`, [id]),
  ]);
  const body = def.rows[0]?.body;
  const r = row.rows[0];
  if (!body && !r) return undefined;
  return {
    id, app: r?.app ?? body!.app, name: r?.name ?? body!.name,
    apps: r?.apps?.length ? r.apps : body?.apps?.length ? body.apps : [r?.app ?? body!.app],
    // The row says what happened to it (Start study, archive); a project not synced yet, what its file says.
    status: r?.status ?? body!.status,
    ...(body ? { def: body } : {}),
  };
}

/**
 * Why `workflowId` can't start in this project, or undefined when it can: a draft runs nothing
 * until Start study, an archived project nothing at all, and a project runs only the playbooks
 * it has (not those it leaves out).
 */
export function projectStartRefusal(p: ProjectAtRunTime, workflowId: string): string | undefined {
  if (p.status === 'draft') return `${p.name} is a draft: start it before running anything in it`;
  if (p.status === 'archived') return `${p.name} is archived`;
  if (p.def && !p.def.implicit && !p.def.workflows[workflowId]) return `${p.name} doesn't use the playbook ${workflowId}`;
  return undefined;
}
