/**
 * Installed plugins (Phase 4, 22 §2): loading `plugins/<slug>/<version>/` folders and installing
 * a plugin folder (a MemWise plugin, or a Claude plugin with its generated manifest) into a project.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pluginSlug } from './binding-file.ts';
import { importClaudePlugin, skillFrontMatter } from './claude-import.ts';
import { DRAFTS_DIR } from './draft-types.ts';
import { loadWorkflow } from './load.ts';
import { compareSemver, isSemver, parsePluginManifest, pluginManifestToYaml } from './plugin-manifest.ts';
import { PLUGIN_ID_PATTERN, PLUGIN_MANIFEST, PLUGINS_DIR, type InstalledPlugin, type PluginManifest, type PluginSkill } from './plugin-types.ts';
import { lineOf } from './source.ts';
import type { Diagnostic, WorkflowDef } from './types.ts';

const posix = (p: string) => p.split(sep).join('/');
const CLAUDE_PLUGIN_JSON = '.claude-plugin/plugin.json';
/** Dotfiles a plugin folder keeps at its top: a Claude plugin's metadata and its servers. */
const KEPT_DOTFILES = ['.claude-plugin', '.mcp.json'];

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Every file of a plugin folder, relative and sorted: `.git`, `node_modules` and dotfiles are
 * skipped, apart from `.claude-plugin/` and `.mcp.json` at the top.
 */
