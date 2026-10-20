// The intake statechart. In MemWise this would be compiled from workflow.yaml;
// here it is written by hand in XState v5.
//
//   collect ──collected──▶ check ──checked──▶ approve ──approved──▶ done
//      ▲                     │                 │  │
//      └──────needs_info─────┘                 │  └─after approvalTimeout (3 days)──▶ escalated
//      └──────────────sent_back────────────────┘                                      │
//      └──────────────sent_back───────────────────────────────────────────────────────┘ (approved ─▶ done)
//
// `meta.step` names the DBOS step workflow run on entering the state.
// `meta.wait: true` marks a human wait: after its entry step the driver hibernates
// on DBOS.recv until an external event or the next timer deadline.
import { assign, setup } from 'xstate';

export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export type IntakeInput = { approvalTimeoutMs?: number };
export type IntakeContext = { attempts: number; approvalTimeoutMs: number; approvedBy?: string };
export type IntakeEvent =
  | { type: 'collected' }
  | { type: 'checked' }
  | { type: 'needs_info' }
  | { type: 'approved'; by?: string }
  | { type: 'sent_back'; by?: string; comment?: string }
  | { type: `xstate.after.${string}` };

export const intake = setup({
  types: {} as { context: IntakeContext; events: IntakeEvent; input: IntakeInput },
  // The timer duration is data, so tests can shrink "3 days" to seconds.
  delays: { approvalTimeout: ({ context }) => context.approvalTimeoutMs },
  actions: {
    countSendBack: assign({ attempts: ({ context }) => context.attempts + 1 }),
    recordApprover: assign({ approvedBy: ({ event }) => (event as { by?: string }).by }),
  },
}).createMachine({
  id: 'intake',
  initial: 'collect',
  context: ({ input }) => ({ attempts: 0, approvalTimeoutMs: input.approvalTimeoutMs ?? THREE_DAYS_MS }),
  states: {
    collect: { meta: { step: 'collect' }, on: { collected: 'check' } },
    check: { meta: { step: 'check' }, on: { checked: 'approve', needs_info: 'collect' } },
    approve: {
      meta: { step: 'request_approval', wait: true },
      after: { approvalTimeout: 'escalated' },
      on: {
        approved: { target: 'done', actions: 'recordApprover' },
        sent_back: { target: 'collect', actions: 'countSendBack' },
      },
    },
    escalated: {
      meta: { step: 'escalate', wait: true },
      on: {
        approved: { target: 'done', actions: 'recordApprover' },
        sent_back: { target: 'collect', actions: 'countSendBack' },
      },
    },
    done: { type: 'final' },
  },
});

export type StateMeta = { step?: string; wait?: boolean };

/** Meta of the (flat) active state. Nested/parallel states would return one entry per active leaf. */
export function metaOf(value: unknown): StateMeta {
  const node = intake.states[String(value) as keyof typeof intake.states];
  return (node?.meta as StateMeta) ?? {};
}
