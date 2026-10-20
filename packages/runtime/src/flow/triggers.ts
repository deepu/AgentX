// Triggers (24 §7): what starts a workflow. Entity events (entered, created, changed) come from
// the dispatcher; date triggers and schedules from the minute sweep; messages from
// receiveMessage. Every firing has a key, and its run id is derived from the key, so a firing
// retried after a crash (an event delivered again, a sweep run twice) starts nothing new.
import { crashPoint, DEFAULT_DOMAIN, domainOf, hasRole, type EntityEvent, type InboundMessageBody, type TriggerDef, type WorkflowDef } from '@memwise/defs';
import { StartRunError } from '../start.ts';
import type { PersonActor, RecordRef, TriggerFiring, TriggerSummary, TriggersService } from '../types.ts';
import { derivedRunId, type FlowDeps } from './context.ts';
import { describeTrigger } from './describe.ts';
import type { EventConsumer } from './dispatcher.ts';
import { storeMessage } from './messages.ts';
import { columnOf, q, recordRef, tableOf } from './records.ts';
import { dueSlot, firstSlot } from './schedule.ts';
import { entityKeyFor, triggerValues, type TriggerSource } from './values.ts';

export const DEFAULT_STORM_LIMIT = 25;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** A trigger of a live workflow. */
export interface LiveTrigger { id: string; index: number; workflow: WorkflowDef; def: TriggerDef }

export const triggerIdOf = (workflowId: string, index: number) => `${workflowId}#${index}`;

function firingOf(r: any): TriggerFiring {
  return {
    key: r.key, triggerId: r.trigger_id, workflowId: r.workflow_id, kind: r.kind, status: r.status, at: iso(r.at),
    ...(r.record ? { record: r.record } : {}), ...(r.run_id ? { runId: r.run_id } : {}), ...(r.case_id ? { caseId: r.case_id } : {}),
    ...(r.message ? { message: r.message } : {}),
  };
}

/** Plain words for why a firing could not start its case. */
function failureWords(e: unknown): string {
  if (e instanceof StartRunError) return `the case could not start: ${Object.entries(e.errors).map(([f, m]) => `${f}: ${m.join('; ')}`).join(', ')}`;
  return `the case could not start: ${e instanceof Error ? e.message : String(e)}`;
}

export interface Triggers extends TriggersService {
  /** The dispatcher's `triggers` consumer (entered, created, changed). */
  consumer: EventConsumer;
}

