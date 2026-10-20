// workflow.yaml → an XState v5 machine. Only the subset spike S5 proved is emitted: flat
// states, `on` transitions, delayed transitions (`after`), delayed raises, and a final `end`.
// The machine is only ever used through the pure functions (initialTransition, transition);
// no actor runs, so `after` timers come back as `xstate.raise` actions that the run driver
// stores as rows in mw.timers (D39).
import { END_STATE, type Performer, type StateDef, type WaitDef, type WorkflowDef } from '@memwise/defs';
import { cancel, raise, setup, type AnyStateMachine } from 'xstate';

export type StateKind = 'agent-step' | 'person-step' | 'external-step' | 'system-step' | 'wait' | 'final';

/** Per-state metadata the driver reads (the spike's `metaOf`). */
export interface StateMeta {
  kind: StateKind;
  /** The step file's id (= the state name) when the state has one. */
  step?: string;
  performer?: Performer;
  wait?: WaitDef;
}

/** The reminder event a `wait.remind` raises; recorded, never moves the run (Phase 2 delivers it). */
export const REMIND_EVENT = 'remind';

export interface RunEvent { type: string; [key: string]: unknown }

const KIND_BY_PERFORMER: Record<Performer, StateKind> = {
  agent: 'agent-step', person: 'person-step', external: 'external-step', system: 'system-step',
};

export function stateKind(workflow: WorkflowDef, state: string): StateKind {
  if (state === END_STATE) return 'final';
  const def = workflow.states[state];
  if (!def) throw new Error(`workflow ${workflow.id} has no state "${state}"`);
  const step = workflow.steps[def.step ?? state];
  return step ? KIND_BY_PERFORMER[step.performer] : 'wait';
}

export function stateMeta(workflow: WorkflowDef, state: string): StateMeta {
  const kind = stateKind(workflow, state);
  if (kind === 'final') return { kind };
  const def = workflow.states[state]!;
  const step = workflow.steps[def.step ?? state];
  return { kind, step: step?.id, performer: step?.performer, wait: def.wait };
}

/** Timer id of a state's reminder (stable, so the exit can cancel it). */
export const remindTimerId = (state: string) => `remind.${state}`;

/**
 * Compile the shape. `initial` overrides `start` (example cases and `startRun({ startAt })`);
 * the states are identical either way, so a snapshot of one restores on the other.
 */
export function compileMachine(workflow: WorkflowDef, initial: string = workflow.start): AnyStateMachine {
  const states: Record<string, any> = {};
  for (const [name, def] of Object.entries(workflow.states)) states[name] = compileState(name, def, workflow);
  if (!states[END_STATE]) states[END_STATE] = { type: 'final', meta: { kind: 'final' } satisfies StateMeta };
  if (!states[initial]) throw new Error(`workflow ${workflow.id} has no state "${initial}"`);
  return setup({}).createMachine({ id: workflow.id, initial, states });
}

function compileState(name: string, def: StateDef, workflow: WorkflowDef) {
  // `reenter`: an outcome that targets its own state starts a fresh entry (new entered_seq,
  // so a new step run and fresh timers) instead of silently staying put.
  const on: Record<string, any> = {};
  for (const [event, target] of Object.entries(def.on)) on[event] = { target, reenter: true };
  const node: Record<string, any> = { on, meta: stateMeta(workflow, name) };
  if (def.wait?.timeout) {
    node.after = { [def.wait.timeout.afterMs]: { target: def.wait.timeout.target, reenter: true } };
  }
  if (def.wait?.remindMs) {
    const id = remindTimerId(name);
    node.entry = [raise({ type: REMIND_EVENT }, { delay: def.wait.remindMs, id })];
    node.exit = [cancel(id)];
  }
  return node;
}

/** Metadata of a (flat) state of a compiled machine. */
export function metaOf(machine: AnyStateMachine, state: string): StateMeta {
  const node = (machine.states as Record<string, { meta?: StateMeta }>)[state];
  if (!node?.meta) throw new Error(`machine ${machine.id} has no state "${state}"`);
  return node.meta;
}
