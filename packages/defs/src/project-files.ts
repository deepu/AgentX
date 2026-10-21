/**
 * Apps and projects as plain files (26 §3, D93): make a project (from a template card, a copy of
 * another project, or blank), publish a new app version (a template update), see what taking it
 * would change in a project, take it, and save a project as a template. The file layer only; the
 * runtime records who did what and syncs `mw.projects`.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import { splitFrontMatter } from './parse-step.ts';
import {
  APP_VERSIONS_DIR, OVERRIDABLE, OVERRIDES_DIR, PROJECT_ID_PATTERN, PROJECTS_DIR,
  type MwProjectDef, type ProjectPersonDef, type ProjectStatus, type TemplateChange, type TemplateUpdate,
} from './project-types.ts';
import { DOMAIN_ID_PATTERN } from './domain-types.ts';
import { templateDir } from './projects.ts';
import type { ProjectDefs } from './types.ts';

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

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

/** The template files a project can take, override or leave out, under an app folder (or a kept version). */
async function templateFiles(dir: string): Promise<string[]> {
  return (await filesUnder(dir)).filter((f) => !f.startsWith(`${APP_VERSIONS_DIR}/`) && OVERRIDABLE.test(f));
}

/**
 * Whether two versions of a file say the same: YAML (and a step's front matter) compared as data,
 * so comments and layout don't count; anything else as text with trailing spaces ignored.
 */
export function sameFileContent(path: string, a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/[ \t]+$/gm, '').trim();
  try {
    if (/\.ya?ml$/.test(path)) return JSON.stringify(parseYaml(a)) === JSON.stringify(parseYaml(b));
    if (/\.md$/.test(path)) {
      const fa = splitFrontMatter(a), fb = splitFrontMatter(b);
      if (fa && fb) return JSON.stringify(parseYaml(fa.yaml)) === JSON.stringify(parseYaml(fb.yaml)) && norm(fa.body) === norm(fb.body);
    }
  } catch { /* not parseable: compare as text */ }
  return norm(a) === norm(b);
}

function appOf(defs: ProjectDefs, appId: string) {
  const app = defs.apps?.[appId];
  const domain = defs.domains?.[appId];
  if (!app || !domain) throw new Error(`there is no app ${appId}`);
  return { app, domain };
}

function projectOf(defs: ProjectDefs, projectId: string): MwProjectDef {
  const p = defs.projects?.[projectId];
  if (!p) throw new Error(`there is no project ${projectId}`);
  return p;
}

// ---------------------------------------------------------------- template updates

/**
 * What taking the app's current version would change in a project (the "Review template update"
 * item): every template file that differs between the version the project took and the current
 * one, and what the project already has there. Undefined when the project is up to date.
 */
export async function templateUpdate(defs: ProjectDefs, projectId: string): Promise<TemplateUpdate | undefined> {
  const p = projectOf(defs, projectId);
  const { app, domain } = appOf(defs, p.app);
  if (p.implicit || p.version >= app.version) return undefined;
  const root = defs.root;
  const oldDir = join(root, templateDir(app, domain, p.version));
  const newDir = join(root, domain.dir);
  const [before, after] = [await templateFiles(oldDir), await templateFiles(newDir)];
  const changes: TemplateChange[] = [];
  const read = (dir: string, f: string) => readFile(join(dir, f), 'utf8');
  for (const path of [...new Set([...before, ...after])].sort()) {
    const had = before.includes(path), has = after.includes(path);
    if (had && has && sameFileContent(path, await read(oldDir, path), await read(newDir, path))) continue;
    const kind: TemplateChange['kind'] = !had ? 'added' : !has ? 'removed' : 'changed';
    const wf = /^workflows\/([^/]+)\//.exec(path)?.[1];
    const page = /^(pages|views)\/([^/]+?)\.ya?ml$/.exec(path);
    let project: TemplateChange['project'] = 'takes';
    if ((wf && p.without.includes(`workflows/${wf}`)) || (page && p.without.includes(`${page[1]}/${page[2]}`))) project = 'left-out';
    else if (p.overrides.includes(path)) {
      const mine = await readFile(join(root, p.dir!, OVERRIDES_DIR, path), 'utf8');
      project = has && sameFileContent(path, mine, await read(newDir, path)) ? 'overridden-same' : 'overridden-differs';
    }
    changes.push({ path, kind, ...(wf ? { workflow: wf } : {}), project });
  }
  const taken = changes.filter((c) => c.project === 'takes');
  return {
    projectId, app: app.id, from: p.version, to: app.version, changes,
    workflowsChanged: [...new Set(taken.flatMap((c) => (c.workflow ? [c.workflow] : [])))].sort(),
    policyChanged: taken.some((c) => /^policy\.ya?ml$/.test(c.path)),
  };
}

/**
 * Publishes a new version of an app's template: keeps the current one under `versions/<n>/`
 * (its playbooks, pages, views and policy; record types are always the app's own), applies
 * `files` (template path → new content, or null to remove it) and bumps `app.yaml`'s version.
 * Returns the new version.
 */
