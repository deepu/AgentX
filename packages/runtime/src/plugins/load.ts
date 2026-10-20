// Loading a project folder, where the folder may be a binding draft (drafts/<id>/): its own
// binding counts as applied though it isn't frozen yet, so the dry run's example cases (the CLI,
// out of process) and their kernel see the plugin's workflows and tools through it (22 §4).
import { DRAFTS_DIR, loadProject, readDraft, type LoadProjectOptions } from '@memwise/defs';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The load options a folder needs: for a binding draft, its plugin's binding counted unfrozen. */
export async function projectLoadOptions(dir: string): Promise<LoadProjectOptions> {
  const abs = resolve(dir);
  if (basename(dirname(abs)) !== DRAFTS_DIR || !existsSync(join(abs, 'draft.yaml'))) return {};
  const d = await readDraft(dirname(dirname(abs)), basename(abs)).catch(() => undefined);
  return d?.meta.kind === 'binding' && d.meta.plugin ? { unfrozen: [d.meta.plugin.id] } : {};
}

export async function loadProjectAt(dir: string) {
  return loadProject(dir, await projectLoadOptions(dir));
}
