// The flow piece, wired: one dispatcher per kernel with its consumers (24 §7), triggers, the
// hand-off outbox (§8), incoming email (§10) and entity state timers (§4), plus the minute sweep.
import type { InboundEvent } from '@memwise/defs';
import type { TriggersService } from '../types.ts';
import type { FlowDeps } from './context.ts';
import { Dispatcher, type EventConsumer } from './dispatcher.ts';
import { createHandoffs } from './handoffs.ts';
import { emailInbound } from './messages.ts';
import { createEntityTimers } from './timers.ts';
import { createTriggers } from './triggers.ts';

export { queueHandoffs } from './handoffs.ts';
export { emailPurpose } from './messages.ts';
export type { EventConsumer } from './dispatcher.ts';
export type { FlowDeps } from './context.ts';

export const MINUTE_MS = 60_000;

export interface Flow {
  triggers: TriggersService;
  dispatcher: Dispatcher;
  handoffs: ReturnType<typeof createHandoffs>;
  /** For kernel.channels.onInbound. */
  onInbound(event: InboundEvent): void;
  /** Start the loops (dispatcher wake-ups, the minute sweep) and catch up once. */
  start(): void;
  stop(): Promise<void>;
}

/**
 * `consumers`: the records piece's (link pairing, invariants), called first for each event; then
 * the flow's own: waits, timers, triggers.
 */
export function createFlow(deps: FlowDeps, consumers: () => EventConsumer[] = () => []): Flow {
  const handoffs = createHandoffs(deps);
  const timers = createEntityTimers(deps);
  let triggers: ReturnType<typeof createTriggers>;
  const email = emailInbound(deps, (domain, body) => triggers.receiveMessage(domain, body));
  const dispatcher = new Dispatcher({
    pool: deps.pool,
    consumers: () => [...consumers(), handoffs.waits, timers.consumer, triggers.consumer],
    async work() {
      const a = await handoffs.work();
      const b = await email.sweep();
      const c = await timers.fireDue();
      return a || b || c;
    },
    pendingWork: () => handoffs.pending(),
    ...(deps.log ? { log: deps.log } : {}),
  });
  triggers = createTriggers(deps, { settle: (timeoutMs) => dispatcher.settle(timeoutMs) });

  let minute: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<unknown> | undefined;
  const sweep = () => {
    if (sweeping) return;
    sweeping = triggers.sweep()
      .then(() => timers.fireDue())
      .catch((e) => deps.log?.(`sweep: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { sweeping = undefined; dispatcher.wake(); });
  };

  return {
    triggers,
    dispatcher,
    handoffs,
    onInbound(event) {
      void email.onInbound(event).then(() => dispatcher.wake(), (e) => deps.log?.(`inbound email ${event.id}: ${e instanceof Error ? e.message : String(e)}`));
    },
    start() {
      dispatcher.start();
      if (!minute) {
        minute = setInterval(sweep, MINUTE_MS);
        (minute as { unref?: () => void }).unref?.();
        sweep(); // catch up once on start
      }
    },
    async stop() {
      if (minute) clearInterval(minute);
      minute = undefined;
      await sweeping?.catch(() => {});
      await dispatcher.stop();
    },
  };
}
