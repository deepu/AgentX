/**
 * The Phase 4 part of `loadProject`: installed plugins, bindings, and the plugin workflows each
 * frozen binding resolves into the domain (22 §3).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBindingFile, pluginIdOfSlug, pluginSlug } from './binding-file.ts';
import { shapeFileOf } from './load.ts';
import { BINDINGS_DIR, type BindingDef, type InstalledPlugin } from './plugin-types.ts';
import { loadInstalledPlugins, newestPlugins } from './plugins.ts';
import { resolveWorkflow } from './resolve.ts';
import type { Diagnostic, ProjectDefs } from './types.ts';

export interface LoadProjectOptions {
  /** Where installed plugins are; default `<root>/plugins` (for a draft folder, its project's). */
  pluginsDir?: string;
  /**
   * Plugin ids whose binding counts even though it isn't frozen yet: a binding draft's dry run
   * checks and runs the plugin's workflows through the binding being made.
   */
  unfrozen?: string[];
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * The installed version a binding pins, when it is there and unchanged; otherwise undefined
 * (loadProject reports `binding-plugin-missing` or `binding-plugin-changed`).
 */
export function pinnedPlugin(project: ProjectDefs, binding: BindingDef): InstalledPlugin | undefined {
  const p = project.pluginVersions?.[binding.plugin]?.[binding.pluginVersion]
    ?? (project.plugins?.[binding.plugin]?.manifest.version === binding.pluginVersion ? project.plugins[binding.plugin] : undefined);
  if (!p || (binding.pluginHash && p.hash !== binding.pluginHash)) return undefined;
  return p;
}

/** Reads plugins/ and domain/bindings/ into `project` and adds the resolved plugin workflows. */
export async function loadPluginsAndBindings(root: string, project: ProjectDefs, opts: LoadProjectOptions = {}): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  const installed = await loadInstalledPlugins(root, opts);
  diagnostics.push(...installed.diagnostics);
  if (installed.plugins.length) {
    project.plugins = newestPlugins(installed.plugins);
    project.pluginVersions = {};
    for (const p of installed.plugins) (project.pluginVersions[p.manifest.id] ??= {})[p.manifest.version] = p;
  }

  const dir = join(root, BINDINGS_DIR);
  const bindings: Record<string, BindingDef> = {};
  if (await isDir(dir)) {
    const files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith('.') && /\.ya?ml$/.test(e.name)).map((e) => e.name).sort();
    for (const name of files) {
      const file = `${BINDINGS_DIR}/${name}`;
      const r = parseBindingFile(await readFile(join(dir, name), 'utf8'), file);
      diagnostics.push(...r.diagnostics);
      const b = r.value;
      if (!b?.plugin) continue;
      if (pluginSlug(b.plugin) !== name.replace(/\.ya?ml$/, '')) {
        diagnostics.push({ severity: 'warning', code: 'binding-file-mismatch', message: `this binds ${b.plugin}, whose binding file is ${BINDINGS_DIR}/${pluginSlug(b.plugin)}.yaml (the file name says ${pluginIdOfSlug(name.replace(/\.ya?ml$/, ''))})`, file, line: 1 });
      }
      if (bindings[b.plugin]) {
        diagnostics.push({ severity: 'error', code: 'duplicate-binding', message: `${b.plugin} is also bound in ${bindings[b.plugin]!.file}`, file, line: 1 });
        continue;
      }
      if (!b.frozen && !opts.unfrozen?.includes(b.plugin)) {
        diagnostics.push({ severity: 'warning', code: 'binding-not-frozen', message: `the binding of ${b.plugin} is not frozen, so it binds nothing yet: bind the plugin in the app to review and freeze it`, file, line: 1 });
        continue;
      }
      bindings[b.plugin] = b;
    }
  }
  if (Object.keys(bindings).length) project.bindings = bindings;

  // Plugin workflows, in domain terms. An authored workflow with the same id wins when it is a fork.
  const fromPlugin = new Map<string, string>();
  for (const binding of Object.values(bindings)) {
    const pinned = project.pluginVersions?.[binding.plugin]?.[binding.pluginVersion];
    if (!pinned) {
      diagnostics.push({ severity: 'error', code: 'binding-plugin-missing', message: `the binding pins ${binding.plugin} ${binding.pluginVersion}, which is not installed in plugins/${pluginSlug(binding.plugin)}/${binding.pluginVersion}`, file: binding.file, line: 1 });
      continue;
    }
    if (binding.pluginHash && pinned.hash !== binding.pluginHash) {
      diagnostics.push({ severity: 'error', code: 'binding-plugin-changed', message: `${pinned.dir} changed since the binding was made (its content is not the one reviewed); install it as a new version and bind that`, file: binding.file, line: 1 });
      continue;
    }
    for (const wf of Object.values(pinned.workflows)) {
      const existing = project.workflows[wf.id];
      if (existing && !fromPlugin.has(wf.id)) {
        if (existing.origin?.kind === 'fork') {
          diagnostics.push({ severity: 'warning', code: 'plugin-workflow-forked', message: `${wf.id} is forked from ${existing.origin.plugin}@${existing.origin.pluginVersion}; the plugin's own version (${binding.plugin} ${binding.pluginVersion}) is not used`, file: shapeFileOf(existing), line: 1 });
        } else {
          diagnostics.push({ severity: 'error', code: 'duplicate-workflow', message: `workflow \`${wf.id}\` also comes from the plugin ${binding.plugin}; rename one, or mark this one \`forked_from: ${binding.plugin}@${binding.pluginVersion}\``, file: shapeFileOf(existing), line: 1 });
        }
        continue;
      }
      if (existing) {
        diagnostics.push({ severity: 'error', code: 'duplicate-workflow', message: `workflow \`${wf.id}\` comes from both ${fromPlugin.get(wf.id)} and ${binding.plugin}`, file: binding.file, line: 1 });
        continue;
      }
      const r = resolveWorkflow(wf, pinned, binding);
      diagnostics.push(...r.diagnostics);
      fromPlugin.set(wf.id, binding.plugin);
      project.workflows[wf.id] = r.workflow;
    }
  }
  return diagnostics;
}
