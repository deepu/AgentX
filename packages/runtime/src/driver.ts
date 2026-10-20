// The run driver (D39), generalised from spike S5 (spikes/s5-xstate-dbos/src/runtime.ts).
//
//   DBOS workflow "run:<runId>"                       one per run; a second start is a no-op
//     loadRun, loadDefinition                          journaled: the run is pinned to its snapshot (D36)
//     loop while the run is active:
//       agent step     prepareStep (journaled) → step workflow "<run>/<entered_seq>/<state>" → StepResult
//       system step    prepareStep (journaled) → system step workflow "<run>/<entered_seq>/<state>" (no model)
//       person/external/wait   DBOS.recv('events', deadline = earliest pending timer); a person's
//                      submission (submitStep) carries its values beside the event, never in it
//       commit         ONE transaction through the DBOS data source: XState transition(), CAS on
//                      runs.seq, a transitions row, the step's case writes, timers armed/cancelled
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { crashPoint, END_STATE, type CaseValue, type WorkflowDef } from '@memwise/defs';
import type { StepResult, StepRunInput } from '@memwise/step-engine';
import type pg from 'pg';
import { transition, type AnyStateMachine } from 'xstate';
import { stepRunIdOf } from './ids.ts';
import { answeredBySubmit, compileMachine, REMIND_EVENT, stateKind, type RunEvent } from './machine.ts';
import { openWaitingStep, prepareAgentStep, type PreparedStep } from './prepare.ts';
import { PgCaseStore, PgNotificationStore } from '@memwise/db';
import { loadRunRow, loadWorkflowDef, type Queryable, type RunRow } from './runs.ts';
import type { Actor, SendEventResult } from './types.ts';

export interface Commit {
  runId: string;
  expectedSeq: number;
  event: RunEvent;
  source: 'step' | 'external' | 'timer';
  /** The run's definition; the commit compiles the machine from it. */
  workflowId: string;
  workflowHash: string;
  stepRunId?: string;
  firedTimer?: { timerId: string; armedSeq: number };
  /** The step's writes, applied only when the event is accepted. */
  writes?: Record<string, CaseValue>;
  /** Stop the run instead of transitioning. */
  stop?: string;
  /** For step outcomes: stop with this reason when the state has no transition for the event. */
  stopIfUnhandled?: string;
  /** The step workflow threw: its step run is marked `failed` with this as the rationale. */
  stepError?: string;
  /** A person's answer to the waiting step (submitStep); its values are written only when the event is accepted. */
  submission?: Submission;
}

/** What `submitStep` sends beside the outcome event. */
export interface Submission {
  stepRunId: string;
  by: string;
  at: string;
  values: Record<string, unknown>;
  comment?: string;
  /** A conversation step's chat answered it (Phase 3): its writes are the chat's judgement, for `by`. */
  via?: { chatId: string; rationale?: string };
}

/** The DBOS message `submitStep` sends: the event plus the submission, split apart by the driver. */
export interface SubmissionMessage extends RunEvent { submission: Submission }

const STOP_EVENT: RunEvent = { type: 'stop' };
const cases = new PgCaseStore();
const notifications = new PgNotificationStore();

export interface DriverDeps {
  pool: pg.Pool;
  dataSource: NodePostgresDataSource;
  stepWorkflow: (input: StepRunInput) => Promise<StepResult>;
  /** The system (mechanical) step workflow. */
  systemWorkflow: (input: StepRunInput) => Promise<StepResult>;
}

