// The dispatcher (24 §7): reads mw.entity_events after its cursor, in order, and hands each
// event to every consumer once. mw.event_deliveries is the exactly-once ledger: a consumer's
// (event, consumer) row is written after it handled the event, and every consumer's effect is
// itself idempotent (keys derived from the event), so a crash between the two acts once.
//
// A resilient loop, not a DBOS workflow: its state is all in tables (the ledger, the cursor in
// mw.trigger_state), so there is nothing to journal, and a workflow that never ends would grow
// its journal forever. It is woken by LISTEN `mw_changes` ({kind:'entity'} and {kind:'flow'}),
// by a sweep every 30 s, and by settle() in tests. Each pump also does the other queued work
// (the hand-off outbox, incoming email, due entity timers) through `work`.
import { crashPoint, type EntityEvent } from '@memwise/defs';
import type pg from 'pg';

/** One thing that acts on entity events. Its `name` is its key in the ledger: keep it stable. */
export interface EventConsumer {
  name: string;
  handle(event: EntityEvent): Promise<void>;
}

/** A consumer that failed this many times on one event is given up on (its ledger row keeps the error). */
const MAX_ATTEMPTS = 5;
/** A hole in `seq` younger than this may be a transaction still committing: the cursor waits for it. */
const GAP_GRACE_S = 120;
const BATCH = 200;
export const SWEEP_MS = 30_000;
/** pg_try_advisory_lock key: one dispatcher at a time per database ("mwdisp"). */
const LOCK_KEY = '120364616919411';
const CURSOR_ID = 'dispatcher';

export interface DispatcherDeps {
  pool: pg.Pool;
  consumers: () => EventConsumer[];
  /** Other queued work each pump does after the events. Returns true when it did something. */
  work?: () => Promise<boolean>;
  /** Whether queued work is still waiting (settle). */
  pendingWork?: () => Promise<boolean>;
  log?: (message: string) => void;
}

interface EventRow {
  seq: string; id: string; entity: string; record_id: string; kind: EntityEvent['kind']; data: Record<string, unknown> | null;
  by: string | null; at: Date; age_s: number; done: string[];
}

export function eventOf(r: Pick<EventRow, 'seq' | 'id' | 'entity' | 'record_id' | 'kind' | 'data' | 'by' | 'at'>): EntityEvent {
  const d = r.data ?? {};
  return {
    id: r.id, seq: Number(r.seq), entity: r.entity, recordId: r.record_id, kind: r.kind,
    ...(Array.isArray(d.fields) ? { fields: d.fields as string[] } : {}),
    ...(typeof d.state === 'string' ? { state: d.state } : {}),
    ...(typeof d.from === 'string' ? { from: d.from } : {}),
    ...(typeof d.transition === 'string' ? { transition: d.transition } : {}),
    ...(r.by ? { by: r.by } : {}),
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
  };
}

export class Dispatcher {
  private running?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  /** Failures per `<event id>|<consumer>` in this process. */
  private attempts = new Map<string, number>();

