import { describe, expect, test } from 'bun:test';
import { initialTransition, transition } from 'xstate';
import { outsideEventRefusal } from '../src/driver.ts';
import { answeredBySubmit, compileMachine, metaOf, stateKind } from '../src/machine.ts';
import { intakeShape, step, timerShape, workflow } from './fixtures/workflows.ts';

describe('compileMachine', () => {
  const machine = compileMachine(intakeShape);

  test('one state per StateDef plus a final end', () => {
    expect(Object.keys(machine.states).sort()).toEqual(['check', 'end', 'fill', 'needs_person', 'onboard', 'verify']);
    expect(machine.states.end!.type).toBe('final');
  });

  test('state kinds and metadata', () => {
    expect(stateKind(intakeShape, 'fill')).toBe('external-step');
    expect(stateKind(intakeShape, 'check')).toBe('agent-step');
    expect(stateKind(intakeShape, 'verify')).toBe('person-step');
    expect(stateKind(intakeShape, 'onboard')).toBe('system-step');
    expect(stateKind(intakeShape, 'needs_person')).toBe('wait');
    expect(stateKind(intakeShape, 'end')).toBe('final');
    expect(metaOf(machine, 'check')).toMatchObject({ kind: 'agent-step', step: 'check', performer: 'agent' });
    expect(metaOf(machine, 'fill').wait?.timeout?.target).toBe('needs_person');
  });

  test('an agent step on the open engine is a conversation step, answered like a person step', () => {
    const chat = workflow('chat-test', 'talk', { talk: { on: { drafted: 'end' }, step: 'talk' }, think: { on: { done: 'end' }, step: 'think' } }, [
      step('talk', 'agent', { engine: 'open', strictness: 'open', assignee: 'staff', outcomes: ['drafted'] }),
      step('think', 'agent', { engine: 'step', model: 'checker', outcomes: ['done'] }),
    ]);
    expect(stateKind(chat, 'talk')).toBe('conversation-step');
    expect(stateKind(chat, 'think')).toBe('agent-step');
    expect(answeredBySubmit('conversation-step')).toBe(true);
    expect(answeredBySubmit('agent-step')).toBe(false);
    expect(outsideEventRefusal(chat, 'talk')).toMatchObject({ reason: 'use_submit' });
    expect(outsideEventRefusal(chat, 'think')).toBeUndefined();
  });

  test('transitions follow `on`, the loop back to fill re-arms its timers', () => {
    const atCheck = compileMachine(intakeShape, 'check');
    const [s0] = initialTransition(atCheck);
    expect(s0.value).toBe('check');
    const [s1, actions] = transition(machine, machine.resolveState({ value: 'check', context: {} }), { type: 'needs_info' });
    expect(s1.value).toBe('fill');
    const raises = actions.filter((a: any) => a.type === 'xstate.raise').map((a: any) => [a.params.id, a.params.delay, a.params.event.type]);
    expect(raises).toEqual(expect.arrayContaining([
      ['remind.fill', 3 * 86400000, 'remind'],
      [expect.stringContaining('xstate.after.604800000'), 604800000, expect.stringContaining('xstate.after')],
    ]));
    const [s2, exit] = transition(machine, s1, { type: 'submitted' });
    expect(s2.value).toBe('check');
    expect(exit.filter((a: any) => a.type === 'xstate.cancel').length).toBe(2);
  });

  test('unhandled events do not move', () => {
    const s = machine.resolveState({ value: 'fill', context: {} });
    expect(s.can({ type: 'checked' })).toBe(false);
    expect(s.can({ type: 'submitted' })).toBe(true);
  });

  test('the timeout event targets needs_person and end is final', () => {
    const m = compileMachine(timerShape);
    const [s0, actions] = initialTransition(m);
    const timeout = actions.find((a: any) => a.type === 'xstate.raise' && a.params.delay === 2000) as any;
    const [s1] = transition(m, s0, timeout.params.event);
    expect(s1.value).toBe('needs_person');
    const [s2] = transition(m, s1, { type: 'resolved' });
    expect(s2.status).toBe('done');
  });
});