/** Register the driver and its commit with DBOS. Call before DBOS.launch(), once per launch. */
export function registerRunDriver({ pool, dataSource, stepWorkflow, systemWorkflow }: DriverDeps) {
  // Definitions are immutable per hash, so compiled machines can be cached across runs.
  const machines = new Map<string, { workflow: WorkflowDef; machine: AnyStateMachine }>();
  const machineFor = async (db: Queryable, id: string, hash: string) => {
    const key = `${id}@${hash}`;
    let m = machines.get(key);
    if (!m) {
      const workflow = await loadWorkflowDef(db, id, hash);
      m = { workflow, machine: compileMachine(workflow) };
      machines.set(key, m);
    }
    return m;
  };

  const commit = dataSource.registerTransaction(async (c: Commit) => {
    const db = NodePostgresDataSource.client;
    const { workflow, machine } = await machineFor(db, c.workflowId, c.workflowHash);
    return applyTransition(db, machine, c, workflow);
  }, { name: 'memwise.run.commit' });

  const driver = DBOS.registerWorkflow(async (runId: string) => {
    let run = await DBOS.runStep(() => loadRunRow(pool, runId), { name: 'loadRun' });
    const workflow = await DBOS.runStep(() => loadWorkflowDef(pool, run.workflowId, run.workflowHash), { name: 'loadDefinition' });
    const base = { runId, workflowId: run.workflowId, workflowHash: run.workflowHash };

    while (run.status === 'active') {
      const kind = stateKind(workflow, run.state);
      const stepRunId = stepRunIdOf(runId, run.enteredSeq, run.state);
      let next: Omit<Commit, 'runId' | 'expectedSeq' | 'workflowId' | 'workflowHash'> | null;

      if (kind === 'agent-step') {
        next = await runStep(run, workflow, stepRunId, stepWorkflow);
      } else if (kind === 'system-step') {
        next = await runStep(run, workflow, stepRunId, systemWorkflow);
      } else if (kind === 'final') {
        break; // unreachable: entering `end` sets status done
      } else {
        if (answeredBySubmit(kind)) {
          await DBOS.runStep(() => openWaitingStep(pool, run, workflow, stepRunId), { name: 'openWaitingStep' });
        }
        next = await waitForEvent(run);
        if (!next) continue; // idle wake-up without a timer: wait again
      }
      run = await commit({ ...base, expectedSeq: run.seq, ...next });
    }
    return { state: run.state, status: run.status };
  }, { name: 'memwise.run' });

  async function runStep(run: RunRow, workflow: WorkflowDef, stepRunId: string, body: DriverDeps['stepWorkflow']) {
    const prepared = await DBOS.runStep(() => prepareAgentStep(pool, run, workflow, stepRunId), { name: 'prepareStep' }) as PreparedStep;
    if ('stop' in prepared) return { event: STOP_EVENT, source: 'step' as const, stop: prepared.stop, stepRunId };
    // Deterministic id: after a crash we get the same child back, finished or recovered, never a new one.
    const handle = await DBOS.startWorkflow(body, { workflowID: stepRunId })(prepared.input);
    let result: StepResult;
    try {
      result = await handle.getResult();
    } catch (e) {
      // A step workflow that throws is an engine fault, not an outcome: the run stops for a person.
      // DBOS journals the failure, so a replay takes the same path.
      const stop = `step workflow failed: ${e instanceof Error ? e.message : String(e)}`;
      return { event: STOP_EVENT, source: 'step' as const, stop, stepRunId, stepError: stop };
    }
    crashPoint('after-step-before-commit', run.state);
    const completed = result.status === 'completed';
    return {
      // needs_person / failed go to the state's transition of that name when there is one (Conventions).
      event: { type: completed ? result.outcome : result.status },
      source: 'step' as const,
      stepRunId,
      writes: result.writes,
      stopIfUnhandled: completed
        ? `outcome "${result.outcome}" has no transition from ${run.state}`
        : `step ${result.status}${result.reason ? `: ${result.reason}` : ''}`,
    };
  }

  async function waitForEvent(run: RunRow) {
    const timer = run.timers[0]; // earliest pending deadline
    // recv journals its deadline; we pass the absolute fire_at, so a restart never recomputes it.
    const msg = await DBOS.recv<RunEvent>('events', timer ? { deadlineEpochMS: timer.fireAtMs } : { timeoutSeconds: 24 * 3600 });
    if (msg && 'submission' in msg) {
      // The values ride beside the event, so the transition row (and the replay guard that
      // compares it) holds only the outcome, who answered and the entry it answers.
      const { submission, ...event } = msg as SubmissionMessage;
      return { event, source: 'external' as const, submission };
    }
    if (msg) return { event: msg, source: 'external' as const };
    if (timer) return { event: timer.event, source: 'timer' as const, firedTimer: { timerId: timer.timerId, armedSeq: timer.armedSeq } };
    return null;
  }

  return { driver, commit };
}