  constructor(private readonly deps: DispatcherDeps) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), SWEEP_MS);
    (this.timer as { unref?: () => void }).unref?.();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  /** Ask for a pump; one that is running finishes and then runs once more. */
  wake(): void {
    void this.pump().catch((e) => this.deps.log?.(`dispatcher: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** One pass over the events and the queued work (single flight per process). */
  pump(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.locked(async () => {
            await this.dispatchEvents();
            // Work can make events (a child's transition) and events work (a wait to re-check).
            for (let i = 0; i < 20 && this.deps.work && (await this.deps.work()); i++) { /* until quiet */ }
          });
        } while (this.again && !this.stopped);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  /**
   * Wait until every event committed so far is handled by every consumer (or given up on) and
   * no queued work is left. Pumps as it waits.
   */
  async settle(timeoutMs = 30_000): Promise<void> {
    const { rows } = await this.deps.pool.query(`select coalesce(max(seq), 0)::text as seq from mw.entity_events`);
    const target = Number(rows[0].seq);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.pump();
      const left = await this.undelivered(target);
      const work = (await this.deps.pendingWork?.()) ?? false;
      if (!left && !work) return;
      if (Date.now() > deadline) {
        throw new Error(`the dispatcher did not settle in ${timeoutMs} ms (${left} events not handled${work ? ', work still queued' : ''})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Events after the cursor, up to `upTo`, that some consumer hasn't handled (a consumer added later starts at the cursor). */
  private async undelivered(upTo: number): Promise<number> {
    const names = this.deps.consumers().map((c) => c.name);
    const { rows } = await this.deps.pool.query(
      `select count(*)::int as n from mw.entity_events e
        where e.seq > $3 and e.seq <= $1
          and (select count(*) from mw.event_deliveries d where d.event_id = e.id and d.consumer = any($2::text[])) < cardinality($2::text[])`,
      [upTo, names, await this.cursor()]);
    return rows[0].n;
  }

  /** Runs `fn` while holding the database's dispatcher lock; skips when another process has it. */
  private async locked(fn: () => Promise<void>): Promise<void> {
    const client = await this.deps.pool.connect();
    let broken: Error | undefined;
    try {
      const got = await client.query(`select pg_try_advisory_lock($1) as ok`, [LOCK_KEY]);
      if (!got.rows[0].ok) return;
      try {
        await fn();
      } finally {
        await client.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]).catch((e: Error) => { broken = e; });
      }
    } finally {
      client.release(broken);
    }
  }

  private async dispatchEvents(): Promise<void> {
    const { pool } = this.deps;
    const consumers = this.deps.consumers();
    const names = consumers.map((c) => c.name);
    const cursor = await this.cursor();
    // Consumers that failed in this pump wait for the next one, so each sees its events in order.
    const blocked = new Set<string>();
    let scan = cursor;
    let advance = cursor;
    let advancing = true;
    for (;;) {
      const { rows } = await pool.query<EventRow>(
        `select e.seq::text, e.id, e.entity, e.record_id, e.kind, e.data, e.by, e.at,
                extract(epoch from now() - e.at)::float8 as age_s,
                array(select d.consumer from mw.event_deliveries d where d.event_id = e.id) as done
           from mw.entity_events e where e.seq > $1 order by e.seq limit $2`, [scan, BATCH]);
      for (const r of rows) {
        const seq = Number(r.seq);
        const done = new Set(r.done);
        const event = eventOf(r);
        for (const c of consumers) {
          if (done.has(c.name) || blocked.has(c.name) || this.stopped) continue;
          try {
            await c.handle(event);
            crashPoint('event-before-delivery', c.name);
            await this.deliver(event.id, c.name);
            done.add(c.name);
          } catch (e) {
            const key = `${event.id}|${c.name}`;
            const n = (this.attempts.get(key) ?? 0) + 1;
            this.attempts.set(key, n);
            const message = e instanceof Error ? e.message : String(e);
            this.deps.log?.(`dispatcher: ${c.name} failed on ${event.kind} ${event.entity} ${event.recordId} (try ${n}): ${message}`);
            if (n >= MAX_ATTEMPTS) {
              await this.deliver(event.id, c.name, message);
              done.add(c.name);
              this.attempts.delete(key);
            } else blocked.add(c.name);
          }
        }
        // The cursor moves past an event only when all consumers have it and nothing before it can still appear.
        if (advancing) {
          const gap = seq !== advance + 1 && r.age_s < GAP_GRACE_S;
          if (!gap && names.every((n) => done.has(n))) advance = seq;
          else advancing = false;
        }
        scan = seq;
      }
      if (rows.length < BATCH || this.stopped) break;
    }
    if (advance > cursor) {
      await pool.query(
        `insert into mw.trigger_state (trigger_id, cursor) values ($1, $2)
         on conflict (trigger_id) do update set cursor = excluded.cursor`, [CURSOR_ID, JSON.stringify({ seq: advance })]);
    }
  }

  private async cursor(): Promise<number> {
    const { rows } = await this.deps.pool.query(`select cursor from mw.trigger_state where trigger_id = $1`, [CURSOR_ID]);
    return Number(rows[0]?.cursor?.seq ?? 0);
  }

  private async deliver(eventId: string, consumer: string, error?: string) {
    await this.deps.pool.query(
      `insert into mw.event_deliveries (event_id, consumer, error) values ($1, $2, $3) on conflict do nothing`,
      [eventId, consumer, error ?? null]);
  }
}