export async function publishAppVersion(defs: ProjectDefs, appId: string, files: Record<string, string | null>): Promise<number> {
  const { app, domain } = appOf(defs, appId);
  const dir = join(defs.root, domain.dir);
  for (const path of Object.keys(files)) {
    if (!OVERRIDABLE.test(path)) throw new Error(`${path} is not a template file (workflows/…, policy.yaml, pages/, views/)`);
  }
  const keep = join(dir, APP_VERSIONS_DIR, String(app.version));
  if (existsSync(keep)) throw new Error(`${domain.dir}/${APP_VERSIONS_DIR}/${app.version} already exists`);
  for (const f of await templateFiles(dir)) {
    await mkdir(dirname(join(keep, f)), { recursive: true });
    await cp(join(dir, f), join(keep, f));
  }
  if (existsSync(join(dir, 'app.yaml'))) await cp(join(dir, 'app.yaml'), join(keep, 'app.yaml'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (content === null) { await rm(target, { force: true }); continue; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const next = app.version + 1;
  await editYaml(join(dir, 'app.yaml'), (doc) => doc.set('version', next));
  return next;
}

/**
 * Takes the app's current version into a project: `version:` moves up, and every override that
 * now says what the template says is removed ("This project already does that"). Overrides that
 * still differ stay, so the project keeps its own way. Returns the overrides removed.
 */
export async function takeTemplateUpdate(defs: ProjectDefs, projectId: string): Promise<{ version: number; removed: string[] }> {
  const p = projectOf(defs, projectId);
  const { app } = appOf(defs, p.app);
  const update = await templateUpdate(defs, projectId);
  const removed: string[] = [];
  for (const c of update?.changes ?? []) {
    if (c.project !== 'overridden-same') continue;
    await rm(join(defs.root, p.dir!, OVERRIDES_DIR, c.path), { force: true });
    removed.push(c.path);
  }
  await editYaml(join(defs.root, p.file!), (doc) => doc.set('version', app.version));
  return { version: app.version, removed };
}

// ---------------------------------------------------------------- making projects

export interface CreateProjectInput {
  id: string;
  name: string;
  /** The app; when copying, the source project's app is used and this may be left out. */
  app?: string;
  /** A template card of the app. */
  template?: string;
  /** Copy this project's way of working (version, overrides, without, connections, people): never its records. */
  copyFrom?: string;
  study?: string;
  status?: ProjectStatus;
  people?: ProjectPersonDef[];
  /** Template paths to leave out, on top of the card's. */
  without?: string[];
  settings?: Record<string, unknown>;
}

/** A free project id from a name: `Study MW-310` → `study-mw-310`, unique among `taken`. */
export function projectIdFor(name: string, taken: Iterable<string>): string {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project').replace(/^(\d)/, 'p-$1').slice(0, 56);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Writes `projects/<id>/` for a new project. Records are never copied; the runtime makes the `mw.projects` row. */
export async function createProjectFiles(defs: ProjectDefs, input: CreateProjectInput): Promise<string> {
  if (!PROJECT_ID_PATTERN.test(input.id)) throw new Error(`\`${input.id}\` can't be a project id`);
  const dir = join(defs.root, PROJECTS_DIR, input.id);
  if (existsSync(dir) || defs.projects?.[input.id]) throw new Error(`a project ${input.id} already exists`);
  const source = input.copyFrom ? projectOf(defs, input.copyFrom) : undefined;
  const appId = source?.app ?? input.app;
  if (!appId) throw new Error('name the app, or a project to copy');
  const { app } = appOf(defs, appId);
  const card = input.template ? app.templates.find((t) => t.id === input.template) : undefined;
  if (input.template && !card) throw new Error(`${app.title} has no template ${input.template}`);
  const without = [...new Set([...(source?.without ?? card?.without ?? []), ...(input.without ?? [])])].sort();
  const people = input.people ?? source?.people ?? [];
  const connections = source?.connections ?? [];
  const settings = input.settings ?? source?.settings ?? card?.settings;
  const body: Record<string, unknown> = {
    app: appId,
    version: source?.version ?? app.version,
    name: input.name,
    ...(source ? { copied_from: source.id } : input.template ? { template: input.template } : {}),
    ...(input.study ? { study: input.study } : {}),
    ...(input.status && input.status !== 'active' ? { status: input.status } : {}),
    ...(people.length ? { people: people.map((p) => ({ email: p.email, ...(p.name ? { name: p.name } : {}), roles: p.roles, ...(p.note ? { note: p.note } : {}) })) } : {}),
    ...(connections.length ? { connections: Object.fromEntries(connections.map(({ id, ...c }) => [id, c])) } : {}),
    ...(without.length ? { without } : {}),
    ...(settings ? { settings } : {}),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), stringifyYaml(body));
  if (source && !source.implicit && source.overrides.length) {
    await cp(join(defs.root, source.dir!, OVERRIDES_DIR), join(dir, OVERRIDES_DIR), { recursive: true });
  }
  return `${PROJECTS_DIR}/${input.id}`;
}

/** Changes fields of a project.yaml (name, study, people…), keeping its comments. `undefined` removes a key. */
export async function updateProjectFile(defs: ProjectDefs, projectId: string, fields: Record<string, unknown>): Promise<void> {
  const p = projectOf(defs, projectId);
  if (p.implicit) throw new Error(`${projectId} has no project.yaml (it is its app's own project)`);
  await editYaml(join(defs.root, p.file!), (doc) => {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) doc.delete(k);
      else doc.set(k, v);
    }
  });
}

/**
 * Save as template: a project's effective definitions become the next version of its app
 * (`newApp` absent) or a new app (a copy of the app's folder with the project's files in place,
 * at version 1). No records are copied. Returns the app id and its version.
 */
export async function saveAsTemplate(defs: ProjectDefs, projectId: string, opts: { newApp?: { id: string; title: string } } = {}): Promise<{ app: string; version: number }> {
  const p = projectOf(defs, projectId);
  const { app, domain } = appOf(defs, p.app);
  const root = defs.root;
  const src = join(root, templateDir(app, domain, p.version));
  // The project's template files: the version it took, its overrides in place, without what it leaves out.
  const files: Record<string, string | null> = {};
  const left = (f: string) => {
    const wf = /^workflows\/([^/]+)\//.exec(f)?.[1];
    const page = /^(pages|views)\/([^/]+?)\.ya?ml$/.exec(f);
    return (wf && p.without.includes(`workflows/${wf}`)) || (page && p.without.includes(`${page[1]}/${page[2]}`));
  };
  for (const f of await templateFiles(src)) files[f] = left(f) ? null : await readFile(join(src, f), 'utf8');
  for (const f of p.overrides) files[f] = await readFile(join(root, p.dir!, OVERRIDES_DIR, f), 'utf8');

  if (!opts.newApp) {
    // Only what differs from the live template, plus removals of what the project doesn't have.
    const live = await templateFiles(join(root, domain.dir));
    const changes: Record<string, string | null> = {};
    for (const f of new Set([...live, ...Object.keys(files)])) {
      const mine = files[f];
      const theirs = live.includes(f) ? await readFile(join(root, domain.dir, f), 'utf8') : undefined;
      if (mine === undefined || mine === null) { if (theirs !== undefined) changes[f] = null; continue; }
      if (theirs === undefined || !sameFileContent(f, mine, theirs)) changes[f] = mine;
    }
    return { app: app.id, version: await publishAppVersion(defs, app.id, changes) };
  }

  const { id, title } = opts.newApp;
  if (!DOMAIN_ID_PATTERN.test(id)) throw new Error(`\`${id}\` can't be an app id: lower-case letters, digits and _, starting with a letter`);
  const target = join(root, 'domains', id);
  if (existsSync(target) || defs.domains?.[id]) throw new Error(`an app ${id} already exists`);
  await mkdir(target, { recursive: true });
  // Everything that isn't a template file comes along as it is (domain.yaml, record types, …).
  for (const f of await filesUnder(join(root, domain.dir))) {
    if (f.startsWith(`${APP_VERSIONS_DIR}/`) || OVERRIDABLE.test(f) || f === 'app.yaml') continue;
    await mkdir(dirname(join(target, f)), { recursive: true });
    await cp(join(root, domain.dir, f), join(target, f));
  }
  for (const [f, content] of Object.entries(files)) {
    if (content === null) continue;
    await mkdir(dirname(join(target, f)), { recursive: true });
    await writeFile(join(target, f), content);
  }
  if (existsSync(join(target, 'domain.yaml'))) {
    await editYaml(join(target, 'domain.yaml'), (doc) => {
      if (doc.has('domain')) doc.set('domain', id);
      doc.set('name', title);
      // An intake address names one domain.
      doc.delete('intake');
    });
  }
  const appYaml = existsSync(join(root, domain.dir, 'app.yaml')) ? parseYaml(await readFile(join(root, domain.dir, 'app.yaml'), 'utf8')) ?? {} : {};
  await writeFile(join(target, 'app.yaml'), stringifyYaml({ ...appYaml, app: id, title, version: 1, description: `Saved from ${p.name}.` }));
  return { app: id, version: 1 };
}

/** Edits a YAML file in place (creating it when missing), keeping comments and layout. */
async function editYaml(path: string, edit: (doc: ReturnType<typeof parseDocument>) => void): Promise<void> {
  const text = existsSync(path) ? await readFile(path, 'utf8') : '';
  const doc = parseDocument(text);
  if (!doc.contents) doc.contents = doc.createNode({}) as never;
  edit(doc);
  await writeFile(resolve(path), doc.toString());
}