export function createTriggers(deps: FlowDeps, more: { settle: TriggersService['settle'] }): Triggers {
  const { pool } = deps;

  async function live(): Promise<LiveTrigger[]> {
    const out: LiveTrigger[] = [];
    for (const workflow of await deps.workflows()) {
      (workflow.startsOn ?? []).forEach((def, index) => out.push({ id: triggerIdOf(workflow.id, index), index, workflow, def }));
    }
    return out;
  }

  /** Who a triggered case runs as: the trigger's `as`, else the workflow's owner, else the domain's. */
  async function actsFor(t: LiveTrigger): Promise<string | undefined> {
    return t.def.as ?? t.workflow.owner ?? (await deps.domains())[domainOf(t.workflow)]?.owner;
  }

  /** Start the case of a firing that is `started` (again: startRun with the same run id is a no-op). */
  async function startFiring(row: any): Promise<TriggerFiring> {
    try {
      const { caseId } = await deps.start(
        { workflowId: row.workflow_id, case: row.values ?? {}, runId: row.run_id, by: `trigger:${row.trigger_id}`, ...(row.workflow_hash ? { workflowHash: row.workflow_hash } : {}) },
        row.acts_for ? { actsFor: row.acts_for } : {});
      const { rows } = await pool.query(`update mw.trigger_firings set case_id = $2 where key = $1 returning *`, [row.key, caseId]);
      return firingOf(rows[0]);
    } catch (e) {
      const { rows } = await pool.query(`update mw.trigger_firings set status = 'failed', message = $2 where key = $1 returning *`, [row.key, failureWords(e)]);
      deps.log?.(`trigger ${row.trigger_id}: ${failureWords(e)}`);
      return firingOf(rows[0]);
    }
  }

  /**
   * One firing, once per key. Above the storm limit within a minute it is held instead, for the
   * owner to start or discard.
   */
  async function fire(t: LiveTrigger, key: string, source: TriggerSource & { record?: { entity: string; id: string } }, record?: string): Promise<TriggerFiring> {
    const existing = (await pool.query(`select * from mw.trigger_firings where key = $1`, [key])).rows[0];
    if (existing) {
      if (existing.status === 'started' && !existing.case_id) return startFiring({ ...existing, workflow_hash: t.workflow.hash });
      return firingOf(existing);
    }
    const values = triggerValues(t.workflow, t.def.with ?? {}, source, deps.entities());
    const role = await actsFor(t);
    const limit = await deps.stormLimit();
    const client = await pool.connect();
    let row: any;
    try {
      await client.query('begin');
      // Counted under a lock per trigger, so two firings at once can't both slip under the limit.
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 7))`, [t.id]);
      const recent = await client.query(
        `select count(*)::int as n from mw.trigger_firings
          where trigger_id = $1 and status in ('started', 'held') and at > now() - interval '1 minute'`, [t.id]);
      const held = recent.rows[0].n >= limit;
      const ins = await client.query(
        `insert into mw.trigger_firings (key, trigger_id, workflow_id, trigger_index, kind, record, run_id, status, "values", acts_for)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (key) do nothing returning *`,
        [key, t.id, t.workflow.id, t.index, t.def.kind, record ?? source.record?.id ?? null,
          held ? null : derivedRunId(key), held ? 'held' : 'started', JSON.stringify(values), role ?? null]);
      row = ins.rows[0] ?? (await client.query(`select * from mw.trigger_firings where key = $1`, [key])).rows[0];
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    crashPoint('trigger-before-start', t.id);
    if (row.status === 'started' && !row.case_id) return startFiring({ ...row, workflow_hash: t.workflow.hash });
    return firingOf(row);
  }

  const entityMatch = (t: LiveTrigger, event: EntityEvent): boolean => {
    const d = t.def;
    if (d.kind !== 'entered' && d.kind !== 'created' && d.kind !== 'changed') return false;
    if (entityKeyFor(t.workflow, d.entity, deps.entities()) !== event.entity) return false;
    if (d.kind === 'entered') return event.kind === 'entered' && event.state === d.state;
    if (d.kind === 'created') return event.kind === 'created';
    // `changed`: any change, or one of the named fields (a lifecycle move changes `status`).
    return event.kind === 'changed' && (!d.fields?.length || d.fields.some((f) => event.fields?.includes(f)));
  };

  const consumer: EventConsumer = {
    name: 'triggers',
    async handle(event) {
      for (const t of await live()) {
        if (!entityMatch(t, event)) continue;
        await fire(t, `${t.def.kind}:${t.id}:${event.id}`, { record: { entity: event.entity, id: event.recordId } });
      }
    },
  };

  // ---------------------------------------------------------------- date triggers and schedules

  type DateTrigger = Extract<TriggerDef, { kind: 'date' }>;
  /** `<date> ∓ offset` as SQL over the date column. */
  const dueExpr = (col: string, d: DateTrigger) =>
    `((${col})::date ${d.direction === 'before' ? '-' : '+'} ($2::float8 / 86400000) * interval '1 day')::date`;

  /** The entity and column of a date trigger (`Person.cv_expires` or entity + field). */
  function dateTarget(t: LiveTrigger & { def: DateTrigger }) {
    const key = entityKeyFor(t.workflow, t.def.entity, deps.entities());
    const def = deps.entities()[key];
    const field = t.def.field.includes('.') ? t.def.field.slice(t.def.field.lastIndexOf('.') + 1) : t.def.field;
    const column = def ? columnOf(def, field) : undefined;
    return def && column ? { key, def, column: `r.${q(column)}` } : undefined;
  }

  async function sweepDates(t: LiveTrigger & { def: DateTrigger }, now: Date): Promise<TriggerFiring[]> {
    const target = dateTarget(t);
    if (!target) return [];
    const prefix = `date:${t.id}:`;
    const { rows } = await pool.query(
      `select r.id, (${target.column})::date::text as d from ${tableOf(target.def)} r
        where ${target.column} is not null and ${dueExpr(target.column, t.def)} <= ($1::timestamptz)::date
          and not exists (select 1 from mw.trigger_firings f
                           where f.key = $3 || r.id || ':' || (${target.column})::date::text
                             and (f.case_id is not null or f.status <> 'started'))
        order by ${target.column}, r.id limit 1000`, [now.toISOString(), t.def.offsetMs, prefix]);
    const out: TriggerFiring[] = [];
    for (const r of rows) out.push(await fire(t, `${prefix}${r.id}:${r.d}`, { record: { entity: target.key, id: r.id } }));
    return out;
  }

  type Every = Extract<TriggerDef, { kind: 'every' }>;
  const scheduleShape = (d: Every) => JSON.stringify({ everyMs: d.everyMs, at: d.at ?? null, on: d.on ?? null });

  async function sweepSchedule(t: LiveTrigger & { def: Every }, now: Date): Promise<TriggerFiring[]> {
    const shape = scheduleShape(t.def);
    const state = (await pool.query(`select next_due, cursor from mw.trigger_state where trigger_id = $1`, [t.id])).rows[0];
    if (!state || state.cursor?.shape !== shape || !state.next_due) {
      // New (or changed) schedule: its first slot from now.
      await pool.query(
        `insert into mw.trigger_state (trigger_id, next_due, cursor) values ($1, $2, $3)
         on conflict (trigger_id) do update set next_due = excluded.next_due, cursor = excluded.cursor`,
        [t.id, firstSlot(t.def, now), JSON.stringify({ shape })]);
      return [];
    }
    const due = dueSlot(new Date(state.next_due), t.def.everyMs, now);
    if (!due) return [];
    // A desktop closed through several slots fires once, for the latest one.
    const firing = await fire(t, `every:${t.id}:${due.slot.toISOString()}`, {}, due.slot.toISOString());
    await pool.query(`update mw.trigger_state set next_due = $2, last_fired_at = now() where trigger_id = $1`, [t.id, due.next]);
    return [firing];
  }

  // ---------------------------------------------------------------- the list

  async function nextDue(t: LiveTrigger, now: Date): Promise<TriggerSummary['nextDue']> {
    if (t.def.kind === 'every') {
      const { rows } = await pool.query(`select next_due from mw.trigger_state where trigger_id = $1`, [t.id]);
      return { at: iso(rows[0]?.next_due ?? firstSlot(t.def, now)) };
    }
    if (t.def.kind !== 'date') return undefined;
    const target = dateTarget(t as LiveTrigger & { def: DateTrigger });
    if (!target) return undefined;
    const prefix = `date:${t.id}:`;
    const { rows } = await pool.query(
      `select r.id, ${dueExpr(target.column, t.def)}::text as due from ${tableOf(target.def)} r
        where ${target.column} is not null and ${dueExpr(target.column, t.def)} >= ($1::timestamptz)::date
          and not exists (select 1 from mw.trigger_firings f where f.key = $3 || r.id || ':' || (${target.column})::date::text)
        order by 2, r.id limit 1`, [now.toISOString(), t.def.offsetMs, prefix]);
    if (!rows[0]) return undefined;
    const record: RecordRef | undefined = await recordRef(pool, target.def, target.key, rows[0].id);
    return { at: new Date(`${rows[0].due}T00:00:00`).toISOString(), ...(record ? { record } : {}) };
  }

  return {
    consumer,

    async list() {
      const now = new Date();
      const counts = await pool.query(
        `select trigger_id, max(at) as last, count(*)::int as n, count(*) filter (where status = 'held')::int as held
           from mw.trigger_firings group by trigger_id`);
      const by = new Map(counts.rows.map((r) => [r.trigger_id as string, r]));
      const out: TriggerSummary[] = [];
      for (const t of await live()) {
        const c = by.get(t.id);
        const due = await nextDue(t, now).catch(() => undefined);
        out.push({
          id: t.id, workflowId: t.workflow.id, domain: t.workflow.domain ?? DEFAULT_DOMAIN, def: t.def,
          description: describeTrigger(t.def), ...(c?.last ? { lastFiredAt: iso(c.last) } : {}), ...(due ? { nextDue: due } : {}),
          firings: c?.n ?? 0, held: c?.held ?? 0,
        });
      }
      return out;
    },

    async firings(filter) {
      const { rows } = await pool.query(
        `select * from mw.trigger_firings where ($1::text is null or trigger_id = $1) and ($2::text is null or status = $2)
          order by at desc, key limit $3`,
        [filter.triggerId ?? null, filter.status ?? null, Math.min(Math.max(filter.limit ?? 100, 1), 1000)]);
      return rows.map(firingOf);
    },

    async release(triggerId, decision, by: PersonActor) {
      const t = (await live()).find((x) => x.id === triggerId);
      if (!t) return { applied: false, started: 0, message: `There is no automation ${triggerId}.` };
      const domain = domainOf(t.workflow);
      const role = t.workflow.owner ?? (await deps.domains())[domain]?.owner;
      if (role && !hasRole(by, role, domain)) {
        return { applied: false, started: 0, message: `Only someone with the ${role} role can decide on these cases.` };
      }
      if (decision === 'discard') {
        const r = await pool.query(
          `update mw.trigger_firings set status = 'discarded', decided_at = now(), message = $2 where trigger_id = $1 and status = 'held'`,
          [triggerId, `discarded by ${by.personId}`]);
        return { applied: (r.rowCount ?? 0) > 0, started: 0, ...(r.rowCount ? {} : { message: 'Nothing is held for this automation.' }) };
      }
      // Claimed in one statement, so two people releasing at once start each case once.
      const { rows } = await pool.query(
        `update mw.trigger_firings f set status = 'started', decided_at = now(), message = $2, run_id = x.run_id
           from (select key, 'run_' || substr(encode(sha256(convert_to(key, 'UTF8')), 'hex'), 1, 26) as run_id
                   from mw.trigger_firings where trigger_id = $1 and status = 'held') x
          where f.key = x.key returning f.*`, [triggerId, `started by ${by.personId}`]);
      let started = 0;
      for (const row of rows.sort((a, b) => +a.at - +b.at)) {
        const f = await startFiring({ ...row, workflow_hash: t.workflow.hash });
        if (f.status === 'started') started++;
      }
      return { applied: rows.length > 0, started, ...(rows.length ? {} : { message: 'Nothing is held for this automation.' }) };
    },

    async receiveMessage(domain, body: InboundMessageBody) {
      const { row, message, duplicate } = await storeMessage(deps, domain, body);
      const intake = (await deps.domains())[domain]?.intake?.address ?? domain;
      const firings: TriggerFiring[] = [];
      for (const t of await live()) {
        if (t.def.kind !== 'message' || domainOf(t.workflow) !== domain || t.def.address !== intake) continue;
        // Fired again for a duplicate too: the keys exist, so that starts nothing new, and a
        // delivery that crashed between storing the message and starting its case completes.
        firings.push(await fire(t, `message:${t.id}:${row.id}`, { message: { ...message } }, row.id));
      }
      return { messageId: row.id, duplicate, firings };
    },

    async sweep(now = new Date()) {
      const out: TriggerFiring[] = [];
      for (const t of await live()) {
        try {
          if (t.def.kind === 'date') out.push(...(await sweepDates(t as LiveTrigger & { def: DateTrigger }, now)));
          else if (t.def.kind === 'every') out.push(...(await sweepSchedule(t as LiveTrigger & { def: Every }, now)));
        } catch (e) {
          deps.log?.(`trigger ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },

    settle: more.settle,
  };
}

