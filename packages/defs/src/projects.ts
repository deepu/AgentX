/**
 * Apps and projects in a workspace folder (26 §3, D93): every domain is an app (`app.yaml`, or
 * version 1 without one); `projects/<id>/project.yaml` is a project of one app, and its effective
 * definitions are the app's template at the version it took plus its `overrides/` (whole files),
 * minus what it leaves out. An app without projects of its own has one implicit project, id = the
 * domain id, so a single-domain workspace still loads as one project.
 *
 *   domains/etmf/app.yaml                    title, version, templates (the cards in New project)
 *   domains/etmf/versions/4/…                the template as it was at version 4 (workflows, pages,
 *                                            views, policy.yaml); entity types are always the app's own
 *   projects/mw301/project.yaml              app, version, name, study, people, connections
 *   projects/mw301/overrides/workflows/chase-missing/workflow.yaml
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DOMAIN, type DomainDef, type FreePageDef, type ViewDef } from './domain-types.ts';
import { loadWorkflow, type WorkflowOverlayFile } from './load.ts';
import { parsePageFile, parseViewFile } from './parse-domain.ts';
import { parsePolicyFile } from './parse-policy.ts';
import { defaultApp, parseAppFile, parseProjectFile, projectSource, type ProjectFile } from './parse-projects.ts';
import {
  APP_PLAYBOOKS, APP_VERSIONS_DIR, OVERRIDABLE, OVERRIDES_DIR, PROJECT_ID_PATTERN, PROJECTS_DIR, type AppDef, type MwProjectDef,
} from './project-types.ts';
import { locatorOf, rememberLocator, sha256 } from './source.ts';
import type { Diagnostic, PolicyDoc, ProjectDefs, WorkflowDef } from './types.ts';

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function subdirs(dir: string): Promise<string[]> {
  if (!(await isDir(dir))) return [];
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

/** Every file under `dir` as sorted paths relative to it; dotfiles skipped. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  if (!(await isDir(join(dir, prefix)))) return [];
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await filesUnder(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** The hash a project's copy of a playbook gets: distinct from the template's, so a run's snapshot names its project. */
export const projectWorkflowHash = (projectId: string, contentHash: string): string => sha256(`project\0${projectId}\0${contentHash}`);

/** The folder (relative to the root) holding an app's template at `version`. */
export function templateDir(app: Pick<AppDef, 'version'>, domain: Pick<DomainDef, 'dir'>, version: number): string {
  return version === app.version ? domain.dir : `${domain.dir}/${APP_VERSIONS_DIR}/${version}`;
}

/** Phase 6 domains as apps: reads each domain's `app.yaml` and the versions kept beside it. */
export async function loadApps(abs: string, project: ProjectDefs, diagnostics: Diagnostic[]): Promise<void> {
  const apps: Record<string, AppDef> = {};
  for (const domain of Object.values(project.domains ?? {})) {
    const versions = (await subdirs(join(abs, domain.dir, APP_VERSIONS_DIR))).filter((n) => /^[1-9]\d*$/.test(n)).map(Number);
    const file = `${domain.dir}/app.yaml`;
    // The default domain folder may hold only bindings (domain/bindings/): that is no app.
    const empty = !domain.entities.length && !domain.workflows.length && !Object.keys(domain.pages).length;
    if (domain.id === DEFAULT_DOMAIN && empty && !existsSync(join(abs, file))) continue;
    if (!existsSync(join(abs, file))) { apps[domain.id] = { ...defaultApp(domain), versions }; continue; }
    const r = parseAppFile(await readFile(join(abs, file), 'utf8'), file, domain, versions);
    diagnostics.push(...r.diagnostics);
    apps[domain.id] = r.value ?? { ...defaultApp(domain), versions };
    const newer = versions.filter((v) => v >= apps[domain.id]!.version);
    if (newer.length) {
      diagnostics.push({ severity: 'error', code: 'app-version-kept-ahead', file: `${domain.dir}/${APP_VERSIONS_DIR}/${newer[0]}`, message: `version ${newer[0]} is kept as an older version, but the app is at version ${apps[domain.id]!.version}` });
    }
  }
  if (Object.keys(apps).length) project.apps = apps;
}

