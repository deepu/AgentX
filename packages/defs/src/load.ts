/** Loading a project folder, or one workflow folder, into the definition model. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseExampleFile, parseWorkflowFile } from './parse-workflow.ts';
import { parsePolicyFile } from './parse-policy.ts';
import { parseStepFile } from './parse-step.ts';
import { parseCaseFile, parseEntityFile, parseRolesFile } from './parse-types.ts';
import { lineOf, locatorOf, rememberLocator, Reporter } from './source.ts';
import { DEFAULT_DOMAIN, DOMAIN_ID_PATTERN, type DomainDef } from './domain-types.ts';
import { entityKey, resolveEntity } from './domains.ts';
import { defaultDomainName, parseDomainFile, parsePageFile, parseViewFile, parseWorkspaceFile } from './parse-domain.ts';
import { BINDINGS_DIR } from './plugin-types.ts';
import type { WorkflowOrigin } from './plugin-types.ts';
import { loadPluginsAndBindings, type LoadProjectOptions } from './project-plugins.ts';
import type { CaseTypeDef, Diagnostic, EntityTypeDef, ExampleCase, PolicyDoc, ProjectDefs, StepDef, WorkflowDef } from './types.ts';

const posix = (p: string) => p.split(sep).join('/');

/** Every file under `dir`, as paths relative to it, sorted; dotfiles (editor and OS litter) are skipped. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * Loads `workflows/<id>/`. `dir` may be absolute or relative to the working directory.
 * Returns the workflow whenever `workflow.yaml` could be read, even with errors, so the
 * checks can still say everything that is wrong.
 */
export async function loadWorkflow(dir: string, projectRoot: string): Promise<{ workflow?: WorkflowDef; diagnostics: Diagnostic[] }> {
  const root = resolve(projectRoot);
  const abs = resolve(dir);
  const relDir = posix(relative(root, abs)) || '.';
  const rel = (p: string) => posix(relative(root, p));
  const diagnostics: Diagnostic[] = [];
  const inDir = (f: string) => (relDir === '.' ? f : `${relDir}/${f}`);
  const shapeFile = inDir('workflow.yaml');

  if (!existsSync(join(abs, 'workflow.yaml'))) {
    return { diagnostics: [{ severity: 'error', code: 'missing-workflow-file', message: `${relDir} has no workflow.yaml`, file: relDir }] };
  }

  // Read every file once: the parsers use the text, the hash uses the bytes.
  const contents = new Map<string, Buffer>();
  for (const f of await listFiles(abs)) contents.set(f, await readFile(join(abs, f)));
  const text = (f: string) => contents.get(f)!.toString('utf8');

  const shapeResult = parseWorkflowFile(text('workflow.yaml'), shapeFile);
  diagnostics.push(...shapeResult.diagnostics);
  const shape = shapeResult.value;
  if (!shape) return { diagnostics };
  const report = new Reporter(shapeFile, locatorOf(shape) ?? (() => undefined));

  const folderName = basename(abs);
  if (shape.id && shape.id !== folderName) {
    report.warn('workflow-id-mismatch', `the workflow id \`${shape.id}\` differs from its folder name \`${folderName}\``, ['workflow']);
  }

  // Files the workflow points at outside its folder still belong to its hash.
  const outside = new Map<string, Buffer>();
  async function referenced(path: string, key: 'case' | 'policy', what: string): Promise<{ text: string; file: string } | undefined> {
    const target = resolve(abs, path);
    const inFolder = posix(relative(abs, target));
    if (contents.has(inFolder)) return { text: text(inFolder), file: rel(target) };
    // Only files inside the project belong to it; anything else is never read.
    const fromRoot = relative(root, target);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      report.error('path-outside-project', `the ${what} \`${path}\` is outside the project folder`, [key]);
      return undefined;
    }
    if (!inFolder.startsWith('..') || !existsSync(target)) {
      report.error(`missing-${key}-file`, `the ${what} \`${path}\` was not found`, [key]);
      return undefined;
    }
    const bytes = await readFile(target);
    outside.set(rel(target), bytes);
    return { text: bytes.toString('utf8'), file: rel(target) };
  }

  const caseSrc = await referenced(shape.case ?? './case.yaml', 'case', 'case type');
  let caseType: CaseTypeDef = { id: '', fields: {}, types: {}, file: rel(resolve(abs, shape.case ?? './case.yaml')), hash: '' };
  if (caseSrc) {
    const r = parseCaseFile(caseSrc.text, caseSrc.file);
    diagnostics.push(...r.diagnostics);
    if (r.value) caseType = r.value;
  }

  let policy: PolicyDoc | undefined;
  const policyPath = shape.policy ?? (contents.has('policy.yaml') ? './policy.yaml' : undefined);
  const policySrc = policyPath ? await referenced(policyPath, 'policy', 'workflow policy') : undefined;
  if (policySrc) {
    const r = parsePolicyFile(policySrc.text, policySrc.file);
    diagnostics.push(...r.diagnostics);
    policy = r.value;
  }

  const states = structuredClone(shape.states);
  const steps: Record<string, StepDef> = {};
  for (const f of contents.keys()) {
    const m = /^steps\/([^/]+)\.md$/.exec(f);
    if (!m) continue;
    const r = parseStepFile(text(f), inDir(f));
    diagnostics.push(...r.diagnostics);
    const state = states[m[1]!];
    if (!state) {
      diagnostics.push({ severity: 'warning', code: 'step-without-state', message: `${f} has no state \`${m[1]}\` in workflow.yaml, so it never runs`, file: inDir(f), line: 1 });
    } else if (r.value) {
      state.step = r.value.id;
      steps[r.value.id] = r.value;
    }
  }

  const examples: ExampleCase[] = [];
  for (const f of contents.keys()) {
    if (!/^examples\/[^/]+\.ya?ml$/.test(f)) continue;
    const r = parseExampleFile(text(f), inDir(f));
    diagnostics.push(...r.diagnostics);
    if (r.value) examples.push(r.value);
  }

  // sha256 over sorted (relative path, NUL, content, NUL): any change to any file changes it.
  const h = createHash('sha256');
  const all = [...contents.entries(), ...[...outside.entries()].map(([p, b]) => [`@project/${p}`, b] as const)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, bytes] of all) h.update(path).update('\0').update(bytes).update('\0');

  const workflow: WorkflowDef = {
    id: shape.id || folderName,
    version: shape.version,
    ...(shape.title !== undefined ? { title: shape.title } : {}),
    ...(shape.owner !== undefined ? { owner: shape.owner } : {}),
    start: shape.start,
    states,
    steps,
    caseType,
    ...(policy ? { policy } : {}),
    examples,
    dir: relDir,
    hash: h.digest('hex'),
    ...(forkOrigin(shape.forkedFrom) ? { origin: forkOrigin(shape.forkedFrom)! } : {}),
  };
  rememberLocator(workflow, locatorOf(shape)!);
  diagnostics.push(...report.diagnostics);
  return { workflow, diagnostics };
}

