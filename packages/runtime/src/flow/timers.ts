// Entity state timers (24 §4): a lifecycle state's `after:` entries, armed when a record enters
// the state (the `timers` consumer) and cancelled when it leaves. A due timer reminds a role
// ("Reminder: US-012 · Harbor Oncology has been activating for 60 days") or makes a transition
// as the system actor.
import type { EntityEvent, EntityTypeDef } from '@memwise/defs';
import type { FlowDeps } from './context.ts';
import { durationWords, words } from './describe.ts';
import type { EventConsumer } from './dispatcher.ts';
import { recordRef } from './records.ts';

const BATCH = 50;

interface TimerAction { afterMs: number; remind?: string; transition?: string }

export function createEntityTimers(deps: FlowDeps) {
  const { pool } = deps;

  async function arm(event: EntityEvent, def: EntityTypeDef, state: string) {
    const after = def.lifecycleChart?.states[state]?.after ?? [];
    for (const [i, a] of after.entries()) {
      await pool.query(
        `insert into mw.entity_timers (id, entity, record_id, state, entered_event, fire_at, action)
         values ($1, $2, $3, $4, $5, $6::timestamptz + make_interval(secs => $7::float8 / 1000), $8) on conflict (id) do nothing`,
        [`${event.id}:${i}`, event.entity, event.recordId, state, event.id, event.at, a.afterMs, JSON.stringify(a)]);
    }
  }

  const consumer: EventConsumer = {
    name: 'timers',
    async handle(event) {
      const def = deps.entities()[event.entity];
      if (!def?.lifecycleChart) return;
      // A new record also enters its first state (the storage writes `entered` with `created`).
      if (event.kind === 'entered' && event.state) {
        // Leaving a state cancels its timers; this event's own (a replay) stay.
        await pool.query(
          `update mw.entity_timers set status = 'cancelled' where entity = $1 and record_id = $2 and status = 'pending' and entered_event <> $3`,
          [event.entity, event.recordId, event.id]);
        await arm(event, def, event.state);
      }
    },
  };

  async function fireOne(t: any): Promise<void> {
    const def = deps.entities()[t.entity] as EntityTypeDef | undefined;
    const action = t.action as TimerAction;
    let status = 'fired';
    let message: string | undefined;
    if (action.remind) {
      const record = def ? await recordRef(pool, def, t.entity, t.record_id) : undefined;
      const title = record?.title ?? t.record_id;
      await pool.query(
        `insert into mw.notifications (id, run_id, role, kind, text, entity, record_id) values ($1, null, $2, 'reminder', $3, $4, $5)
         on conflict (id) do nothing`,
        [`entity-timer:${t.id}`, action.remind, `Reminder: ${title} has been ${words(t.state)} for ${durationWords(action.afterMs)}`, t.entity, t.record_id]);
    } else if (action.transition) {
      const r = await deps.transition({
        entity: t.entity, id: t.record_id, transition: action.transition,
        reason: `${durationWords(action.afterMs)} in ${words(t.state)}`,
      });
      if (!r.applied) { status = 'failed'; message = r.message ?? r.status; }
    }
    await pool.query(`update mw.entity_timers set status = $2, message = $3 where id = $1 and status = 'pending'`, [t.id, status, message ?? null]);
  }

  return {
    consumer,
    /** Fire the timers due at `now`; true when it fired any. */
    async fireDue(now = new Date()): Promise<boolean> {
      const { rows } = await pool.query(
        `select * from mw.entity_timers where status = 'pending' and fire_at <= $1 order by fire_at, id limit $2`, [now, BATCH]);
      for (const t of rows) {
        try {
          await fireOne(t);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          deps.log?.(`entity timer ${t.id}: ${message}`);
          await pool.query(`update mw.entity_timers set status = 'failed', message = $2 where id = $1 and status = 'pending'`, [t.id, message]);
        }
      }
      return rows.length > 0;
    },
  };
}
