#!/usr/bin/env bun
// The `memwise` CLI (Phase 1): check a project, run its example cases, show a step record,
// show a step's effective policy.
import { createPool, PgStepRecordReader } from '@memwise/db';
import { checkProject, loadProject, type Diagnostic, type ProjectDefs, type StepRecordReader } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import { compilePolicy, describePolicy, layersFor, violationsToDiagnostics } from '@memwise/policy';
import { recallTools } from '@memwise/step-engine';
import { runExample, type ExampleResult } from './examples.ts';
import { sampleTools } from './sample-tools.ts';

const USAGE = `usage:
  memwise check <project>
  memwise test <project> [--example <name>] [--database-url <admin-url>]
  memwise record <step-run-id> --database-url <url>
  memwise policy <project> <workflow> <step>`;

/** The tools a project is checked against in Phase 1: the sample set and the recall tools. */
function boundTools(): ToolDefinition[] {
  const noReader = {} as StepRecordReader; // only names and classes are read, never executed
  return [...sampleTools(), ...recallTools(noReader)];
}

async function load(dir: string): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[] }> {
  return loadProject(dir);
}

function printDiagnostics(diagnostics: Diagnostic[]) {
  for (const d of diagnostics) {
    const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(project)';
    console.log(`${where}  ${d.severity}  ${d.code}  ${d.message}${d.path && !d.line ? ` (${d.path})` : ''}`);
  }
}

async function check(dir: string): Promise<number> {
  const { project, diagnostics } = await load(dir);
  const tools = Object.fromEntries(boundTools().map((t) => [t.name, { effect: typeof t.effect === 'string' ? t.effect : undefined }]));
  const all = [...diagnostics, ...checkProject(project, { tools })];
  // Policy tightening, per step (the workflow layer is checked as part of each step's stack).
  const seen = new Set<string>();
  for (const workflow of Object.values(project.workflows)) {
    for (const step of [undefined, ...Object.values(workflow.steps)]) {
      const { violations } = compilePolicy(layersFor({ domainPolicy: project.domainPolicy, workflow, step }));
      for (const d of violationsToDiagnostics(violations)) {
        const key = `${d.file}|${d.path}|${d.message}`;
        if (!seen.has(key)) { seen.add(key); all.push(d); }
      }
    }
  }
  printDiagnostics(all);
  const errors = all.filter((d) => d.severity === 'error').length;
  console.log(`${errors} error(s), ${all.length - errors} warning(s)`);
  return errors ? 1 : 0;
}

async function test(dir: string, opts: { example?: string; databaseUrl?: string }): Promise<number> {
  const { project, diagnostics } = await load(dir);
  const loadErrors = diagnostics.filter((d) => d.severity === 'error');
  if (loadErrors.length) { printDiagnostics(loadErrors); return 1; }
  const results: ExampleResult[] = [];
  for (const workflow of Object.values(project.workflows)) {
    for (const example of workflow.examples) {
      if (opts.example && example.name !== opts.example) continue;
      const r = await runExample(project, workflow, example, { adminUrl: opts.databaseUrl });
      results.push(r);
      const name = `${r.workflow}/${r.example}`;
      if (r.status === 'skip') console.log(`SKIP ${name}: ${r.reason}`);
      else {
        console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${name}`);
        for (const d of r.differences) console.log(`     ${d}`);
      }
    }
  }
  if (opts.example && !results.length) { console.log(`no example named ${opts.example}`); return 1; }
  const count = (s: ExampleResult['status']) => results.filter((r) => r.status === s).length;
  console.log(`${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
  return count('fail') ? 1 : 0;
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
  const { project } = await load(dir);
  const workflow = project.workflows[workflowId];
  if (!workflow) { console.log(`no workflow ${workflowId}`); return 1; }
  const step = workflow.steps[stepId];
  if (!step) { console.log(`workflow ${workflowId} has no step ${stepId}`); return 1; }
  const { effective, violations } = compilePolicy(layersFor({ domainPolicy: project.domainPolicy, workflow, step }));
  console.log(describePolicy(effective));
  if (violations.length) {
    console.log('\nviolations:');
    printDiagnostics(violationsToDiagnostics(violations));
  }
  return violations.length ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) flags[a.slice(2)] = rest[++i] ?? '';
    else positional.push(a);
  }
  switch (cmd) {
    case 'check': if (positional[0]) return check(positional[0]); break;
    case 'test': if (positional[0]) return test(positional[0], { example: flags.example, databaseUrl: flags['database-url'] }); break;
    case 'record': {
      const url = flags['database-url'] ?? process.env.MEMWISE_DATABASE_URL;
      if (positional[0] && url) return record(positional[0], url);
      break;
    }
    case 'policy': if (positional.length === 3) return policy(positional[0]!, positional[1]!, positional[2]!); break;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
