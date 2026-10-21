#!/usr/bin/env bun
// The `memwise` CLI: check a project, run its example cases, show a step record, show a step's
// effective policy (Phase 1); make, diff and publish drafts, start a project, convert an old
// task (Phase 3, docs/memwise/20-phase-3-interfaces.md §7).
import { createPool, PgAuditLog, PgStepRecordReader, PgVersionStore } from '@memwise/db';
import {
  applyDraft, checkProject, convertTaskYaml, createBindingDraft, createDraft, describeStructuralDiff, diffDraft, DraftConflictError,
  draftContentHash, draftDir, importClaudePlugin, initProject, installPlugin, listDrafts, loadDraft, loadProject, loadWorkflow,
  PLUGIN_MANIFEST, proposeBinding, readDraft, withDiscoveredTools, writeDraftFiles,
  type Diagnostic, type ExampleCase, type ExampleOutcome, type PluginManifest, type ProjectDefs, type StepRecordReader, type WorkflowDef,
} from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import { compilePolicy, describePolicy, extractDiagnostics, layersFor, pluginLayers, violationsToDiagnostics } from '@memwise/policy';
import { recallTools } from '@memwise/step-engine';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { format } from 'node:util';
import { authoringToolDefinitions } from './authoring-tools.ts';
import { externalToolDefinitions } from './external/service.ts';
import { bindingToolDefinitions } from './plugins/kernel-tools.ts';
import { loadProjectAt } from './plugins/load.ts';
import { discoverMcpTools } from './plugins/routes.ts';
import { compareVersions } from './plugins/service.ts';
import { boundPlugins, pluginPolicies, pluginToolEnvironment, toolClass } from './plugins/tools.ts';
import { domainTools } from './domain-tools.ts';
import { runExample, type ExampleResult } from './examples.ts';
import { DEFAULT_ENGINE_VERSION } from './kernel.ts';
import { renderValidationReport } from './regulated/validation-report.ts';
import { verifyAuditExport } from './regulated/audit-log.ts';
import { sampleTools } from './sample-tools.ts';
import { projectPolicyLayers } from './runs.ts';

const USAGE = `usage:
  memwise check <project>
  memwise test <project> [--workflow <id>] [--example <name>] [--examples-file <file.json>] [--json] [--database-url <admin-url>]
  memwise record <step-run-id> --database-url <url>
  memwise policy <project> <workflow> <step>
  memwise init <dir> [--template empty|intake] [--from <sample-project>]
  memwise draft <project> <workflow> [--title <title>] [--new]
  memwise diff <project> <draft>
  memwise push <project> <draft> [--database-url <url>] [--test-database-url <admin-url>] [--by <person>]
  memwise convert <task.yaml> <project>
  memwise plugin install <project> <plugin-folder>
  memwise plugin list <project>
  memwise bind <project> <plugin-id> [--draft]
  memwise validation-report <project> [--out <report.md>] [--database-url <admin-url>]
  memwise audit verify <export.json> [--key <public-key>]
  memwise audit verify --project <id> --database-url <url>`;

/**
 * The tools a project is checked against: the sample set (the CLI's builtins), the recall tools,
 * the kernel's playbooks.* and plugins.* tools, the project's domain tools, and the tools of its
 * frozen bindings (names and classes, no connection made).
 */
function boundTools(project?: ProjectDefs): Record<string, { effect?: import('@memwise/defs').EffectClass; inputSchema?: Record<string, unknown> }> {
  const noReader = {} as StepRecordReader; // only names, classes and schemas are read, never executed
  const defs: ToolDefinition[] = [...sampleTools(), ...recallTools(noReader), ...authoringToolDefinitions(), ...bindingToolDefinitions(), ...externalToolDefinitions(), ...domainTools(project?.entities ?? {})];
  const out: ReturnType<typeof boundTools> = Object.fromEntries(defs.map((t) => [t.name, { effect: typeof t.effect === 'string' ? t.effect : undefined, inputSchema: t.inputSchema }]));
  if (project) for (const [name, t] of Object.entries(pluginToolEnvironment(boundPlugins(project)))) out[name] ??= t;
  return out;
}