/** `memwise/client-intake@1.0.0` → a fork origin (the last `@` splits, so scoped ids stay whole). */
function forkOrigin(forkedFrom: string | undefined): WorkflowOrigin | undefined {
  const at = forkedFrom?.lastIndexOf('@') ?? -1;
  if (!forkedFrom || at <= 0 || at === forkedFrom.length - 1) return undefined;
  return { kind: 'fork', plugin: forkedFrom.slice(0, at), pluginVersion: forkedFrom.slice(at + 1) };
}

/**
 * Loads a whole project folder (see the layout in types.ts). Content errors are diagnostics; it
 * never throws for them. Phase 4: also `plugins/` and `domain/bindings/` (see project-plugins.ts).
 * Phase 6 (24 §2): `workspace.yaml`, the default domain (`domain/` and `workflows/`) and every
 * `domains/<id>/`; entity types are keyed by entity key.
 */
export async function loadProject(root: string, opts: LoadProjectOptions = {}): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[] }> {
  const abs = resolve(root);
  const project: ProjectDefs = { root: abs, roles: {}, entities: {}, workflows: {} };
  const diagnostics: Diagnostic[] = [];
  if (!(await isDir(abs))) {
    diagnostics.push({ severity: 'error', code: 'missing-project', message: `${root} is not a folder` });
    return { project, diagnostics };
  }

  // Phase 6: the workspace, and its roles (merged with domain/roles.yaml below).
  const workspaceFile = join(abs, 'workspace.yaml');
  const roleFiles: Record<string, string> = {};
  if (existsSync(workspaceFile)) {
    const r = parseWorkspaceFile(await readFile(workspaceFile, 'utf8'), 'workspace.yaml', basename(abs));
    diagnostics.push(...r.diagnostics);
    if (r.value) {
      project.workspace = r.value.workspace;
      project.roles = r.value.roles;
      for (const id of Object.keys(r.value.roles)) roleFiles[id] = 'workspace.yaml';
    }
  }

  const rolesFile = join(abs, 'domain', 'roles.yaml');
  if (existsSync(rolesFile)) {
    const r = parseRolesFile(await readFile(rolesFile, 'utf8'), 'domain/roles.yaml');
    diagnostics.push(...r.diagnostics);
    for (const [id, role] of Object.entries(r.value ?? {})) {
      if (roleFiles[id]) {
        diagnostics.push({ severity: 'error', code: 'duplicate-role', message: `the role \`${id}\` is also defined in ${roleFiles[id]}; define each role once`, file: 'domain/roles.yaml', line: lineOf(r.value!, ['roles', id]), path: `roles.${id}` });
        continue;
      }
      project.roles[id] = role;
      roleFiles[id] = 'domain/roles.yaml';
    }
  }

  const domains: Record<string, DomainDef> = {};
  // The default domain: the project root's `domain/` and `workflows/` folders (Phase 2-5 layout).
  if ((await isDir(join(abs, 'domain'))) || (await isDir(join(abs, 'workflows')))) {
    const domain = await loadDomain(abs, DEFAULT_DOMAIN, 'domain', 'workflows', project, diagnostics);
    if (domain.policy) project.domainPolicy = domain.policy;
    domains[DEFAULT_DOMAIN] = domain;
  }

  const domainsDir = join(abs, 'domains');
  if (await isDir(domainsDir)) {
    const ids = (await readdir(domainsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    for (const id of ids) {
      const file = `domains/${id}`;
      if (!DOMAIN_ID_PATTERN.test(id) || id === DEFAULT_DOMAIN) {
        diagnostics.push({
          severity: 'error', code: 'invalid-domain-id', file,
          message: id === DEFAULT_DOMAIN
            ? '`domain` is the default domain (the project root\'s domain/ and workflows/ folders); name this folder something else'
            : `\`${id}\` can't be a domain id: lower-case letters, digits and _, starting with a letter (at most 31)`,
        });
        continue;
      }
      if (await isDir(join(domainsDir, id, 'bindings'))) {
        diagnostics.push({ severity: 'warning', code: 'bindings-per-domain-later', message: `bindings are read from ${BINDINGS_DIR}/ only for now, so ${file}/bindings/ binds nothing; bind the plugin in the default domain`, file: `${file}/bindings` });
      }
      domains[id] = await loadDomain(abs, id, file, `${file}/workflows`, project, diagnostics);
    }
  }
  if (Object.keys(domains).length) project.domains = domains;

  // Lifecycle transitions without `by` default to [step, role:<the domain's owner>] (24 §4).
  for (const def of Object.values(project.entities)) {
    const owner = domains[def.domain ?? DEFAULT_DOMAIN]?.owner;
    if (!def.lifecycleChart || def.lifecycleChart.fromList) continue;
    for (const t of Object.values(def.lifecycleChart.transitions)) {
      if (!t.by.length) t.by = [{ kind: 'step' }, ...(owner ? [{ kind: 'role' as const, role: owner }] : [])];
    }
  }
  // A record trigger without `with:` passes the record to the case's one Ref to its entity (24 §7).
  for (const wf of Object.values(project.workflows)) defaultTriggerWith(wf, project.entities);

  // Phase 4: installed plugins, bindings, and the plugin workflows frozen bindings resolve.
  diagnostics.push(...(await loadPluginsAndBindings(abs, project, opts)));
  for (const wf of Object.values(project.workflows)) wf.domain ??= DEFAULT_DOMAIN;
  if (domains[DEFAULT_DOMAIN]) {
    domains[DEFAULT_DOMAIN].workflows = Object.values(project.workflows).filter((w) => w.domain === DEFAULT_DOMAIN).map((w) => w.id);
  }
  return { project, diagnostics };
}

/**
 * One domain's folder: `domain.yaml`, `policy.yaml`, `entities/`, `pages/`, `views/`, and its
 * workflows (`workflowsRel`: the root `workflows/` for the default domain, else `<dir>/workflows`).
 * Entities and workflows go into `project` (entities by key; workflow ids are unique across domains).
 */
async function loadDomain(abs: string, id: string, dirRel: string, workflowsRel: string, project: ProjectDefs, diagnostics: Diagnostic[]): Promise<DomainDef> {
  const dir = join(abs, dirRel);
  let domain: DomainDef = { id, name: defaultDomainName(id), dir: dirRel, entities: [], workflows: [], pages: {}, views: {} };
  const domainFile = join(dir, 'domain.yaml');
  if (existsSync(domainFile)) {
    const r = parseDomainFile(await readFile(domainFile, 'utf8'), `${dirRel}/domain.yaml`, id, dirRel);
    diagnostics.push(...r.diagnostics);
    if (r.value) domain = r.value;
  }

  const policyFile = join(dir, 'policy.yaml');
  if (existsSync(policyFile)) {
    const r = parsePolicyFile(await readFile(policyFile, 'utf8'), `${dirRel}/policy.yaml`);
    diagnostics.push(...r.diagnostics);
    if (r.value) domain.policy = r.value;
  }

  const byName: Record<string, EntityTypeDef> = {};
  for (const f of await yamlFiles(join(dir, 'entities'))) {
    const file = `${dirRel}/entities/${f}`;
    const r = parseEntityFile(await readFile(join(dir, 'entities', f), 'utf8'), file);
    diagnostics.push(...r.diagnostics);
    const entity = r.value;
    if (!entity?.entity) continue;
    const existing = byName[entity.entity];
    if (existing) {
      diagnostics.push({ severity: 'error', code: 'duplicate-entity', message: `entity type \`${entity.entity}\` is also defined in ${existing.file}`, file, line: 1 });
      continue;
    }
    entity.domain = id;
    byName[entity.entity] = entity;
    const key = entityKey(id, entity.entity);
    project.entities[key] = entity;
    domain.entities.push(key);
  }

  for (const [sub, parse, into] of [
    ['pages', parsePageFile, domain.pages],
    ['views', parseViewFile, domain.views],
  ] as const) {
    for (const f of await yamlFiles(join(dir, sub))) {
      const file = `${dirRel}/${sub}/${f}`;
      const r = parse(await readFile(join(dir, sub, f), 'utf8'), file);
      diagnostics.push(...r.diagnostics);
      if (!r.value) continue;
      if (into[r.value.id]) {
        diagnostics.push({ severity: 'error', code: `duplicate-${sub.slice(0, -1)}`, message: `${sub.slice(0, -1)} \`${r.value.id}\` is also defined in ${into[r.value.id]!.file}`, file, line: 1 });
        continue;
      }
      (into as Record<string, typeof r.value>)[r.value.id] = r.value;
    }
  }

  const workflowsDir = join(abs, workflowsRel);
  if (await isDir(workflowsDir)) {
    const dirs = (await readdir(workflowsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    for (const name of dirs) {
      const r = await loadWorkflow(join(workflowsDir, name), abs);
      diagnostics.push(...r.diagnostics);
      if (!r.workflow) continue;
      const existing = project.workflows[r.workflow.id];
      if (existing) {
        diagnostics.push({ severity: 'error', code: 'duplicate-workflow', message: `workflow \`${r.workflow.id}\` is also defined in ${existing.dir}; workflow ids are unique in the workspace`, file: shapeFileOf(r.workflow), line: 1 });
        continue;
      }
      r.workflow.domain = id;
      project.workflows[r.workflow.id] = r.workflow;
      domain.workflows.push(r.workflow.id);
    }
  }
  return domain;
}

/** `*.yaml` files directly in `dir`, sorted; none when it isn't a folder. */
async function yamlFiles(dir: string): Promise<string[]> {
  if (!(await isDir(dir))) return [];
  return (await listFiles(dir)).filter((f) => /^[^/]+\.ya?ml$/.test(f));
}

/** Fills `with: { <field>: record }` for record triggers that leave it out, when the case has one Ref to that entity. */
function defaultTriggerWith(wf: WorkflowDef, entities: Record<string, EntityTypeDef>): void {
  const domain = wf.domain ?? DEFAULT_DOMAIN;
  for (const t of wf.startsOn ?? []) {
    if (!('entity' in t) || Object.keys(t.with).length) continue;
    const target = resolveEntity(entities, domain, t.entity);
    if (!target) continue;
    const refs = Object.entries(wf.caseType.fields)
      .filter(([, f]) => f.type.kind === 'ref' && resolveEntity(entities, domain, f.type.entity) === target)
      .map(([name]) => name);
    if (refs.length === 1) t.with = { [refs[0]!]: 'record' };
  }
}

/** The workflow folder's `workflow.yaml`, relative to the project root. */
export function shapeFileOf(workflow: Pick<WorkflowDef, 'dir'>): string {
  return workflow.dir === '.' ? 'workflow.yaml' : `${workflow.dir}/workflow.yaml`;
}
