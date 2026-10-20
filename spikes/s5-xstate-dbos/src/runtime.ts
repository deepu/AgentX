// Run engine: XState pure functions for the shape, our tables for state, DBOS for execution.
//
//   run driver (DBOS workflow "run:<id>")            one per run, deterministic id
//     loop:
//       state has a step?   start step workflow "<run>/<entered_seq>/<step>" and await its outcome
//       state is a wait?    DBOS.recv('events', { deadlineEpochMS: next timer.fire_at })
//       next = xstate.transition(machine, snapshot, event)        pure, no actor
//       commit(next) in ONE transaction: CAS on runs.seq, append transitions row,
//                    arm/cancel timers; DBOS records the result in the same tx
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { writeSync } from 'node:fs';
import pg from 'pg';
import { initialTransition, transition } from 'xstate';
import { intake, metaOf, type IntakeEvent } from './machine.ts';

export const DB_URL = process.env.DB_URL ?? 'postgresql://postgres@127.0.0.1:54325/memwise';
export const pool = new pg.Pool({ connectionString: DB_URL, max: 5 });
// Commits go through a DBOS data source: the commit's output is recorded in the same
// Postgres transaction as our writes, so a commit is exactly-once.
const appDb = new NodePostgresDataSource('app', { connectionString: DB_URL, max: 5 }, 'dbos_tx');
const COMMIT_MODE = process.env.COMMIT_MODE ?? 'tx'; // 'tx' (data source) | 'step' (plain DBOS step + CAS)

export const driverId = (runId: string) => `run:${runId}`;

export function log(...parts: unknown[]) {
  const line = [new Date().toISOString(), `[pid ${process.pid}]`, ...parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))].join(' ');
  writeSync(1, line + '\n'); // synchronous so nothing is lost on kill -9
}