function printDiagnostics(diagnostics: Diagnostic[], out: (line: string) => void = console.log) {
  for (const d of diagnostics) {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(project)';
    out(`${where}  ${d.severity}  ${d.code}  ${d.message}${d.path && !d.line ? ` (${d.path})` : ''}`);
  }
}

/** Everything `memwise check` reports for a project folder (a draft folder is one too). */
async function diagnose(dir: string): Promise<{ project: ProjectDefs; all: Diagnostic[] }> {
  const { project, diagnostics } = await loadProjectAt(dir);
  const tools = boundTools(project);
  const all = [...diagnostics, ...checkProject(project, { tools })];
  // Policy tightening, per step (the workflow layer is checked as part of each step's stack).
  const seen = new Set<string>();
  const policies = pluginPolicies(boundPlugins(project));
  for (const workflow of Object.values(project.workflows)) {
    for (const step of [undefined, ...Object.values(workflow.steps)]) {
      const plugins = pluginLayers(policies, workflow, step);
      const { effective, violations } = compilePolicy(layersFor({ ...projectPolicyLayers(project, workflow), plugins, workflow, step }));
      for (const d of [...violationsToDiagnostics(violations), ...extractDiagnostics(step, effective, tools)]) {
        const key = `${d.file}|${d.path}|${d.message}`;
        if (!seen.has(key)) { seen.add(key); all.push(d); }
      }
    }
  }
  return { project, all };
}

const errorCount = (ds: Diagnostic[]) => ds.filter((d) => d.severity === 'error').length;

async function check(dir: string): Promise<number> {
  const { all } = await diagnose(dir);
  printDiagnostics(all);
  const errors = errorCount(all);
  console.log(`${errors} error(s), ${all.length - errors} warning(s)`);
  return errors ? 1 : 0;
}