export async function pluginFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(join(dir, prefix), { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (e.name === 'node_modules' || (e.name.startsWith('.') && !(prefix === '' && KEPT_DOTFILES.includes(e.name)))) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await pluginFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 over sorted (path, NUL, bytes, NUL), as for workflow folders. */
function folderHash(contents: Map<string, Buffer>): string {
  const h = createHash('sha256');
  for (const path of [...contents.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) h.update(path).update('\0').update(contents.get(path)!).update('\0');
  return h.digest('hex');
}

async function readAll(dir: string): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  for (const f of await pluginFiles(dir)) contents.set(f, await readFile(join(dir, f)));
  return contents;
}

/**
 * Loads one plugin folder. `dir` and the paths in diagnostics are relative to `projectRoot`. Its
 * workflows are loaded as written, in the plugin's own terms (`Ref<Client>`), and only parsed:
 * they are checked once resolved through a binding. A Claude plugin without a manifest is read
 * through `importClaudePlugin` (no tools until they are discovered).
 */
export async function loadPlugin(dir: string, projectRoot: string): Promise<{ plugin?: InstalledPlugin; diagnostics: Diagnostic[] }> {
  const abs = resolve(dir);
  const root = resolve(projectRoot);
  const relDir = posix(relative(root, abs)) || '.';
  const inDir = (f: string) => (relDir === '.' ? f : `${relDir}/${f}`);
  const diagnostics: Diagnostic[] = [];
  const contents = await readAll(abs);
  const manifestFile = inDir(PLUGIN_MANIFEST);

  let manifest: PluginManifest | undefined;
  if (contents.has(PLUGIN_MANIFEST)) {
    const r = parsePluginManifest(contents.get(PLUGIN_MANIFEST)!.toString('utf8'), manifestFile);
    diagnostics.push(...r.diagnostics);
    manifest = r.value;
  } else if (contents.has(CLAUDE_PLUGIN_JSON)) {
    try {
      manifest = { ...(await importClaudePlugin(abs)).manifest, file: manifestFile };
    } catch (e) {
      diagnostics.push({ severity: 'error', code: 'invalid-plugin', message: (e as Error).message, file: inDir(CLAUDE_PLUGIN_JSON) });
    }
  } else {
    diagnostics.push({ severity: 'error', code: 'missing-plugin-manifest', message: `${relDir} has no ${PLUGIN_MANIFEST} (nor .claude-plugin/plugin.json)`, file: relDir });
  }
  if (!manifest) return { diagnostics };

  const skills: PluginSkill[] = [];
  manifest.skills.forEach((name, i) => {
    const f = `skills/${name}/SKILL.md`;
    const bytes = contents.get(f);
    if (!bytes) {
      diagnostics.push({ severity: 'error', code: 'missing-skill', message: `the skill ${name} has no ${f}`, file: manifestFile, line: lineOf(manifest, ['skills', i]), path: `skills.${i}` });
      return;
    }
    const fm = skillFrontMatter(bytes.toString('utf8'));
    skills.push({ name: fm.name ?? name, ...(fm.description ? { description: fm.description } : {}), file: inDir(f), body: fm.body.trim() });
  });

  const workflows: Record<string, WorkflowDef> = {};
  for (const [i, id] of manifest.workflows.entries()) {
    const wfDir = join(abs, 'workflows', id);
    if (!existsSync(join(wfDir, 'workflow.yaml'))) {
      diagnostics.push({ severity: 'error', code: 'missing-workflow', message: `the workflow ${id} has no workflows/${id}/workflow.yaml`, file: manifestFile, line: lineOf(manifest, ['workflows', i]), path: `workflows.${i}` });
      continue;
    }
    const r = await loadWorkflow(wfDir, root);
    diagnostics.push(...r.diagnostics);
    if (r.workflow) workflows[r.workflow.id] = r.workflow;
  }

  return { plugin: { manifest, dir: relDir, hash: folderHash(contents), skills, workflows }, diagnostics };
}

/**
 * The plugins folder of a project: `<root>/plugins`; for a draft folder (`<x>/drafts/<id>`) without
 * its own, the project's `<x>/plugins`, so a draft checks and runs against the installed plugins.
 * Also the folder paths are made relative to: the root, or the project the plugins folder is in.
 */
export function pluginsDirOf(root: string, opts: { pluginsDir?: string } = {}): { dir: string; base: string } {
  const abs = resolve(root);
  if (opts.pluginsDir) {
    const dir = resolve(opts.pluginsDir);
    const rel = relative(abs, dir);
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    return { dir, base: inside ? abs : dirname(dir) };
  }
  const own = join(abs, PLUGINS_DIR);
  if (!existsSync(own) && basename(dirname(abs)) === DRAFTS_DIR) {
    const project = dirname(dirname(abs));
    if (existsSync(join(project, PLUGINS_DIR))) return { dir: join(project, PLUGINS_DIR), base: project };
  }
  return { dir: own, base: abs };
}

/**
 * Every installed plugin version (`plugins/<slug>/<version>/`), sorted by id, then by version
 * oldest first. A binding pins a version, so older ones stay reachable here.
 */
export async function loadInstalledPlugins(root: string, opts: { pluginsDir?: string } = {}): Promise<{ plugins: InstalledPlugin[]; diagnostics: Diagnostic[] }> {
  const { dir, base } = pluginsDirOf(root, opts);
  const plugins: InstalledPlugin[] = [];
  const diagnostics: Diagnostic[] = [];
  if (!(await isDir(dir))) return { plugins, diagnostics };
  const subdirs = async (p: string) => (await readdir(p, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  for (const slug of await subdirs(dir)) {
    for (const version of await subdirs(join(dir, slug))) {
      const r = await loadPlugin(join(dir, slug, version), base);
      diagnostics.push(...r.diagnostics);
      const p = r.plugin;
      if (!p) continue;
      if (pluginSlug(p.manifest.id) !== slug || p.manifest.version !== version) {
        diagnostics.push({
          severity: 'warning', code: 'plugin-folder-mismatch',
          message: `${p.dir} holds ${p.manifest.id} ${p.manifest.version}; it belongs in ${PLUGINS_DIR}/${pluginSlug(p.manifest.id)}/${p.manifest.version}`,
          file: p.manifest.file, line: 1,
        });
      }
      plugins.push(p);
    }
  }
  plugins.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : compareSemver(a.manifest.version, b.manifest.version)));
  return { plugins, diagnostics };
}

/** The newest version of each plugin, by id. */
export function newestPlugins(plugins: InstalledPlugin[]): Record<string, InstalledPlugin> {
  const out: Record<string, InstalledPlugin> = {};
  for (const p of plugins) {
    const cur = out[p.manifest.id];
    if (!cur || compareSemver(p.manifest.version, cur.manifest.version) > 0) out[p.manifest.id] = p;
  }
  return out;
}

/**
 * Copies a plugin folder into `plugins/<slug>/<version>/` (skipping `.git`, `node_modules` and
 * dotfiles other than `.claude-plugin/` and `.mcp.json`). A Claude plugin (no memwise-plugin.yaml)
 * gets `opts.manifest` (the import with its discovered tools) or its plain import written as
 * `memwise-plugin.yaml` in the copy; `opts.manifest` is ignored for a MemWise plugin. Installing
 * the same folder again does nothing (`created: false`); a different folder at the same version
 * is refused. Nothing live changes: the plugin is inert until a binding is frozen.
 */
export async function installPlugin(projectRoot: string, sourceDir: string, opts: { manifest?: PluginManifest } = {}): Promise<{ id: string; version: string; dir: string; created: boolean }> {
  const root = resolve(projectRoot);
  const src = resolve(sourceDir);
  if (!(await isDir(src))) throw new Error(`${sourceDir} is not a folder`);
  const contents = await readAll(src);

  let manifest: PluginManifest;
  if (contents.has(PLUGIN_MANIFEST)) {
    const r = parsePluginManifest(contents.get(PLUGIN_MANIFEST)!.toString('utf8'), PLUGIN_MANIFEST);
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    if (!r.value || errors.length) {
      throw new Error(`${PLUGIN_MANIFEST} has errors: ${errors.map((d) => `${d.line ? `line ${d.line}: ` : ''}${d.message}`).join('; ') || 'it could not be read'}`);
    }
    manifest = r.value;
  } else if (contents.has(CLAUDE_PLUGIN_JSON)) {
    manifest = opts.manifest ?? (await importClaudePlugin(src)).manifest;
    contents.set(PLUGIN_MANIFEST, Buffer.from(pluginManifestToYaml({ ...manifest, file: PLUGIN_MANIFEST })));
  } else {
    throw new Error(`${sourceDir} is not a plugin: it has no ${PLUGIN_MANIFEST} or .claude-plugin/plugin.json`);
  }
  if (!PLUGIN_ID_PATTERN.test(manifest.id)) throw new Error(`\`${manifest.id}\` is not a plugin id: write <publisher>/<name> in lower case`);
  if (!isSemver(manifest.version)) throw new Error(`\`${manifest.version}\` is not a plugin version: write major.minor.patch`);

  const slug = pluginSlug(manifest.id);
  const rel = `${PLUGINS_DIR}/${slug}/${manifest.version}`;
  const target = join(root, PLUGINS_DIR, slug, manifest.version);
  const result = { id: manifest.id, version: manifest.version, dir: rel };
  if (existsSync(target)) {
    if (folderHash(await readAll(target)) === folderHash(contents)) return { ...result, created: false };
    throw new Error(`${rel} already holds a different copy of ${manifest.id} ${manifest.version}; give the changed plugin a new version to install it beside this one`);
  }

  // Into a dot-named folder first (loaders skip it), then renamed into place in one step.
  const tmp = join(root, PLUGINS_DIR, slug, `.${manifest.version}.installing-${randomBytes(4).toString('hex')}`);
  try {
    for (const [f, bytes] of contents) {
      await mkdir(dirname(join(tmp, f)), { recursive: true });
      await writeFile(join(tmp, f), bytes);
    }
    await mkdir(tmp, { recursive: true });
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { ...result, created: true };
}
