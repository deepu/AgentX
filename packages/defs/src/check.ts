/**
 * The checks a workflow must pass before it can go live (05 §8), apart from policy
 * tightening (`@memwise/policy`) and running the example cases (`memwise test`).
 *
 * Codes are stable; tools and editors key on them.
 */
import { shapeFileOf } from './load.ts';
import { lineOf, type PathKey } from './source.ts';
import { END_STATE, type CheckEnvironment, type Diagnostic, type EntityTypeDef, type FieldDef, type ProjectDefs, type Severity, type StepDef, type ValueType, type WorkflowDef } from './types.ts';
import { sameValueType } from './value-types.ts';
import { validateValue, type RecordTypes } from './values.ts';

/** Outcomes every step may take without declaring them; the run stops for a person when the shape has no transition. */
export const BUILTIN_OUTCOMES = ['needs_person', 'failed'] as const;
/** Tools the step engine provides itself; example cases script calls to them. */
export const ENGINE_TOOLS = ['step.finish', 'checkpoint.verdict'] as const;

export interface CheckOptions {
  /** Entity types of the project. Without them, `Ref<>` targets and entity-named types aren't checked. */
  entities?: Record<string, EntityTypeDef>;
}

class Diagnostics {
  readonly list: Diagnostic[] = [];
  /** `def` is the parsed object the path belongs to, for its line (when it was loaded in this process). */
  add(severity: Severity, code: string, message: string, file: string, def: object, path: PathKey[]): void {
    this.list.push({ severity, code, message, file, line: lineOf(def, path), ...(path.length ? { path: path.join('.') } : {}) });
  }
}

/** Walks a type down to the named and referenced types inside it. */
function typeNames(type: ValueType): ValueType[] {
  return type.kind === 'list' ? typeNames(type.of) : type.kind === 'named' || type.kind === 'ref' ? [type] : [];
}

/** Checks that record and entity types named in `type` exist. */
function checkTypeRefs(
  type: ValueType, records: Record<string, unknown>, entities: Record<string, EntityTypeDef> | undefined,
  report: (code: string, message: string) => void,
): void {
  for (const t of typeNames(type)) {
    if (t.kind === 'ref') {
      if (entities && !entities[t.entity]) report('unknown-entity', `\`Ref<${t.entity}>\`: there is no entity type ${t.entity}`);
    } else if (t.kind === 'named' && !records[t.name] && entities && !entities[t.name]) {
      // Without the project's entities the name might still be an entity type, so only say so when we know.
      report('unknown-type', `\`${t.name}\` is not a record type in the case file or an entity type`);
    }
  }
}

export function checkWorkflow(workflow: WorkflowDef, env: CheckEnvironment, opts: CheckOptions = {}): Diagnostic[] {
  const d = new Diagnostics();
  const shapeFile = shapeFileOf(workflow);
  const shape = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, shapeFile, workflow, path);
  const { states, caseType } = workflow;
  const entities = opts.entities;
  const exists = (target: string) => target === END_STATE || target in states;

  // ---- the shape: start, targets, reachability, exits, waits
  if (!states[workflow.start]) shape('error', 'unknown-start', `the start state \`${workflow.start}\` is not one of the steps`, ['start']);

  for (const [name, state] of Object.entries(states)) {
    for (const [event, target] of Object.entries(state.on)) {
      if (!exists(target)) shape('error', 'unknown-target', `\`${name}\` goes to \`${target}\` on ${event}, but there is no such state`, ['steps', name, 'on', event]);
    }
    const timeout = state.wait?.timeout;
    if (timeout && !exists(timeout.target)) shape('error', 'unknown-target', `\`${name}\` times out to \`${timeout.target}\`, but there is no such state`, ['steps', name, 'wait', 'timeout']);
    if (!Object.keys(state.on).length && !timeout) shape('error', 'no-exit', `\`${name}\` has no way out: add transitions under \`on\` or a timeout`, ['steps', name]);

    const step = state.step ? workflow.steps[state.step] : undefined;
    const waits = !step || step.performer === 'person' || step.performer === 'external';
    if (waits && !timeout) {
      const who = step ? `waits for a ${step.performer === 'person' ? 'person' : 'participant outside the business'}` : 'waits for an outside event (it has no step file)';
      shape('warning', 'wait-without-timeout', `\`${name}\` ${who} but has no timeout: add \`wait: { timeout: 7d → needs_person }\` so it can't stall`, ['steps', name]);
    }
  }

  if (states[workflow.start]) {
    const seen = new Set([workflow.start]);
    const queue = [workflow.start];
    while (queue.length) {
      const s = states[queue.shift()!]!;
      for (const t of [...Object.values(s.on), ...(s.wait?.timeout ? [s.wait.timeout.target] : [])]) {
        if (states[t] && !seen.has(t)) { seen.add(t); queue.push(t); }
      }
    }
    for (const name of Object.keys(states)) {
      if (!seen.has(name)) shape('error', 'unreachable-state', `\`${name}\` can't be reached from \`${workflow.start}\``, ['steps', name]);
    }
  }

  // ---- the case type: every named type resolves
  const records = caseType.types;
  const checkFields = (fields: Record<string, FieldDef>, path: PathKey[]) => {
    for (const [name, field] of Object.entries(fields)) {
      checkTypeRefs(field.type, records, entities, (code, message) =>
        d.add('error', code, `${name}: ${message}`, caseType.file, caseType, [...path, name]));
    }
  };
  checkFields(caseType.fields, ['fields']);
  for (const [name, rec] of Object.entries(records)) checkFields(rec.fields, ['types', name]);

  // ---- steps
  for (const [name, state] of Object.entries(states)) {
    const step = state.step ? workflow.steps[state.step] : undefined;
    if (step) checkStep(d, workflow, name, step, env, entities);
  }

  // ---- example cases
  checkExamples(d, workflow, env, entities);
  return d.list;
}