function printResult(r: ExampleResult, out: (line: string) => void = console.log) {
  const name = `${r.workflow}/${r.example}`;
  if (r.status === 'skip') out(`SKIP ${name}: ${r.reason}`);
  else {
    out(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${name}`);
    for (const d of r.differences) out(`     ${d}`);
  }
}

const toOutcome = (r: ExampleResult): ExampleOutcome => r.status === 'skip'
  ? { name: r.example, status: 'skip', differences: [], reason: r.reason }
  : { name: r.example, status: r.status, differences: r.differences };

/** Extra example cases from a JSON file (past cases replayed, for the TestRunner); `file` may be absent. */
async function readExamplesFile(path: string, workflow: WorkflowDef): Promise<ExampleCase[]> {
  const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error(`${path} must hold a JSON array of example cases`);
  return data.map((raw, i) => {
    const ex = raw as Partial<ExampleCase>;
    if (!ex || typeof ex !== 'object' || typeof ex.name !== 'string') throw new Error(`${path}: example ${i + 1} has no name`);
    return { ...ex, case: ex.case ?? {}, expect: ex.expect ?? {}, file: ex.file ?? `${workflow.dir}/examples/${ex.name}.yaml` } as ExampleCase;
  });
}

interface TestOptions { example?: string; databaseUrl?: string; workflow?: string; json?: boolean; examplesFile?: string }

async function test(dir: string, opts: TestOptions): Promise<number> {
  // With --json, stdout carries only the JSON array; everything else (kernel logs included) goes to stderr.
  const err = (line: string) => process.stderr.write(`${line}\n`);
  const out = opts.json ? err : (line: string) => console.log(line);
  const restore = opts.json ? quietStdout() : () => {};
  let results: ExampleResult[] = [];
  let code: number;
  try {
    const { project, diagnostics } = await loadProjectAt(dir);
    const loadErrors = diagnostics.filter((d) => d.severity === 'error');
    if (loadErrors.length) { printDiagnostics(loadErrors, out); return 1; }
    const workflows = opts.workflow ? [project.workflows[opts.workflow]].filter((w): w is WorkflowDef => !!w) : Object.values(project.workflows);
    if (opts.workflow && !workflows.length) { out(`no workflow ${opts.workflow}`); return 1; }
    if (opts.examplesFile && workflows.length !== 1) { out('--examples-file needs --workflow <id> (the examples run against it)'); return 2; }
    for (const workflow of workflows) {
      const examples = [...workflow.examples, ...(opts.examplesFile ? await readExamplesFile(opts.examplesFile, workflow) : [])];
      for (const example of examples) {
        if (opts.example && example.name !== opts.example) continue;
        const r = await runExample(project, workflow, example, { adminUrl: opts.databaseUrl });
        results.push(r);
        printResult(r, out);
      }
    }
    if (opts.example && !results.length) { out(`no example named ${opts.example}`); return 1; }
    const count = (s: ExampleResult['status']) => results.filter((r) => r.status === s).length;
    out(`${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
    code = count('fail') ? 1 : 0;
  } finally {
    restore();
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(results.map(toOutcome))}\n`);
  return code;
}

/** Sends console output to stderr until the returned function is called. */
function quietStdout(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const toErr = (...args: unknown[]) => process.stderr.write(`${format(...args)}\n`);
  console.log = console.info = console.debug = console.warn = toErr;
  return () => Object.assign(console, saved);
}

/**
 * The validation pack (24 §9): every workflow's example cases, run as `memwise test` runs them,
 * with the checks, written as a Markdown report (to `out`, else stdout). Exit 1 when an example
 * fails or a check has an error; the report is written either way.
 */
async function validationReport(dir: string, opts: { out?: string; databaseUrl?: string }): Promise<number> {
  const log = opts.out ? (line: string) => console.error(line) : (line: string) => process.stderr.write(`${line}\n`);
  const restore = opts.out ? () => {} : quietStdout();
  let report: string;
  let failed: boolean;
  try {
    const { project, all } = await diagnose(dir);
    const results: ExampleResult[] = [];
    for (const workflow of Object.values(project.workflows)) {
      for (const example of workflow.examples) {
        const r = await runExample(project, workflow, example, { adminUrl: opts.databaseUrl });
        results.push(r);
        printResult(r, log);
      }
    }
    report = renderValidationReport({
      project, diagnostics: all, results, engineVersion: DEFAULT_ENGINE_VERSION, at: new Date(),
      ...(process.env.MEMWISE_RELEASE ? { release: process.env.MEMWISE_RELEASE } : {}),
    });
    failed = errorCount(all) > 0 || results.some((r) => r.status === 'fail');
  } finally {
    restore();
  }
  if (opts.out) {
    await writeFile(opts.out, report);
    console.log(`wrote the validation report to ${resolve(opts.out)}${failed ? ' (it records failures)' : ''}`);
  } else process.stdout.write(report);
  return failed ? 1 : 0;
}

async function record(stepRunId: string, databaseUrl: string): Promise<number> {
  const pool = createPool(databaseUrl, { max: 1 });
  try {
    const r = await new PgStepRecordReader(pool).get(stepRunId);
    if (!r) { console.log(`no step record ${stepRunId}`); return 1; }
    const { context, journal, ...rest } = r;
    console.log('== step record');
    console.log(JSON.stringify(rest, null, 2));
    console.log('\n== context');
    if (!context) console.log('(not recorded)');
    else {
      console.log(`model role: ${context.modelRole}   hash: ${context.hash}`);
      console.log(`tools: ${context.tools.map((t) => t.tool).join(', ')}`);
      console.log(`pushed: ${JSON.stringify(context.pushed, null, 2)}`);
      if (context.priorAttempts.length) console.log(`prior attempts: ${JSON.stringify(context.priorAttempts)}`);
      console.log(`--- system prompt\n${context.systemPrompt}`);
    }
    console.log(`\n== journal (${journal.length})`);
    for (const j of journal) {
      const head = `${j.startedAt}  ${j.kind.padEnd(10)} ${j.name}${j.callId ? ` [${j.callId}]` : ''}${j.effect ? ` (${j.effect})` : ''}`;
      console.log(head + (j.durationMs !== undefined ? `  ${j.durationMs}ms` : ''));
      console.log(`    request:  ${JSON.stringify(j.request)}`);
      if (j.response !== undefined) console.log(`    response: ${JSON.stringify(j.response)}`);
      if (j.error) console.log(`    error:    ${j.error}`);
    }
    return 0;
  } finally {
    await pool.end();
  }
}

async function policy(dir: string, workflowId: string, stepId: string): Promise<number> {
  const { project } = await loadProjectAt(dir);
  const workflow = project.workflows[workflowId];
  if (!workflow) { console.log(`no workflow ${workflowId}`); return 1; }
  const step = workflow.steps[stepId];
  if (!step) { console.log(`workflow ${workflowId} has no step ${stepId}`); return 1; }
  const plugins = pluginLayers(pluginPolicies(boundPlugins(project)), workflow, step);
  const { effective, violations } = compilePolicy(layersFor({ ...projectPolicyLayers(project, workflow), plugins, workflow, step }));
  console.log(describePolicy(effective));
  if (violations.length) {
    console.log('\nviolations:');
    printDiagnostics(violationsToDiagnostics(violations));
  }
  return violations.length ? 1 : 0;
}

// ---------------------------------------------------------------- Phase 3: projects and drafts

async function init(dir: string, template: string | undefined, from: string | undefined): Promise<number> {
  if (template !== undefined && template !== 'empty' && template !== 'intake') { console.log(`no template ${template}: use empty or intake`); return 2; }
  const files = await initProject(dir, { template: (template ?? 'empty') as 'empty' | 'intake', ...(from ? { source: from } : {}) });
  console.log(`made a new project in ${resolve(dir)} (${files.length} files)`);
  for (const f of files) console.log(`  ${f}`);
  return 0;
}

async function draft(root: string, workflowId: string, opts: { title?: string; create: boolean }): Promise<number> {
  const meta = await createDraft(root, {
    workflowId,
    title: opts.title ?? (opts.create ? `New playbook ${workflowId}` : `Change ${workflowId}`),
    kind: opts.create ? 'create' : 'change',
    createdBy: 'cli',
  });
  console.error(`draft ${meta.id}: ${meta.kind === 'change' ? `version ${meta.baseVersion} → ${(meta.baseVersion ?? 0) + 1}` : 'a new playbook'}; edit its files, then memwise diff / memwise push`);
  console.log(draftDir(root, meta.id));
  return 0;
}

/** A draft named by id or by its folder (`drafts/<id>`, or a path to it). */
const draftId = (arg: string) => basename(arg.replace(/[\\/]+$/, ''));

async function diff(root: string, arg: string): Promise<number> {
  const id = draftId(arg);
  if (!(await readDraft(root, id))) { console.log(`there is no draft ${id} in ${root}`); return 1; }
  const d = await diffDraft(root, id);
  if (!d.files.length) console.log('no changes yet');
  for (const f of d.files) {
    console.log(`--- ${f.status === 'added' ? '/dev/null' : `live/${f.path}`}`);
    console.log(`+++ ${f.status === 'deleted' ? '/dev/null' : `draft/${f.path}`}${f.conflict ? '   (changed live since the draft was made)' : ''}`);
    for (const h of f.hunks) {
      console.log(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines) console.log(`${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}${l.text}`);
    }
  }
  if (d.structure) {
    console.log('\n== in plain words');
    for (const line of describeStructuralDiff(d.structure)) console.log(`  ${line}`);
  } else console.log(`\nworkflows/${d.workflowId} doesn't load as a playbook yet, so there is no structural diff`);
  if (d.conflicts.length) console.log(`\n${d.conflicts.length} file(s) changed live since the draft was made; publishing is refused until that's sorted out`);
  return 0;
}

async function push(root: string, arg: string, opts: { databaseUrl?: string; testDatabaseUrl?: string; by?: string }): Promise<number> {
  const id = draftId(arg);
  const found = await readDraft(root, id);
  if (!found) { console.log(`there is no draft ${id} in ${root}`); return 1; }
  if (found.meta.status !== 'open') { console.log(`draft ${id} is already ${found.meta.status}`); return 1; }
  // The content checked and tested is the content published (a write meanwhile makes it stale).
  const hash = await draftContentHash(root, id);

  console.log(`== checks (${found.meta.workflowId})`);
  const { all } = await diagnose(draftDir(root, id));
  printDiagnostics(all);
  const errors = errorCount(all);
  console.log(`${errors} error(s), ${all.length - errors} warning(s)`);
  if (errors) { console.log('not published: fix the errors first'); return 1; }

  const { project, workflow } = await loadDraft(root, id);
  if (!workflow) { console.log(`not published: the draft has no playbook ${found.meta.workflowId}`); return 1; }
  // A regulated domain's playbook changes only through a change request and QA's signature (26 §8, D115).
  if (project.domains?.[workflow.domain ?? 'domain']?.regulated) {
    console.log(`not published: ${found.meta.workflowId} is in a regulated domain; open a change request in the app, and QA's signature publishes it`);
    return 1;
  }
  console.log('\n== example cases');
  const results: ExampleResult[] = [];
  for (const example of workflow.examples) {
    const r = await runExample(project, workflow, example, { adminUrl: opts.testDatabaseUrl });
    results.push(r);
    printResult(r);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  console.log(`${results.filter((r) => r.status === 'pass').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'skip').length} skipped`);
  if (failed) { console.log('not published: an example case fails'); return 1; }

  let published: Awaited<ReturnType<typeof applyDraft>>;
  try {
    published = await applyDraft(root, id, { hash });
  } catch (e) {
    if (e instanceof DraftConflictError) {
      console.log('not published: these live files changed since the draft was made:');
      for (const p of e.paths) console.log(`  ${p}`);
      return 1;
    }
    console.log(`not published: ${(e as Error).message}`);
    return 1;
  }
  console.log(`\npublished ${published.workflowId} version ${published.version} (${published.files.length} file(s))`);
  for (const f of published.files) console.log(`  ${f}`);

  if (opts.databaseUrl) await recordVersion(root, opts.databaseUrl, { workflowId: published.workflowId, version: published.version, draftId: id, by: opts.by });
  return 0;
}

/** Records the publish in the version index (source `cli`). Without it the next index records the hash as `files`. */
async function recordVersion(root: string, url: string, v: { workflowId: string; version: number; draftId: string; by?: string }): Promise<void> {
  const { workflow } = await loadWorkflow(join(resolve(root), 'workflows', v.workflowId), root);
  if (!workflow) return;
  const pool = createPool(url, { max: 1 });
  try {
    await new PgVersionStore().record(pool, {
      workflowId: v.workflowId, version: v.version, hash: workflow.hash, source: 'cli', draftId: v.draftId, ...(v.by ? { publishedBy: v.by } : {}),
    });
    console.log(`recorded version ${v.version} in the version index`);
  } catch (e) {
    const missing = (e as { code?: string }).code === '42P01';
    console.log(missing
      ? 'the database has no version index yet; the kernel records this version when it next indexes the project'
      : `could not record the version in the database (${(e as Error).message}); the kernel records it when it next indexes the project`);
  } finally {
    await pool.end();
  }
}

async function convert(taskFile: string, root: string): Promise<number> {
  const { project } = await loadProject(root);
  const permitted = project.domainPolicy?.modelRoles;
  // Agent steps name a model role the domain permits, so the draft passes the policy checks.
  const modelRole = !permitted || permitted.includes('worker') ? 'worker' : permitted[0]!;
  const { workflowId, files } = convertTaskYaml(await readFile(taskFile, 'utf8'), { roles: Object.keys(project.roles), modelRole });
  const title = /^title:\s*(.+)$/m.exec(await readFile(taskFile, 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '');
  const meta = await createDraft(root, { workflowId, title: title ?? workflowId, kind: 'create', createdBy: 'cli' });
  await writeDraftFiles(root, meta.id, files, { by: 'cli', via: 'cli', summary: `Converted from ${basename(taskFile)}` });
  console.error(`converted ${basename(taskFile)} into a new playbook ${workflowId} (${Object.keys(files).length} files); check it with memwise check, then memwise push`);
  console.log(draftDir(root, meta.id));
  return 0;
}

// ---------------------------------------------------------------- Phase 4: plugins and bindings

async function pluginInstall(root: string, dir: string): Promise<number> {
  const src = resolve(dir);
  let manifest: PluginManifest | undefined;
  const notes: string[] = [];
  if (!existsSync(join(src, PLUGIN_MANIFEST))) {
    const imported = await importClaudePlugin(src);
    manifest = imported.manifest;
    notes.push(...imported.notes);
    for (const [name, server] of Object.entries(manifest.mcpServers)) {
      try {
        const tools = await discoverMcpTools(server, src, name);
        manifest = withDiscoveredTools(manifest, name, tools);
        notes.push(`found ${tools.length} tool(s) on the MCP server ${name}`);
      } catch (e) {
        notes.push(`the MCP server ${name} could not be reached, so its tools are not known yet: ${(e as Error).message}`);
      }
    }
  }
  const r = await installPlugin(root, src, manifest ? { manifest } : {});
  console.log(r.created ? `installed ${r.id} ${r.version} in ${r.dir}` : `${r.id} ${r.version} is already installed in ${r.dir}`);
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(`nothing is bound yet: bind it with memwise bind ${root} ${r.id} --draft, or in the app`);
  return 0;
}

async function pluginList(root: string): Promise<number> {
  const { project, diagnostics } = await loadProject(root);
  for (const d of diagnostics.filter((x) => x.code.startsWith('plugin') || x.code.startsWith('binding'))) printDiagnostics([d]);
  const ids = Object.keys(project.pluginVersions ?? project.plugins ?? {}).sort();
  if (!ids.length) { console.log('no plugins installed'); return 0; }
  const drafts = (await listDrafts(root)).filter((d) => d.kind === 'binding' && d.status === 'open');
  for (const id of ids) {
    const versions = Object.keys(project.pluginVersions?.[id] ?? {}).sort(compareVersions).reverse();
    const newest = project.plugins?.[id];
    const b = project.bindings?.[id];
    const draft = drafts.find((d) => d.plugin?.id === id);
    const state = b?.frozen ? `bound v${b.version} (${b.pluginVersion})${newest && compareVersions(newest.manifest.version, b.pluginVersion) > 0 ? `, ${newest.manifest.version} available` : ''}`
      : draft ? `being bound (draft ${draft.id})` : 'not bound';
    console.log(`${id}  ${versions.join(', ') || newest?.manifest.version}  ${newest?.manifest.title ?? ''}  [${newest?.manifest.trust ?? '?'}]  ${state}`);
    if (newest) {
      const tools = Object.values(newest.manifest.tools).map((t) => `${t.name} (${toolClass(t, b?.pluginVersion === newest.manifest.version ? b : undefined).effect ?? 'unclassified'})`);
      if (tools.length) console.log(`    tools: ${tools.join(', ')}`);
    }
  }
  return 0;
}

async function bind(root: string, pluginId: string, opts: { draft: boolean }): Promise<number> {
  const { project } = await loadProject(root);
  const plugin = project.plugins?.[pluginId];
  if (!plugin) { console.log(`${pluginId} is not installed in ${root} (memwise plugin install ${root} <folder>)`); return 1; }
  const previous = project.bindings?.[pluginId];
  const proposal = proposeBinding({ plugin, project, ...(previous ? { previous } : {}) });
  console.log(`${previous ? `an upgrade of the binding of ${pluginId} (v${previous.version}, ${previous.pluginVersion})` : `a binding of ${pluginId}`} to ${plugin.manifest.version}`);
  console.log('\n== tools');
  for (const [name, c] of Object.entries(proposal.classes).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${name}  ${c.effect ?? 'unclassified'}  (${c.from})`);
  console.log('\n== gaps');
  if (!proposal.gaps.length) console.log('  none');
  for (const g of proposal.gaps) console.log(`  ${g.kind}  ${g.subject}: ${g.message}${g.suggestions?.length ? ` (perhaps ${g.suggestions.join(', ')})` : ''}`);
  if (!opts.draft) return 0;
  const meta = await createBindingDraft(root, {
    pluginId, pluginVersion: plugin.manifest.version, title: `${previous ? 'Upgrade' : 'Bind'} ${plugin.manifest.title}`, createdBy: 'cli', binding: proposal.binding,
  });
  console.error(`\nbinding draft ${meta.id}: edit domain/bindings in it, then review and freeze it in the app (bind-plugin)`);
  console.log(draftDir(root, meta.id));
  return 0;
}

/**
 * Checks an audit export (26 §8): every entry's hash, the links between entries and the file's
 * signature; with `--key`, also that it was signed by that key. Or a project's whole log in a database.
 */
async function auditVerify(file: string | undefined, opts: { key?: string; project?: string; databaseUrl?: string }): Promise<number> {
  if (file) {
    let doc: unknown;
    try { doc = JSON.parse(await readFile(file, 'utf8')); } catch (e) { console.log(`${file} is not JSON: ${(e as Error).message}`); return 1; }
    const r = verifyAuditExport(doc, opts.key);
    console.log(r.message);
    if (r.chain.brokenAt) console.log(`  first broken entry: ${r.chain.brokenAt.seq} (${r.chain.brokenAt.id}), ${r.chain.brokenAt.reason === 'hash' ? 'its hash does not match' : 'it does not follow the entry before it'}`);
    if (r.signature?.publicKey) console.log(`  signed by key ${r.signature.publicKey.slice(-16)}${r.signature.trusted === undefined ? '' : r.signature.trusted ? ' (the key given)' : ' (not the key given)'}`);
    return r.ok ? 0 : 1;
  }
  if (!opts.project || !opts.databaseUrl) return 2;
  const pool = createPool(opts.databaseUrl, { max: 1 });
  try {
    const r = await new PgAuditLog().verify(pool, opts.project);
    console.log(r.ok ? `The chain of ${opts.project} holds for all ${r.entries} entries.` : `The chain of ${opts.project} is broken: ${r.message}.`);
    return r.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const BOOLEAN = new Set(['json', 'new', 'draft']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) flags[a.slice(2)] = BOOLEAN.has(a.slice(2)) ? 'true' : (rest[++i] ?? '');
    else positional.push(a);
  }
  try {
    switch (cmd) {
      case 'check': if (positional[0]) return await check(positional[0]); break;
      case 'test': if (positional[0]) {
        return await test(positional[0], {
          example: flags.example, databaseUrl: flags['database-url'], workflow: flags.workflow, json: flags.json === 'true', examplesFile: flags['examples-file'],
        });
      } break;
      case 'record': {
        const url = flags['database-url'] ?? process.env.MEMWISE_DATABASE_URL;
        if (positional[0] && url) return await record(positional[0], url);
        break;
      }
      case 'policy': if (positional.length === 3) return await policy(positional[0]!, positional[1]!, positional[2]!); break;
      case 'init': if (positional[0]) return await init(positional[0], flags.template, flags.from); break;
      case 'draft': if (positional.length === 2) return await draft(positional[0]!, positional[1]!, { title: flags.title, create: flags.new === 'true' }); break;
      case 'diff': if (positional.length === 2) return await diff(positional[0]!, positional[1]!); break;
      case 'push': if (positional.length === 2) {
        return await push(positional[0]!, positional[1]!, {
          databaseUrl: flags['database-url'] ?? process.env.MEMWISE_DATABASE_URL, testDatabaseUrl: flags['test-database-url'], by: flags.by,
        });
      } break;
      case 'convert': if (positional.length === 2) return await convert(positional[0]!, positional[1]!); break;
      case 'plugin':
        if (positional[0] === 'install' && positional.length === 3) return await pluginInstall(positional[1]!, positional[2]!);
        if (positional[0] === 'list' && positional.length === 2) return await pluginList(positional[1]!);
        break;
      case 'bind': if (positional.length === 2) return await bind(positional[0]!, positional[1]!, { draft: flags.draft === 'true' }); break;
      case 'audit': if (positional[0] === 'verify') {
        const code = await auditVerify(positional[1], { key: flags.key, project: flags.project, databaseUrl: flags['database-url'] ?? process.env.MEMWISE_DATABASE_URL });
        if (code !== 2) return code;
      } break;
      case 'validation-report': if (positional[0]) {
        return await validationReport(positional[0], { out: flags.out, databaseUrl: flags['database-url'] ?? process.env.MEMWISE_TEST_DATABASE_URL });
      } break;
    }
  } catch (e) {
    // Plain-words errors from the file layer (no such draft, a non-empty folder ...) without a stack.
    console.error(`memwise ${cmd}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
