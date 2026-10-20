// Hand-built WorkflowDefs for tests that must not depend on the file loader.
import type { Performer, StateDef, StepDef, WorkflowDef } from '@memwise/defs';

export function step(id: string, performer: Performer, extra: Partial<StepDef> = {}): StepDef {
  return {
    id, title: id, performer, strictness: 'guided', reads: [], writes: {},
    tools: { allowed: [], required: [] }, checkpoint: [], outcomes: [], instructions: '',
    file: `steps/${id}.md`, hash: `hash-${id}`, ...extra,
  };
}

export function workflow(id: string, start: string, states: Record<string, Omit<StateDef, 'name'>>, steps: StepDef[], hash = `${id}-h1`): WorkflowDef {
  return {
    id, version: 1, start, dir: `workflows/${id}`, hash, examples: [],
    states: Object.fromEntries(Object.entries(states).map(([name, s]) => [name, { name, ...s }])),
    steps: Object.fromEntries(steps.map((s) => [s.id, s])),
    caseType: {
      id: `${id}_case`, file: 'case.yaml', hash: 'case-h',
      fields: {
        pan: { type: { kind: 'identifier', scheme: 'PAN' }, typeSource: 'Identifier(PAN)' },
        flags: { type: { kind: 'list', of: { kind: 'named', name: 'Flag' } }, typeSource: 'List<Flag>' },
      },
      types: { Flag: { name: 'Flag', fields: { field: { type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text' } } } },
    },
  };
}

const DAY = 24 * 3600 * 1000;

/** The intake shape (examples/intake/workflows/client-intake/workflow.yaml), by hand. */
export const intakeShape = workflow('client-intake', 'fill', {
  fill: { on: { submitted: 'check' }, wait: { remindMs: 3 * DAY, timeout: { afterMs: 7 * DAY, target: 'needs_person' } }, step: 'fill' },
  check: { on: { checked: 'verify', needs_info: 'fill', failed: 'needs_person', needs_person: 'needs_person' }, step: 'check' },
  verify: { on: { approved: 'onboard', sent_back: 'fill' }, wait: { remindMs: DAY, timeout: { afterMs: 3 * DAY, target: 'needs_person' } }, step: 'verify' },
  onboard: { on: { done: 'end' }, step: 'onboard' },
  needs_person: { on: { resolved: 'check' }, wait: { timeout: { afterMs: 7 * DAY, target: 'end' } } },
}, [
  step('fill', 'external', { outcomes: ['submitted'] }),
  step('check', 'agent', { outcomes: ['checked', 'needs_info', 'failed'], model: 'checker' }),
  step('verify', 'person', { outcomes: ['approved', 'sent_back'] }),
  step('onboard', 'system', { outcomes: ['done'] }),
]);

/** A tiny wait with a 2 s timeout, for timer tests. */
export const timerShape = workflow('timer-test', 'waiting', {
  waiting: { on: { answered: 'end' }, wait: { remindMs: 500, timeout: { afterMs: 2000, target: 'needs_person' } } },
  needs_person: { on: { resolved: 'end' } },
}, []);