/** Loads `projects/*` and resolves each one's effective definitions; adds the implicit projects. */
export async function loadMwProjects(abs: string, project: ProjectDefs, diagnostics: Diagnostic[]): Promise<void> {
  const apps = project.apps ?? {};
  const out: Record<string, MwProjectDef> = {};
  for (const id of await subdirs(join(abs, PROJECTS_DIR))) {
    const dir = `${PROJECTS_DIR}/${id}`;
    const file = `${dir}/project.yaml`;
    if (!PROJECT_ID_PATTERN.test(id)) {
      diagnostics.push({ severity: 'error', code: 'invalid-project-id', file: dir, message: `\`${id}\` can't be a project id: lower-case letters, digits, _ and -, starting with a letter` });
      continue;
    }
    if (!existsSync(join(abs, file))) {
      diagnostics.push({ severity: 'error', code: 'missing-project-file', file: dir, message: `${dir} has no project.yaml` });
      continue;
    }
    const r = parseProjectFile(await readFile(join(abs, file), 'utf8'), file, id);
    diagnostics.push(...r.diagnostics);
    const pf = r.value;
    if (!pf) continue;
    const app = apps[pf.app];
    const domain = project.domains?.[pf.app];
    if (!app || !domain) {
      diagnostics.push({
        severity: 'error', code: 'project-unknown-app', file, line: locatorOf(pf)?.(['app']),
        message: pf.app ? `there is no app \`${pf.app}\` (apps: ${Object.keys(apps).join(', ') || 'none'})` : 'app: name the app this project is a copy of',
      });
      continue;
    }
    out[id] = await resolveProject(abs, project, pf, app, domain, diagnostics);
  }
  // An app without projects of its own is one project, named after it (today's single-domain workspaces).
  for (const app of Object.values(apps)) {
    if (Object.values(out).some((p) => p.app === app.id)) continue;
    if (out[app.id]) {
      diagnostics.push({ severity: 'error', code: 'project-id-taken', file: out[app.id]!.file, message: `the project \`${app.id}\` belongs to ${out[app.id]!.app}, but \`${app.id}\` is also the id of the app ${app.id}'s own project; rename the folder` });
      continue;
    }
    out[app.id] = implicitProject(project, app);
  }
  if (Object.keys(out).length) project.projects = out;
}

/** The implicit project of an app: the live template, no overrides; its playbooks are the template's own. */
function implicitProject(project: ProjectDefs, app: AppDef): MwProjectDef {
  const domain = project.domains![app.id]!;
  const workflows = Object.fromEntries(domain.workflows.map((w) => [w, project.workflows[w]!]).filter(([, w]) => !!w)) as Record<string, WorkflowDef>;
  return {
    id: app.id, app: app.id, name: domain.name === app.id ? app.title : domain.name, version: app.version, status: 'active',
    people: [], connections: [], without: [], overrides: [], implicit: true,
    hash: sha256(`implicit\0${app.id}\0${app.version}`),
    workflows,
    ...(domain.policy ? { policy: domain.policy } : {}),
    pages: domain.pages, views: domain.views,
  };
}

