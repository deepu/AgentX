// The validation pack's report (24 §9): every workflow's example cases run as `memwise test`
// runs them, and the result written as Markdown for a regulated customer's validation file: the
// engine version, each workflow's version and hash, each example's result and the checks.
import type { Diagnostic, ProjectDefs } from '@memwise/defs';
import type { ExampleResult } from '../examples.ts';

export interface ValidationReportInput {
  project: ProjectDefs;
  /** What `memwise check` reports (load, checks and policy). */
  diagnostics: Diagnostic[];
  results: ExampleResult[];
  engineVersion: string;
  /** The MemWise release, when known. */
  release?: string;
  at: Date;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderValidationReport(r: ValidationReportInput): string {
  const { project } = r;
  const count = (s: ExampleResult['status']) => r.results.filter((x) => x.status === s).length;
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  const workspace = project.workspace?.name ?? project.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'project';
  const regulated = Object.values(project.domains ?? {}).filter((d) => d.regulated).map((d) => d.name);
  const passed = !errors.length && !count('fail');
  const out: string[] = [
    `# Validation report: ${workspace}`,
    '',
    `- **Date:** ${r.at.toISOString()}`,
    `- **Engine:** ${r.engineVersion}${r.release ? ` (MemWise ${r.release})` : ''}`,
    `- **Regulated domains:** ${regulated.length ? regulated.join(', ') : 'none'}`,
    `- **Result:** ${passed ? 'PASSED' : 'FAILED'}: ${count('pass')} example(s) passed, ${count('fail')} failed, ${count('skip')} skipped; ${errors.length} check error(s), ${r.diagnostics.length - errors.length} warning(s)`,
    '',
    '## Playbooks',
    '',
    '| Playbook | Domain | Version | Hash | Examples |',
    '|---|---|---|---|---|',
  ];
  const workflows = Object.values(project.workflows).sort((a, b) => a.id.localeCompare(b.id));
  for (const wf of workflows) {
    const mine = r.results.filter((x) => x.workflow === wf.id);
    const summary = mine.length ? `${mine.filter((x) => x.status === 'pass').length}/${mine.length} passed` : 'none';
    out.push(`| ${cell(wf.title ?? wf.id)} (\`${wf.id}\`) | ${cell(project.domains?.[wf.domain ?? 'domain']?.name ?? wf.domain ?? 'domain')} | ${wf.version} | \`${wf.hash}\` | ${summary} |`);
  }
  out.push('', '## Example cases', '');
  if (!r.results.length) out.push('No example cases.');
  for (const x of r.results) {
    const mark = x.status === 'pass' ? 'PASS' : x.status === 'fail' ? 'FAIL' : 'SKIP';
    out.push(`- **${mark}** \`${x.workflow}/${x.example}\``);
    if (x.status === 'skip') out.push(`  - skipped: ${x.reason}`);
    else for (const d of x.differences) out.push(`  - ${d}`);
    if (x.status !== 'skip' && x.run) out.push(`  - ended in \`${x.run.state}\` (${x.run.status})`);
  }
  out.push('', '## Checks', '');
  if (!r.diagnostics.length) out.push('No problems found.');
  else {
    out.push('| Severity | Code | Where | Message |', '|---|---|---|---|');
    for (const d of r.diagnostics) {
      out.push(`| ${d.severity} | ${d.code} | ${cell(d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '(project)')} | ${cell(d.message)} |`);
    }
  }
  out.push('');
  return out.join('\n');
}