/** CRASH_AT=<point>[@<detail>] kills this process with SIGKILL at that point. */
export function crashPoint(point: string, detail?: string) {
  const [want, filter] = (process.env.CRASH_AT ?? '').split('@');
  if (want !== point || (filter && filter !== detail)) return;
  log(`*** CRASH_AT=${process.env.CRASH_AT}: kill -9 self`);
  process.kill(process.pid, 'SIGKILL');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- run rows

type Timer = { timer_id: string; armed_seq: number; event: IntakeEvent; fire_at_ms: number };
export type Run = {
  id: string; state: string; status: string; seq: number; entered_seq: number;
  snapshot: { value: string; context: any; status: string }; timers: Timer[];
};

async function loadRun(db: pg.ClientBase | pg.Pool, runId: string): Promise<Run> {
  const { rows } = await db.query('select id, state, status, seq, entered_seq, snapshot from mw.runs where id = $1', [runId]);
  if (!rows[0]) throw new Error(`no run ${runId}`);
  const t = await db.query(
    `select timer_id, armed_seq, event, (extract(epoch from fire_at) * 1000)::bigint as fire_at_ms
       from mw.timers where run_id = $1 and status = 'pending' order by fire_at`, [runId]);
  return { ...rows[0], timers: t.rows.map((r) => ({ ...r, fire_at_ms: Number(r.fire_at_ms) })) };
}

// ---------------------------------------------------------------- step workflows (fake work)

async function effect(runId: string, name: string, ms: number) {
  // One DBOS step = one journaled unit of work. A completed step is never re-run on recovery.
  await DBOS.runStep(async () => {
    await sleep(ms);
    await pool.query('insert into mw.effects(run_id, step_wf_id, name, pid) values ($1,$2,$3,$4)',
      [runId, DBOS.workflowID, name, process.pid]);
    log(`  effect ${name} done in ${DBOS.workflowID}`);
  }, { name });
}

const steps: Record<string, (runId: string) => Promise<IntakeEvent | null>> = {
  collect: DBOS.registerWorkflow(async (runId: string) => {
    await effect(runId, 'collect.gather_documents', 800);
    return { type: 'collected' } as IntakeEvent;
  }, { name: 'step.collect' }),

  check: DBOS.registerWorkflow(async (runId: string) => {
    await effect(runId, 'check.extract_fields', 800);
    crashPoint('mid-step', 'check');
    await effect(runId, 'check.validate', 800);
    return { type: 'checked' } as IntakeEvent;
  }, { name: 'step.check' }),

  // Entry work of human waits: create the approval card / notify. No outcome: the
  // outcome is the person's answer, which arrives as an external event.
  request_approval: DBOS.registerWorkflow(async (runId: string) => {
    await effect(runId, 'approve.create_inbox_item', 300);
    return null;
  }, { name: 'step.request_approval' }),

  escalate: DBOS.registerWorkflow(async (runId: string) => {
    await effect(runId, 'escalate.notify_partner', 300);
    return null;
  }, { name: 'step.escalate' }),
};

// ---------------------------------------------------------------- commit

type Commit = {
  runId: string; expectedSeq: number; event: IntakeEvent; source: 'step' | 'external' | 'timer';
  stepWfId: string | null; firedTimer: Timer | null;
};

/** Apply one event to the run. Pure XState transition + writes, all in the caller's transaction. */
async function applyTransition(db: pg.ClientBase, c: Commit): Promise<Run & { duplicate?: boolean }> {
  const run = await loadRun(db, c.runId);
  const newSeq = c.expectedSeq + 1;
  if (run.seq !== c.expectedSeq) {
    // Only reachable when an earlier attempt of this same commit already landed (COMMIT_MODE=step
    // crash after COMMIT, before DBOS checkpointed). The log row proves it; do not apply twice.
    const dup = await db.query('select 1 from mw.transitions where run_id = $1 and seq = $2 and event = $3::jsonb',
      [c.runId, newSeq, JSON.stringify(c.event)]);
    if (run.seq >= newSeq && dup.rowCount) {
      log(`  commit seq ${newSeq} already applied by an earlier attempt -> returning stored state (no double transition)`);
      return { ...run, duplicate: true };
    }
    throw new Error(`seq conflict on ${c.runId}: expected ${c.expectedSeq}, found ${run.seq}`);
  }

  const snap = intake.resolveState(run.snapshot as any);
  // An external answer names the state entry it answers (`for` = entered_seq, i.e. the approval card).
  // Answers to an earlier card (before a send-back loop) are stale and must not move the run.
  const target = (c.event as { for?: number }).for;
  const note = target !== undefined && target !== run.entered_seq ? `stale: for entry ${target}, current entry ${run.entered_seq}`
    : !snap.can(c.event as any) ? `not handled in ${run.state}` : null;
  const accepted = note === null;
  const [next, actions] = accepted ? transition(intake, snap, c.event as any) : [snap, []];
  const persisted = intake.getPersistedSnapshot(next) as any;
  const to = String(next.value);
  const entered = to !== run.state;

  await db.query(
    `update mw.runs set snapshot = $3, state = $4, status = $5, seq = $2 + 1,
            entered_seq = case when $6 then $2 + 1 else entered_seq end, updated_at = now()
      where id = $1 and seq = $2`,
    [c.runId, c.expectedSeq, persisted, to, next.status === 'done' ? 'done' : 'active', entered]);
  await db.query(
    `insert into mw.transitions(run_id, seq, from_state, to_state, event, source, accepted, note, step_wf_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.runId, newSeq, run.state, to, c.event, c.source, accepted, note, c.stepWfId]);
  if (c.firedTimer) {
    await db.query(`update mw.timers set status = 'fired' where run_id = $1 and timer_id = $2 and armed_seq = $3`,
      [c.runId, c.firedTimer.timer_id, c.firedTimer.armed_seq]);
  }
  await applyTimerActions(db, c.runId, newSeq, actions);
  crashPoint('in-commit', to);
  return { ...(await loadRun(db, c.runId)) };
}

/** XState returns delayed transitions as actions: arm on `xstate.raise` with a delay, disarm on `xstate.cancel`. */
async function applyTimerActions(db: pg.ClientBase, runId: string, seq: number, actions: any[]) {
  for (const a of actions) {
    if (a.type === 'xstate.cancel') {
      await db.query(`update mw.timers set status = 'cancelled' where run_id = $1 and timer_id = $2 and status = 'pending'`,
        [runId, a.params.sendId]);
    } else if (a.type === 'xstate.raise' && typeof a.params?.delay === 'number') {
      // Absolute deadline, stored once. Restarts never recompute it.
      await db.query(
        `insert into mw.timers(run_id, timer_id, armed_seq, event, fire_at, status)
         values ($1,$2,$3,$4, now() + make_interval(secs => $5::float8 / 1000), 'pending')`,
        [runId, a.params.id, seq, a.params.event, a.params.delay]);
    } else if (a.type === 'xstate.raise') {
      throw new Error('immediate raise not handled in the spike');
    }
    // assign() is already folded into the snapshot; other custom actions would map to DBOS steps.
  }
}

const commitTx = appDb.registerTransaction(
  async (c: Commit) => applyTransition(NodePostgresDataSource.client, c), { name: 'commitTransition' });

async function commitStep(c: Commit) {
  // Fallback mode to show the CAS guard: our COMMIT and DBOS's checkpoint are separate.
  return DBOS.runStep(async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const r = await applyTransition(client, c);
      await client.query('commit');
      crashPoint('after-commit-before-checkpoint', r.state);
      return r;
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  }, { name: 'commitTransition' });
}

const commit = (c: Commit) => (COMMIT_MODE === 'step' ? commitStep(c) : commitTx(c));

// ---------------------------------------------------------------- the run driver

export const runDriver = DBOS.registerWorkflow(async (runId: string) => {
  let run = await DBOS.runStep(() => loadRun(pool, runId), { name: 'loadRun' });
  log(`driver ${DBOS.workflowID} at state=${run.state} seq=${run.seq}`);

  while (run.status === 'active') {
    const meta = metaOf(run.state);
    let event: IntakeEvent | null = null;
    let source: Commit['source'] = 'step';
    let stepWfId: string | null = null;
    let firedTimer: Timer | null = null;

    if (meta.step) {
      // Deterministic id: re-starting after a crash returns the same (possibly finished) workflow.
      stepWfId = `${runId}/${run.entered_seq}/${meta.step}`;
      const handle = await DBOS.startWorkflow(steps[meta.step], { workflowID: stepWfId })(runId);
      event = await handle.getResult();
      log(`step ${stepWfId} -> ${JSON.stringify(event)}`);
      if (event) crashPoint('after-step-before-commit', meta.step);
    }

    if (!event) {
      if (!meta.wait) throw new Error(`state ${run.state} produced no event and is not a wait`);
      const timer = run.timers[0] ?? null; // earliest pending deadline
      log(`waiting in ${run.state} for an external event` +
        (timer ? `, timer ${timer.timer_id} fires at ${new Date(timer.fire_at_ms).toISOString()}` : ''));
      crashPoint('waiting', run.state);
      // recv persists its deadline in DBOS's journal; we pass our absolute fire_at.
      const msg = await DBOS.recv<IntakeEvent>('events', timer ? { deadlineEpochMS: timer.fire_at_ms } : { timeoutSeconds: 3600 });
      if (msg) { event = msg; source = 'external'; stepWfId = null; }
      else if (timer) { event = timer.event; source = 'timer'; firedTimer = timer; stepWfId = null; }
      else continue; // idle wake-up with no timer: just wait again
      log(`received ${source} event ${JSON.stringify(event)}`);
    }

    run = await commit({ runId, expectedSeq: run.seq, event, source, stepWfId, firedTimer });
    log(`committed seq=${run.seq} state=${run.state} status=${run.status}`);
    crashPoint('after-commit', run.state);
  }
  log(`run ${runId} finished in ${run.state}`);
  return run.state;
}, { name: 'runDriver' });

// ---------------------------------------------------------------- entry points

export async function createRun(runId: string, approvalTimeoutMs?: number) {
  const [snap, actions] = initialTransition(intake, { approvalTimeoutMs });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ins = await client.query(
      `insert into mw.runs(id, workflow, state, status, snapshot, driver_wf_id) values ($1,'intake',$2,'active',$3,$4)
       on conflict (id) do nothing`,
      [runId, String(snap.value), intake.getPersistedSnapshot(snap), driverId(runId)]);
    if (ins.rowCount) await applyTimerActions(client, runId, 0, actions);
    await client.query('commit');
  } finally { client.release(); }
  // Fixed workflow id: starting twice is harmless.
  await DBOS.startWorkflow(runDriver, { workflowID: driverId(runId) })(runId);
  log(`started run ${runId} (approvalTimeoutMs=${approvalTimeoutMs ?? '3 days'})`);
}

export function configureDbos() {
  DBOS.setConfig({
    name: 'memwise-s5',
    systemDatabaseUrl: DB_URL, // same database as our tables (DBOS uses schema "dbos")
    applicationVersion: 's5-v1', // fixed, so recovery after a restart is not blocked by a code-hash change
    runAdminServer: false,
    logLevel: process.env.DBOS_LOG ?? 'warn',
  });
}

export async function migrate(schemaSql: string) {
  await pool.query(schemaSql);
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString: DB_URL }, 'dbos_tx');
}