/** Resolves `case.a.b` through record and entity types; returns the first segment that doesn't exist. */
function unknownReadSegment(path: string, workflow: WorkflowDef, entities?: Record<string, EntityTypeDef>): string | undefined {
  const [head, ...rest] = path.split('.').slice(1);
  let field = workflow.caseType.fields[head!];
  if (!field) return head;
  for (const seg of rest) {
    const t: ValueType = field.type;
    const fields: Record<string, FieldDef> | undefined = t.kind === 'named'
      ? (workflow.caseType.types[t.name]?.fields ?? entities?.[t.name]?.fields)
      : t.kind === 'ref' ? entities?.[t.entity]?.fields : undefined;
    // Lists, scalars and types we can't see into: the rest of the path is the tool's business.
    if (!fields) return undefined;
    if (t.kind === 'ref' && entities?.[t.entity]?.relationships[seg]) return undefined;
    field = fields[seg];
    if (!field) return seg;
  }
  return undefined;
}

function checkStep(d: Diagnostics, workflow: WorkflowDef, stateName: string, step: StepDef, env: CheckEnvironment, entities?: Record<string, EntityTypeDef>): void {
  const at = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, step.file, step, path);
  const shape = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, shapeFileOf(workflow), workflow, path);
  const state = workflow.states[stateName]!;
  const caseFields = workflow.caseType.fields;

  if (step.performer === 'agent') {
    if (!step.model) at('error', 'missing-model-role', 'an agent step names a model role, e.g. `model: checker`', []);
    if (!step.outcomes.length) at('error', 'no-outcomes', 'an agent step declares at least one outcome, e.g. `outcomes: [done]`', []);
  }
  if (step.performer === 'system') {
    at('warning', 'system-step-phase-2', 'system (mechanical) steps run from Phase 2; until then a run waits here', ['performer']);
  }

  for (const outcome of step.outcomes) {
    if (!(outcome in state.on)) shape('error', 'outcome-without-transition', `step \`${stateName}\` can finish with \`${outcome}\`, but the shape has no transition for it`, ['steps', stateName, 'on']);
  }
  for (const event of Object.keys(state.on)) {
    if (!step.outcomes.includes(event) && !(BUILTIN_OUTCOMES as readonly string[]).includes(event)) {
      shape('warning', 'unknown-outcome', `\`${event}\` is not an outcome of step \`${stateName}\` (it declares ${step.outcomes.join(', ') || 'none'})`, ['steps', stateName, 'on', event]);
    }
  }

  step.reads.forEach((read, i) => {
    if (!read.startsWith('case.')) return; // the format check already reported it
    const missing = unknownReadSegment(read, workflow, entities);
    if (missing) at('error', 'unknown-case-field', `\`${read}\`: \`${missing}\` is not a field of the case`, ['reads', i]);
  });

  const allowed = new Set(step.tools.allowed);
  for (const [field, write] of Object.entries(step.writes)) {
    const caseField = caseFields[field];
    if (!caseField) {
      at('error', 'unknown-case-field', `\`${field}\` is not a field of the case type \`${workflow.caseType.id}\``, ['writes', field]);
    } else if (!sameValueType(caseField.type, write.type)) {
      at('error', 'write-type-mismatch', `\`${field}\` is ${caseField.typeSource} in the case type but written as ${write.typeSource}`, ['writes', field]);
    }
    checkTypeRefs(write.type, workflow.caseType.types, entities, (code, message) => at('error', code, `${field}: ${message}`, ['writes', field]));
    if (write.from.kind === 'tool' && !allowed.has(write.from.tool)) {
      at('error', 'tool-not-allowed', `\`${field}\` comes from tool ${write.from.tool}, which is not in tools.allowed`, ['writes', field, 'from']);
    }
  }

  (['allowed', 'required'] as const).forEach((list) => step.tools[list].forEach((tool, i) => {
    if (!env.tools[tool]) at('error', 'unknown-tool', `tool ${tool} is not bound in the domain`, ['tools', list, i]);
    if (list === 'required' && !allowed.has(tool)) at('error', 'required-not-allowed', `required tool ${tool} must also be in tools.allowed`, ['tools', list, i]);
  }));
}