async function resolveProject(abs: string, project: ProjectDefs, pf: ProjectFile, app: AppDef, domain: DomainDef, diagnostics: Diagnostic[]): Promise<MwProjectDef> {
  const dir = `${PROJECTS_DIR}/${pf.id}`;
  const at = (path: (string | number)[]) => locatorOf(pf)?.(path);
  let version = pf.version ?? app.version;
  if (version !== app.version && !app.versions.includes(version)) {
    diagnostics.push({
      severity: 'error', code: 'project-unknown-version', file: pf.file, line: at(['version']),
      message: version > app.version
        ? `${app.title} is at version ${app.version}; there is no version ${version} yet`
        : `${app.title} version ${version} is not kept (${domain.dir}/${APP_VERSIONS_DIR}/${version}/ is missing); kept: ${app.versions.join(', ') || 'none'}`,
    });
    version = app.version;
  }
  const tdir = templateDir(app, domain, version);
  const live = tdir === domain.dir;

  // Overrides: whole files at the template's relative paths.
  const overridesRel = `${dir}/${OVERRIDES_DIR}`;
  const overrideFiles = await filesUnder(join(abs, overridesRel));
  const overrides: string[] = [];
  const bytes = new Map<string, Buffer>();
  for (const path of overrideFiles) {
    const file = `${overridesRel}/${path}`;
    if (!OVERRIDABLE.test(path)) {
      diagnostics.push({ severity: 'error', code: 'override-not-allowed', file, message: `${path} can't be overridden in a project: only playbook files (workflows/…), policy.yaml, pages/ and views/; record types are the app's` });
      continue;
    }
    if (!existsSync(join(abs, tdir, path))) {
      diagnostics.push({ severity: 'error', code: 'override-unknown-file', file, message: `${path} replaces nothing: ${app.title} version ${version} has no ${path}` });
      continue;
    }
    overrides.push(path);
    bytes.set(path, await readFile(join(abs, overridesRel, path)));
  }

  // What it leaves out: workflows/<id>, pages/<id>, views/<id>.
  const without = new Set<string>();
  pf.without.forEach((w, i) => {
    const m = /^(workflows|pages|views)\/([^/]+?)(\.ya?ml)?$/.exec(w);
    const exists = m && (m[1] === 'workflows'
      ? existsSync(join(abs, tdir, 'workflows', m[2]!, 'workflow.yaml'))
      : existsSync(join(abs, tdir, m[1]!, `${m[2]}.yaml`)) || existsSync(join(abs, tdir, m[1]!, `${m[2]}.yml`)));
    if (!m || !exists) {
      diagnostics.push({ severity: 'error', code: 'without-unknown', file: pf.file, line: at(['without', i]), message: `without: ${app.title} version ${version} has no ${w} (name workflows/<id>, pages/<id> or views/<id>)` });
      return;
    }
    without.add(`${m[1]}/${m[2]}`);
  });

  // Playbooks: the template's at `version`, each file replaced by an override when there is one.
  const workflows: Record<string, WorkflowDef> = {};
  for (const name of await subdirs(join(abs, tdir, 'workflows'))) {
    if (without.has(`workflows/${name}`) || APP_PLAYBOOKS.includes(name)) continue;
    const overlay = new Map<string, WorkflowOverlayFile>();
    for (const path of overrides) {
      const prefix = `workflows/${name}/`;
      if (path.startsWith(prefix)) overlay.set(path.slice(prefix.length), { bytes: bytes.get(path)!, file: `${overridesRel}/${path}` });
    }
    const template = live ? Object.values(project.workflows).find((w) => w.dir === `${tdir}/workflows/${name}`) : undefined;
    let wf: WorkflowDef | undefined;
    if (template && !overlay.size) {
      wf = { ...template };
    } else {
      const r = await loadWorkflow(join(abs, tdir, 'workflows', name), abs, { overlay });
      // A kept version was checked when it was live; report only what the project's own files break.
      diagnostics.push(...(overlay.size ? r.diagnostics : r.diagnostics.filter((d) => d.severity === 'error' && !live)));
      wf = r.workflow;
    }
    if (!wf) continue;
    wf.domain = domain.id;
    wf.project = pf.id;
    wf.hash = projectWorkflowHash(pf.id, wf.hash);
    if (locatorOf(template ?? {}) && !overlay.size) rememberLocator(wf, locatorOf(template!)!);
    workflows[wf.id] = wf;
  }

  // The app's policy layer: the project's own policy.yaml, else the template's at `version`.
  let policy: PolicyDoc | undefined;
  const policyPath = overrides.find((p) => /^policy\.ya?ml$/.test(p));
  if (policyPath) {
    const r = parsePolicyFile(bytes.get(policyPath)!.toString('utf8'), `${overridesRel}/${policyPath}`);
    diagnostics.push(...r.diagnostics);
    policy = r.value;
  } else if (live) {
    policy = domain.policy;
  } else if (existsSync(join(abs, tdir, 'policy.yaml'))) {
    policy = parsePolicyFile(await readFile(join(abs, tdir, 'policy.yaml'), 'utf8'), `${tdir}/policy.yaml`).value;
  }

  // Dashboards and shared views, the same way.
  const pages = await effectiveFiles<FreePageDef>(abs, 'pages', tdir, live ? domain.pages : undefined, overrides, bytes, overridesRel, without, parsePageFile, diagnostics);
  const views = await effectiveFiles<ViewDef>(abs, 'views', tdir, live ? domain.views : undefined, overrides, bytes, overridesRel, without, parseViewFile, diagnostics);

  const projectText = await readFile(join(abs, pf.file));
  const hash = sha256(projectText, '\0', domain.id, '\0', String(version), '\0',
    ...overrides.flatMap((p) => [p, '\0', bytes.get(p)!, '\0']), ...Object.values(workflows).map((w) => w.hash));
  const def: MwProjectDef = {
    id: pf.id, app: app.id, name: pf.name, version,
    from: projectSource(pf, version),
    ...(pf.template ? { template: pf.template } : {}),
    ...(pf.study ? { study: pf.study } : {}),
    status: pf.status, people: pf.people, connections: pf.connections,
    ...(pf.settings ? { settings: pf.settings } : {}),
    without: [...without].sort(), overrides, dir, file: pf.file, hash,
    workflows, ...(policy ? { policy } : {}), pages, views,
  };
  rememberLocator(def, locatorOf(pf) ?? (() => undefined));
  return def;
}

/** A project's pages or views: the template's at its version, overrides replacing files, minus `without`. */
async function effectiveFiles<T extends { id: string; file?: string }>(
  abs: string, sub: 'pages' | 'views', tdir: string, liveDefs: Record<string, T> | undefined, overrides: string[], bytes: Map<string, Buffer>,
  overridesRel: string, without: Set<string>, parse: (text: string, file: string) => { value?: T; diagnostics: Diagnostic[] }, diagnostics: Diagnostic[],
): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  const names = (await filesUnder(join(abs, tdir, sub))).filter((f) => /^[^/]+\.ya?ml$/.test(f));
  for (const f of names) {
    const path = `${sub}/${f}`;
    const base = f.replace(/\.ya?ml$/, '');
    if (without.has(`${sub}/${base}`)) continue;
    let def: T | undefined;
    if (overrides.includes(path)) {
      const r = parse(bytes.get(path)!.toString('utf8'), `${overridesRel}/${path}`);
      diagnostics.push(...r.diagnostics);
      def = r.value;
    } else if (liveDefs) {
      def = Object.values(liveDefs).find((d) => d.file === `${tdir}/${path}`);
    } else {
      def = parse(await readFile(join(abs, tdir, path), 'utf8'), `${tdir}/${path}`).value;
    }
    if (def) out[def.id] = def;
  }
  return out;
}
