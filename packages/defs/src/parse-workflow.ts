/** `workflow.yaml` (the shape) and `examples/*.yaml` (example cases). */
import { basename } from 'node:path';
import { exampleFormat, TIMEOUT_PATTERN, workflowFormat } from './formats.ts';
import { asRecord, asString, compact, isRecord, readYaml, rememberLocator, Reporter, type ParseResult } from './source.ts';
import { END_STATE, type ExampleCase, type ExampleSubmission, type ScriptedTurn, type StateDef, type WaitDef } from './types.ts';
import { parseDuration } from './value-types.ts';
import type { TriggerDef } from './domain-types.ts';
import { parseBlock, parseTriggers } from './parse-handoffs.ts';

/** What `workflow.yaml` holds on its own; `loadWorkflow` adds steps, case type, policy and examples. */
export interface WorkflowShape {
  id: string;
  version: number;
  title?: string;
  owner?: string;
  start: string;
  /** States without `step` set; the loader sets it from the step files. */
  states: Record<string, StateDef>;
  /** Path of the case type, relative to workflow.yaml (default `./case.yaml`). */
  case?: string;
  /** Path of the workflow policy layer, relative to workflow.yaml. */
  policy?: string;
  /** Phase 4: `forked_from: <plugin>@<version>`, a playbook copied from a plugin workflow and edited here. */
  forkedFrom?: string;
  /** Phase 6: `starts_on:` (24 §7). */
  startsOn?: TriggerDef[];
}

export function parseWorkflowFile(text: string, file: string): ParseResult<WorkflowShape> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected a workflow: workflow, version, start, steps');
    return { diagnostics: report.diagnostics };
  }
  report.validate(workflowFormat, src.data);
  const data = src.data;

  const states: Record<string, StateDef> = {};
  for (const [name, spec] of Object.entries(asRecord(data.steps))) {
    if (name === END_STATE) {
      report.error('reserved-state', `\`${END_STATE}\` is the built-in final state and can't be declared`, ['steps', name]);
      continue;
    }
    const s = asRecord(spec);
    const on = Object.fromEntries(Object.entries(asRecord(s.on)).filter(([, t]) => typeof t === 'string')) as Record<string, string>;
    let wait: WaitDef | undefined;
    if (isRecord(s.wait)) {
      const w = s.wait;
      const remindMs = typeof w.remind === 'string' || typeof w.remind === 'number' ? parseDuration(w.remind) : undefined;
      let timeout: WaitDef['timeout'];
      const m = typeof w.timeout === 'string' ? new RegExp(TIMEOUT_PATTERN).exec(w.timeout) : null;
      if (m) {
        const afterMs = parseDuration(m[1]!);
        if (afterMs === undefined) report.error('invalid-format', `\`${m[1]}\` is not a duration: expected something like 30s, 10m, 3d or 1h30m`, ['steps', name, 'wait', 'timeout']);
        else timeout = { afterMs, target: m[3]! };
      }
      wait = compact({ remindMs, timeout });
    }
    states[name] = compact({ name, on, wait, assignee: asString(s.assignee), block: parseBlock(name, s, report) });
  }

  const value: WorkflowShape = compact({
    id: asString(data.workflow) ?? '',
    version: typeof data.version === 'number' ? data.version : 1,
    title: asString(data.title),
    owner: asString(data.owner),
    start: asString(data.start) ?? '',
    states,
    case: asString(data.case),
    policy: asString(data.policy),
    forkedFrom: asString(data.forked_from),
    startsOn: parseTriggers(data.starts_on, report),
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

export function parseExampleFile(text: string, file: string): ParseResult<ExampleCase> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected an example case: name, case, expect');
    return { diagnostics: report.diagnostics };
  }
  report.validate(exampleFormat, src.data);
  const data = src.data;

  let model: ExampleCase['model'];
  if (isRecord(data.model)) {
    model = {};
    for (const [role, turns] of Object.entries(data.model)) {
      model[role] = (Array.isArray(turns) ? turns : []).filter(isRecord).map((t): ScriptedTurn => compact({
        text: asString(t.text),
        toolCalls: Array.isArray(t.toolCalls)
          ? t.toolCalls.filter(isRecord).map((c) => ({ name: asString(c.name) ?? '', args: asRecord(c.args) }))
          : undefined,
      }));
    }
  }
  let submit: ExampleCase['submit'];
  if (isRecord(data.submit)) {
    const one = (v: unknown): ExampleSubmission | undefined => isRecord(v) && typeof v.outcome === 'string'
      ? compact({ outcome: v.outcome, values: isRecord(v.values) ? v.values : undefined, comment: asString(v.comment) })
      : undefined;
    submit = {};
    for (const [state, answer] of Object.entries(data.submit)) {
      const parsed = Array.isArray(answer) ? answer.map(one).filter((a): a is ExampleSubmission => !!a) : one(answer);
      if (parsed) submit[state] = parsed;
    }
  }
  const expect = asRecord(data.expect);
  let entities: ExampleCase['expect']['entities'];
  if (isRecord(expect.entities)) {
    entities = {};
    for (const [entity, want] of Object.entries(expect.entities)) {
      if (typeof want === 'number') entities[entity] = want;
      else if (Array.isArray(want)) entities[entity] = want.filter(isRecord);
    }
  }
  const value: ExampleCase = compact({
    name: asString(data.name) ?? basename(file).replace(/\.ya?ml$/, ''),
    description: asString(data.description),
    startAt: asString(data.startAt),
    case: asRecord(data.case),
    tools: isRecord(data.tools) ? data.tools : undefined,
    model,
    records: isRecord(data.records)
      ? Object.fromEntries(Object.entries(data.records).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter(isRecord)]))
      : undefined,
    approvals: isRecord(data.approvals)
      ? Object.fromEntries(Object.entries(data.approvals).filter(([, v]) => v === 'approve' || v === 'reject')) as ExampleCase['approvals']
      : undefined,
    submit,
    expect: compact({
      outcome: asString(expect.outcome),
      state: asString(expect.state),
      writes: isRecord(expect.writes) ? expect.writes : undefined,
      effects: isRecord(expect.effects)
        ? Object.fromEntries(Object.entries(expect.effects).filter(([, v]) => typeof v === 'number')) as Record<string, number>
        : undefined,
      entities,
    }),
    file,
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}
