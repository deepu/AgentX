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
 * steps don't write. A Ref only when no step writes it (Phase 6: the record the case is about);
 * otherwise a link to a record is made by a step, not typed in.
 */
export function startFields(workflow: WorkflowDef): string[] {
  const machineWritten = new Set<string>();
  const personWritten = new Set<string>();
  for (const step of Object.values(workflow.steps)) {
    const target = step.performer === 'agent' || step.performer === 'system' ? machineWritten : personWritten;
    for (const field of Object.keys(step.writes)) target.add(field);
  }
  // Phase 6 (24 §6, §7): a single Ref no step writes is the record the case is about, given by
  // whoever starts it from that record (the record page's `start`, a trigger, an example case).
  const about = (name: string, t: ValueType) => t.kind === 'ref' && !machineWritten.has(name) && !personWritten.has(name);
  return Object.entries(workflow.caseType.fields)
    .filter(([name, f]) => ((personWritten.size ? personWritten.has(name) : !machineWritten.has(name)) && !isRef(f.type)) || about(name, f.type))
    .map(([name]) => name);
}

/**
 * Problems with a case's starting values, field -> problems; empty when they are fine. Every
 * value must be a case field of its type. Started at the workflow's `start`, only `startFields`;
 * a later `startAt` (example cases, tests) may set any field, as earlier steps would have.
 * `anyField`: the kernel itself starting a case (a change run with its draft, Phase 3) may set
 * any field too; what people enter is never widened by it.
 */
export function startValueErrors(
  workflow: WorkflowDef, values: Record<string, unknown>, records: RecordTypes, startAt?: string, opts: { anyField?: boolean } = {},
): Record<string, string[]> {
  const fields = workflow.caseType.fields;
  const atStart = (startAt ?? workflow.start) === workflow.start && !opts.anyField;
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