/** Apply one event to the run inside the caller's transaction. */
export async function applyTransition(db: Queryable, machine: AnyStateMachine, c: Commit, workflow?: WorkflowDef): Promise<RunRow> {
  const run = await loadRunRow(db, c.runId);
  const newSeq = c.expectedSeq + 1;
  if (run.seq !== c.expectedSeq) {
    // The data-source transaction makes this unreachable for our own commits; the guard stays
    // against a stray second writer, and accepts the replay of a commit that already landed.
    const dup = await db.query(`select 1 from mw.transitions where run_id = $1 and seq = $2 and event = $3::jsonb`,
      [c.runId, newSeq, JSON.stringify(c.event)]);
    if (run.seq >= newSeq && dup.rowCount) return run;
    throw new Error(`seq conflict on ${c.runId}: expected ${c.expectedSeq}, found ${run.seq}`);
  }

  const snap = machine.resolveState(run.snapshot as any);
  let stop = c.stop;
  let note: string | null = null;
  let next = snap;
  let actions: any[] = [];
  if (!stop && c.source === 'timer' && c.event.type === REMIND_EVENT) {
    // A reminder for whoever the state waits on, shown in their inbox. It never moves the run.
    note = 'reminder';
    if (workflow) await remind(db, workflow, run, c);
  } else if (!stop) {
    const forSeq = (c.event as { for?: unknown }).for;
    if (forSeq !== undefined && forSeq !== run.enteredSeq) note = `stale: for entry ${forSeq}, current entry ${run.enteredSeq}`;
    else if (!snap.can(c.event)) {
      if (c.stopIfUnhandled) stop = c.stopIfUnhandled;
      else note = `not handled in ${run.state}`;
    } else [next, actions] = transition(machine, snap, c.event);
  }
  const accepted = !stop && (note === null || c.event.type === REMIND_EVENT);
  const moved = accepted && c.event.type !== REMIND_EVENT;
  const to = String(next.value);
  const status = stop ? 'stopped' : next.status === 'done' ? 'done' : 'active';

  await db.query(
    `update mw.runs set snapshot = $3, state = $4, status = $5, seq = $2 + 1, stop_reason = $6,
            entered_seq = case when $7 then $2 + 1 else entered_seq end, updated_at = now()
      where id = $1 and seq = $2`,
    [c.runId, c.expectedSeq, JSON.stringify(machine.getPersistedSnapshot(next)), to, status, stop ?? null, moved]);
  await db.query(
    `insert into mw.transitions (run_id, seq, from_state, to_state, event, source, accepted, note, step_run_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [c.runId, newSeq, run.state, to, JSON.stringify(c.event), c.source, accepted, stop ? `stopped: ${stop}` : note, c.stepRunId ?? null]);
  if (c.firedTimer) {
    await db.query(`update mw.timers set status = 'fired' where run_id = $1 and timer_id = $2 and armed_seq = $3`,
      [c.runId, c.firedTimer.timerId, c.firedTimer.armedSeq]);
  }
  if (moved) {
    const waitingId = stepRunIdOf(c.runId, run.enteredSeq, run.state);
    let writes = c.writes;
    const sub = c.submission && c.submission.stepRunId === waitingId ? c.submission : undefined;
    if (sub) {
      writes = {};
      for (const [field, value] of Object.entries(sub.values)) {
        writes[field] = {
          value,
          provenance: sub.via
            ? { kind: 'judgement', at: sub.at, stepRunId: sub.stepRunId, ...(sub.via.rationale ? { rationale: sub.via.rationale } : {}), chatId: sub.via.chatId, by: sub.by }
            : { kind: 'person', at: sub.at, by: sub.by, stepRunId: sub.stepRunId },
        };
      }
    }
    if (writes && Object.keys(writes).length) {
      await cases.applyWrites(db, run.caseId, writes, c.stepRunId ?? sub?.stepRunId);
      await markTainted(db, run.caseId, writes);
    }
    // A person or external step left by an outside event is done; its answer is the event.
    await db.query(
      `update mw.step_runs set status = 'completed', outcome = $3, finished_at = now(),
              decided_by = coalesce($4, decided_by), comment = coalesce($5, comment),
              outputs = case when $6::jsonb is null then outputs else $6::jsonb end,
              rationale = coalesce($7, rationale)
        where id = $1 and status = 'waiting' and run_id = $2`,
      [waitingId, c.runId, c.event.type, sub?.by ?? null, sub?.comment ?? null, sub ? JSON.stringify(writes ?? {}) : null,
        sub?.via?.rationale ?? null]);
    await notifications.markReadForStep(db, waitingId);
  }
  if (c.stepError && c.stepRunId) {
    // The step never reported back, so its record would stay `running`: close it here.
    await db.query(
      `update mw.step_runs set status = 'failed', rationale = $2, finished_at = now() where id = $1 and finished_at is null`,
      [c.stepRunId, c.stepError]);
  }
  if (c.source === 'step' && c.stepRunId) {
    // The step run is over: approvals it still waits on can no longer be answered. `expired`
    // is a fourth value of the free-text mw.approvals.status (pending | approved | rejected | expired).
    await db.query(`update mw.approvals set status = 'expired' where step_run_id = $1 and status = 'pending'`, [c.stepRunId]);
  }
  await applyTimerActions(db, c.runId, newSeq, actions);
  if (status !== 'active') {
    await db.query(`update mw.timers set status = 'cancelled' where run_id = $1 and status = 'pending'`, [c.runId]);
  }
  crashPoint('in-commit', run.state);
  const after = await loadRunRow(db, c.runId);
  if (moved && workflow && status === 'active') {
    // Open the person, external or conversation step in the same transaction that enters its
    // state, so the run is never seen in that state without its waiting step run. The driver's
    // own openWaitingStep stays as the path for a run that starts in such a state (idempotent).
    if (answeredBySubmit(stateKind(workflow, to))) {
      await openWaitingStep(db, after, workflow, stepRunIdOf(c.runId, after.enteredSeq, to));
    }
  }
  return after;
}

/** Keeps mw.cases.tainted_fields in step with the provenance of the fields just written. */
async function markTainted(db: Queryable, caseId: string, writes: Record<string, CaseValue>) {
  const fields = Object.keys(writes);
  const tainted = fields.filter((f) => (writes[f]!.provenance as { tainted?: boolean }).tainted);
  await db.query(
    `update mw.cases set tainted_fields =
        array(select f from unnest(tainted_fields) f where not (f = any($2::text[])) union select unnest($3::text[]) order by 1)
      where id = $1`, [caseId, fields, tainted]);
}

/** Who a state waits on: its step's assignee, the state's, else the workflow owner. */
export function assigneeOf(workflow: WorkflowDef, state: string): string | undefined {
  if (state === END_STATE) return undefined;
  const def = workflow.states[state];
  const step = def ? workflow.steps[def.step ?? state] : undefined;
  return step?.assignee ?? def?.assignee ?? workflow.owner;
}

/**
 * Why an outside event may not decide `state` (kernel.sendEvent). A person, external or
 * conversation step is answered only through submitStep, which checks its assignee, so the step run records who
 * decided. Any other state, sent by a person: they must hold its assignee role or the owner's.
 */
export function outsideEventRefusal(workflow: WorkflowDef, state: string, by?: Actor): Omit<SendEventResult, 'sent'> | undefined {
  if (state === END_STATE || !workflow.states[state]) return undefined;
  if (answeredBySubmit(stateKind(workflow, state))) {
    return { reason: 'use_submit', message: `${state} is answered through its step, not by an outside event` };
  }
  if (by?.kind !== 'person') return undefined;
  const roles = [...new Set([assigneeOf(workflow, state), workflow.owner].filter((r): r is string => !!r))];
  if (roles.length && !roles.some((r) => by.roles.includes(r))) {
    return { reason: 'forbidden', message: `only someone with the ${roles.join(' or ')} role can decide this` };
  }
  return undefined;
}

/** A fired `remind` timer: a reminder in the inbox of the role the state waits on (idempotent per timer). */
async function remind(db: Queryable, workflow: WorkflowDef, run: RunRow, c: Commit) {
  const def = workflow.states[run.state];
  const step = def ? workflow.steps[def.step ?? run.state] : undefined;
  const hasStep = answeredBySubmit(stateKind(workflow, run.state));
  const role = assigneeOf(workflow, run.state);
  const what = step?.title ? `"${step.title}"` : `the ${run.state} step`;
  await notifications.add(db, {
    id: `remind:${c.runId}:${c.firedTimer?.armedSeq ?? run.enteredSeq}:${c.firedTimer?.timerId ?? run.state}`,
    runId: c.runId,
    ...(hasStep ? { stepRunId: stepRunIdOf(c.runId, run.enteredSeq, run.state) } : {}),
    ...(role ? { role } : {}),
    kind: 'reminder',
    text: `Reminder: ${what} in ${workflow.title ?? workflow.id} is still waiting.`,
  });
}

/** XState returns delayed events as data: arm on a delayed `xstate.raise`, disarm on `xstate.cancel`. */
export async function applyTimerActions(db: Queryable, runId: string, seq: number, actions: any[]) {
  for (const a of actions) {
    if (a.type === 'xstate.cancel') {
      await db.query(`update mw.timers set status = 'cancelled' where run_id = $1 and timer_id = $2 and status = 'pending'`,
        [runId, a.params.sendId]);
    } else if (a.type === 'xstate.raise' && typeof a.params?.delay === 'number') {
      // Absolute deadline, written once; restarts never recompute it.
      await db.query(
        `insert into mw.timers (run_id, timer_id, armed_seq, event, fire_at, status)
         values ($1, $2, $3, $4, now() + make_interval(secs => $5::float8 / 1000), 'pending')`,
        [runId, a.params.id, seq, JSON.stringify(a.params.event), a.params.delay]);
    } else if (a.type === 'xstate.raise') {
      throw new Error('immediate raise is not supported by the run driver');
    }
  }
}
