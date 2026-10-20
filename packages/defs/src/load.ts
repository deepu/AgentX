/** Loading a project folder, or one workflow folder, into the definition model. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseExampleFile, parseWorkflowFile } from './parse-workflow.ts';
import { parsePolicyFile } from './parse-policy.ts';
import { parseStepFile } from './parse-step.ts';
import { parseCaseFile, parseEntityFile } from './parse-types.ts';
import { locatorOf, rememberLocator, Reporter } from './source.ts';
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
    start: shape.start,
    states,
    steps,
    caseType,
    ...(policy ? { policy } : {}),
    examples,
    dir: relDir,
    hash: h.digest('hex'),
  };
  rememberLocator(workflow, locatorOf(shape)!);
  diagnostics.push(...report.diagnostics);
  return { workflow, diagnostics };
}

/** Loads a whole project folder (see the layout in types.ts). Content errors are diagnostics; it never throws for them. */
export async function loadProject(root: string): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[] }> {
  const abs = resolve(root);
  const project: ProjectDefs = { root: abs, entities: {}, workflows: {} };
  const diagnostics: Diagnostic[] = [];
  if (!(await isDir(abs))) {
    diagnostics.push({ severity: 'error', code: 'missing-project', message: `${root} is not a folder` });
    return { project, diagnostics };
  }

  const domainPolicy = join(abs, 'domain', 'policy.yaml');
  if (existsSync(domainPolicy)) {
    const r = parsePolicyFile(await readFile(domainPolicy, 'utf8'), 'domain/policy.yaml');
    diagnostics.push(...r.diagnostics);
    if (r.value) project.domainPolicy = r.value;
  }

  const entityDir = join(abs, 'domain', 'entities');
  if (await isDir(entityDir)) {
    for (const f of await listFiles(entityDir)) {
      if (!/^[^/]+\.ya?ml$/.test(f)) continue;
      const file = `domain/entities/${f}`;
      const r = parseEntityFile(await readFile(join(entityDir, f), 'utf8'), file);
      diagnostics.push(...r.diagnostics);
      const entity = r.value;
      if (!entity?.entity) continue;
      const existing: EntityTypeDef | undefined = project.entities[entity.entity];
      if (existing) {
        diagnostics.push({ severity: 'error', code: 'duplicate-entity', message: `entity type \`${entity.entity}\` is also defined in ${existing.file}`, file, line: 1 });
        continue;
      }
      project.entities[entity.entity] = entity;
    }
  }

  const workflowsDir = join(abs, 'workflows');
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
        diagnostics.push({ severity: 'error', code: 'duplicate-workflow', message: `workflow \`${r.workflow.id}\` is also defined in ${existing.dir}`, file: shapeFileOf(r.workflow), line: 1 });
        continue;
      }
      project.workflows[r.workflow.id] = r.workflow;
    }
  }
  return { project, diagnostics };
}

/** The workflow folder's `workflow.yaml`, relative to the project root. */
export function shapeFileOf(workflow: Pick<WorkflowDef, 'dir'>): string {
  return workflow.dir === '.' ? 'workflow.yaml' : `${workflow.dir}/workflow.yaml`;
}
