// What a case may start with (kernel.startRun). The start dialog offers `startFields`, and
// startRun refuses anything else, so the two always agree.
import { validateValue, type RecordTypes, type ValueType, type WorkflowDef } from '@memwise/defs';

/** startRun's refusal: values that need fixing, field -> problems (as submitStep's `errors`). */
export class StartRunError extends Error {
  readonly status = 'invalid' as const;
  constructor(readonly errors: Record<string, string[]>) {
    super(`some values need fixing: ${Object.entries(errors).map(([f, e]) => `${f}: ${e.join('; ')}`).join(', ')}`);
    this.name = 'StartRunError';
  }
}

const isRef = (t: ValueType): boolean => t.kind === 'ref' || (t.kind === 'list' && isRef(t.of));

/**
 * Case fields a person enters when starting a case: those a person or external step writes (so
 * bookkeeping fields no step fills stay out); without such steps, every field agent and system
 * steps don't write. Never a Ref: a link to a record is made by a step, not typed in.
 */
export function startFields(workflow: WorkflowDef): string[] {
  const machineWritten = new Set<string>();
  const personWritten = new Set<string>();
  for (const step of Object.values(workflow.steps)) {
    const target = step.performer === 'agent' || step.performer === 'system' ? machineWritten : personWritten;
    for (const field of Object.keys(step.writes)) target.add(field);
  }
  return Object.entries(workflow.caseType.fields)
    .filter(([name, f]) => (personWritten.size ? personWritten.has(name) : !machineWritten.has(name)) && !isRef(f.type))
    .map(([name]) => name);
}

/**
 * Problems with a case's starting values, field -> problems; empty when they are fine. Every
 * value must be a case field of its type. Started at the workflow's `start`, only `startFields`;
 * a later `startAt` (example cases, tests) may set any field, as earlier steps would have.
 */
export function startValueErrors(workflow: WorkflowDef, values: Record<string, unknown>, records: RecordTypes, startAt?: string): Record<string, string[]> {
  const fields = workflow.caseType.fields;
  const atStart = (startAt ?? workflow.start) === workflow.start;
  const allowed = new Set(atStart ? startFields(workflow) : Object.keys(fields));
  const errors: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(values)) {
    const field = fields[name];
    if (!field) { errors[name] = ['not a field of this case']; continue; }
    if (!allowed.has(name)) { errors[name] = ['filled in by a step, not when the case starts']; continue; }
    if (value === null || value === undefined) continue;
    const errs = validateValue(field.type, value, records);
    if (errs.length) errors[name] = errs;
  }
  return errors;
}