function checkExamples(d: Diagnostics, workflow: WorkflowDef, env: CheckEnvironment, entities?: Record<string, EntityTypeDef>): void {
  const records: RecordTypes = { ...entities, ...workflow.caseType.types };
  const fields = workflow.caseType.fields;
  const isTool = (name: string) => !!env.tools[name] || (ENGINE_TOOLS as readonly string[]).includes(name);

  for (const ex of workflow.examples) {
    const at = (code: string, message: string, path: PathKey[]) => d.add('error', code, `${ex.name}: ${message}`, ex.file, ex, path);

    if (ex.startAt !== undefined && !workflow.states[ex.startAt]) at('example-unknown-state', `startAt \`${ex.startAt}\` is not a state`, ['startAt']);
    const expectState = ex.expect.state;
    if (expectState !== undefined && expectState !== END_STATE && !workflow.states[expectState]) {
      at('example-unknown-state', `expect.state \`${expectState}\` is not a state`, ['expect', 'state']);
    }
    const startState = workflow.states[ex.startAt ?? workflow.start];
    const step = startState?.step ? workflow.steps[startState.step] : undefined;
    const outcome = ex.expect.outcome;
    if (outcome !== undefined && step && !step.outcomes.includes(outcome) && !(BUILTIN_OUTCOMES as readonly string[]).includes(outcome)) {
      at('example-unknown-outcome', `expect.outcome \`${outcome}\` is not an outcome of step \`${step.id}\``, ['expect', 'outcome']);
    }

    const values = (section: 'case' | 'writes', vals: Record<string, unknown> | undefined) => {
      const base: PathKey[] = section === 'case' ? ['case'] : ['expect', 'writes'];
      for (const [name, value] of Object.entries(vals ?? {})) {
        const field = fields[name];
        if (!field) { at('example-unknown-field', `\`${name}\` is not a field of the case`, [...base, name]); continue; }
        for (const err of validateValue(field.type, value, records)) at('example-invalid-value', `${name}${err.startsWith('[') ? '' : ': '}${err}`, [...base, name]);
      }
    };
    values('case', ex.case);
    values('writes', ex.expect.writes);

    const tools: [string, PathKey[]][] = [
      ...Object.keys(ex.tools ?? {}).map((t): [string, PathKey[]] => [t, ['tools', t]]),
      ...Object.keys(ex.approvals ?? {}).map((t): [string, PathKey[]] => [t, ['approvals', t]]),
      ...Object.keys(ex.expect.effects ?? {}).map((t): [string, PathKey[]] => [t, ['expect', 'effects', t]]),
      ...Object.entries(ex.model ?? {}).flatMap(([role, turns]) => turns.flatMap((turn, i) =>
        (turn.toolCalls ?? []).map((c, j): [string, PathKey[]] => [c.name, ['model', role, i, 'toolCalls', j]]))),
    ];
    const reported = new Set<string>();
    for (const [tool, path] of tools) {
      if (isTool(tool) || reported.has(tool)) continue;
      reported.add(tool);
      at('example-unknown-tool', `tool ${tool} is not bound in the domain`, path);
    }
  }
}

/** Entity types, then every workflow with the project's entities. */
export function checkProject(project: ProjectDefs, env: CheckEnvironment): Diagnostic[] {
  const d = new Diagnostics();
  const entities = project.entities;
  for (const entity of Object.values(entities)) {
    for (const [name, field] of Object.entries(entity.fields)) {
      checkTypeRefs(field.type, {}, entities, (code, message) => d.add('error', code, `${name}: ${message}`, entity.file, entity, ['fields', name]));
    }
    for (const [name, rel] of Object.entries(entity.relationships)) {
      if (!entities[rel.target]) d.add('error', 'unknown-entity', `${name}: there is no entity type ${rel.target}`, entity.file, entity, ['relationships', name]);
    }
  }
  const out = d.list;
  for (const workflow of Object.values(project.workflows)) out.push(...checkWorkflow(workflow, env, { entities }));
  return out;
}

