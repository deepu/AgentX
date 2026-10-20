// Hand-offs (24 §8): block states start, call, for_each and wait_until. The commit that enters a
// block state queues its work in mw.run_outbox (queueHandoffs, inside the driver's transaction);
// the dispatcher's pump performs it here, exactly once across crashes:
//
//   start / call / for_each   a child run per item, its run id derived from (parent run, entry,
//                             state, item), so a retry finds the child it made; a case_links row
//   start                     then `started` to the parent (for_each start: after every child)
//   outcome                   a called child that ended: `returns:` into the parent case and the
//                             child's last event (or `failed`) to the parent; for_each joins
//   wait_until                the condition on the record, now and on each of its events: `met`
//   cascade                   a stopped run stops the children it called (not those it started)
//
// Every message to a run goes through mw.inbox with an idempotency key, so sending twice is
// sending once; the outbox row is marked done after its work, which is safe to repeat.
import { PgCaseStore, withTransaction } from '@memwise/db';
import { crashPoint, domainOf, END_STATE, type BlockDef, type CaseValue, type WorkflowDef } from '@memwise/defs';
import type { RunEvent } from '../machine.ts';
import { loadWorkflowDef, type Queryable } from '../runs.ts';
import { StartRunError } from '../start.ts';
import type { CaseLinkView, RunStatus, WaitingCondition } from '../types.ts';
import { derivedRunId, domainName, sendInTx, type FlowDeps } from './context.ts';
import type { EventConsumer } from './dispatcher.ts';
import { recordRef } from './records.ts';
import { caseField, handoffValues, pathValue, refTarget } from './values.ts';

const cases = new PgCaseStore();
const MAX_ATTEMPTS = 5;
const BATCH = 25;
const titleOf = (wf: Pick<WorkflowDef, 'id' | 'title'>) => wf.title ?? wf.id;

/**
 * In the commit transaction (applyTransition, and startRun for a run that starts in a block
 * state): queue the hand-off work of what this commit did.
 */
export async function queueHandoffs(db: Queryable, workflow: WorkflowDef, x: {
  runId: string; moved: boolean; to: string; status: RunStatus; enteredSeq: number; event: RunEvent;
}): Promise<void> {
  if (x.moved) {
    // A wait on a record ends with its state.
    await db.query(
      `update mw.run_outbox set status = 'left', done_at = now() where run_id = $1 and kind = 'wait_until' and status in ('pending', 'waiting')`,
      [x.runId]);
  }
  if (x.moved && x.status === 'active') {
    const block = workflow.states[x.to]?.block;
    if (block) await queue(db, x.runId, block.kind, { state: x.to, enteredSeq: x.enteredSeq });
  }
  if (x.status === 'done' || x.status === 'stopped') {
    const called = await db.query(`select 1 from mw.case_links where child_run_id = $1 and kind = 'called' limit 1`, [x.runId]);
    if (called.rowCount) {
      // The child's outcome is the event that moved it into `end`; a child that stopped failed.
      await queue(db, x.runId, 'outcome', { outcome: x.status === 'done' ? x.event.type : 'failed' });
    }
  }
  if (x.status === 'stopped') {
    const children = await db.query(
      `select 1 from mw.case_links l join mw.runs r on r.id = l.child_run_id
        where l.parent_run_id = $1 and l.kind = 'called' and r.status = 'active' limit 1`, [x.runId]);
    if (children.rowCount) await queue(db, x.runId, 'cascade', {});
  }
}

const queue = (db: Queryable, runId: string, kind: string, payload: Record<string, unknown>) =>
  db.query(`insert into mw.run_outbox (run_id, kind, payload) values ($1, $2, $3)`, [runId, kind, JSON.stringify(payload)]);

interface OutboxRow { id: string; run_id: string; kind: string; payload: any; status: string; attempts: number }
interface RunNow { id: string; case_id: string; workflow_id: string; workflow_hash: string; state: string; status: RunStatus; entered_seq: number }

export function createHandoffs(deps: FlowDeps) {
  const { pool, client } = deps;

  const runNow = async (db: Queryable, runId: string, lock = false): Promise<RunNow | undefined> =>
    (await db.query(`select id, case_id, workflow_id, workflow_hash, state, status, entered_seq from mw.runs where id = $1${lock ? ' for update' : ''}`, [runId])).rows[0];
  /** The run is still in the entry the row was queued for. */
  const stillIn = (run: RunNow | undefined, state: string, enteredSeq: number): run is RunNow =>
    !!run && run.status === 'active' && run.state === state && run.entered_seq === enteredSeq;

  const send = (runId: string, event: RunEvent, idemKey: string, forSeq?: number) =>
    withTransaction(pool, (db) => sendInTx(db, client, runId, event, idemKey, forSeq));

  /** Stop a run with a plain reason (an outside `stop` the driver honours). */
  const stop = (run: RunNow, reason: string) =>
    send(run.id, { type: 'stop', reason }, `stop:${run.id}:${run.entered_seq}`, run.entered_seq);

  async function blockOf(run: RunNow, state: string): Promise<{ workflow: WorkflowDef; block?: BlockDef }> {
    const workflow = await loadWorkflowDef(pool, run.workflow_id, run.workflow_hash);
    return { workflow, block: workflow.states[state]?.block };
  }

  // ---------------------------------------------------------------- start, call, for_each

  async function handOff(row: OutboxRow): Promise<string> {
    const { state, enteredSeq } = row.payload as { state: string; enteredSeq: number };
    const run = await runNow(pool, row.run_id);
    if (!stillIn(run, state, enteredSeq)) return 'left';
    const { workflow, block } = await blockOf(run, state);
    if (!block || block.kind === 'wait_until') return 'done';
    const target = (await deps.workflows()).find((w) => w.id === block.workflow);
    if (!target) {
      await stop(run, `the playbook "${block.workflow}" that ${state} hands work to isn't there`);
      return 'done';
    }
    const from = domainOf(workflow);
    const to = domainOf(target);
    const domains = await deps.domains();
    if (from !== to && !domains[to]?.acceptsFrom?.includes(from)) {
      await stop(run, `${titleOf(target)} belongs to ${domainName(domains, to)}, which doesn't take work from ${domainName(domains, from)}`);
      return 'done';
    }
    const snapshot = await cases.get(pool, run.case_id);
    const values = snapshot?.values ?? {};
    const mode = block.kind === 'for_each' ? block.mode : block.kind === 'start' ? 'start' : 'call';
    let items: unknown[] = [undefined];
    if (block.kind === 'for_each') {
      const list = values[caseField(block.items)]?.value;
      items = Array.isArray(list) ? list : [];
    }
    for (let i = 0; i < items.length; i++) {
      const childRunId = derivedRunId(`${mode}:${run.id}:${enteredSeq}:${state}:${i}`);
      // The link first, so the child's end always finds its parent.
      await pool.query(
        `insert into mw.case_links (parent_run_id, parent_case_id, parent_state, entered_seq, item_index, child_run_id, child_workflow, kind)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
        [run.id, run.case_id, state, enteredSeq, i, childRunId, target.id, mode === 'start' ? 'started' : 'called']);
      crashPoint('handoff-before-start', state);
      try {
        const { caseId } = await deps.start({
          workflowId: target.id, workflowHash: target.hash, case: handoffValues(block.with, values, items[i]), runId: childRunId, by: `case:${run.case_id}`,
        });
        await pool.query(`update mw.case_links set child_case_id = $2 where child_run_id = $1`, [childRunId, caseId]);
      } catch (e) {
        if (!(e instanceof StartRunError)) throw e; // retried
        await pool.query(`update mw.case_links set outcome = 'failed', ended_at = now() where child_run_id = $1`, [childRunId]);
        await stop(run, `${titleOf(target)} could not start: ${Object.entries(e.errors).map(([f, m]) => `${f}: ${m.join('; ')}`).join(', ')}`);
        return 'done';
      }
    }
    crashPoint('handoff-before-send', state);
    if (mode === 'start') await send(run.id, { type: 'started' }, `started:${run.id}:${enteredSeq}`, enteredSeq);
    else if (block.kind === 'for_each') await join(run, state, enteredSeq, block);
    return 'done';
  }

  /** for_each with call: once the join is met (or can no longer be), `done` or `failed`. */
  async function join(run: RunNow, state: string, enteredSeq: number, block: Extract<BlockDef, { kind: 'for_each' }>) {
    const snapshot = await cases.get(pool, run.case_id);
    const list = snapshot?.values[caseField(block.items)]?.value;
    const total = Array.isArray(list) ? list.length : 0;
    const { rows } = await pool.query(
      `select outcome from mw.case_links where parent_run_id = $1 and entered_seq = $2 and parent_state = $3`, [run.id, enteredSeq, state]);
    const ended = rows.filter((r) => r.outcome !== null).length;
    const ok = rows.filter((r) => r.outcome !== null && r.outcome !== 'failed').length;
    const failed = ended - ok;
    const open = total - ended;
    let result: 'done' | 'failed' | undefined;
    if (block.join === 'all') result = failed > 0 ? 'failed' : open === 0 ? 'done' : undefined;
    else {
      const need = block.join === 'any' ? 1 : block.join;
      result = ok >= need ? 'done' : ok + open < need ? 'failed' : undefined;
    }
    if (result) await send(run.id, { type: result }, `join:${run.id}:${enteredSeq}`, enteredSeq);
  }

  // ---------------------------------------------------------------- a child's outcome

  async function outcome(row: OutboxRow): Promise<string> {
    const ended = String(row.payload.outcome);
    const { rows: links } = await pool.query(`select * from mw.case_links where child_run_id = $1 and kind = 'called'`, [row.run_id]);
    for (const link of links) {
      await pool.query(`update mw.case_links set outcome = $2, ended_at = now() where child_run_id = $1 and outcome is null`, [row.run_id, ended]);
      const parent = await runNow(pool, link.parent_run_id);
      if (!stillIn(parent, link.parent_state, link.entered_seq)) continue;
      const { workflow, block } = await blockOf(parent, link.parent_state);
      if (block?.kind === 'for_each') { await join(parent, link.parent_state, link.entered_seq, block); continue; }
      if (block?.kind !== 'call') continue;
      if (!workflow.states[link.parent_state]!.on[ended]) {
        await stop(parent, `${link.child_workflow} ended with "${ended}", and ${link.parent_state} has no way on from that`);
        continue;
      }
      await withTransaction(pool, async (db) => {
        const locked = await runNow(db, parent.id, true);
        if (!stillIn(locked, link.parent_state, link.entered_seq)) return;
        if (ended !== 'failed' && Object.keys(block.returns).length) {
          const child = await cases.get(db, link.child_case_id);
          const childWf = await childWorkflow(db, link.child_run_id);
          const at = new Date().toISOString();
          const writes: Record<string, CaseValue> = {};
          for (const [mine, theirs] of Object.entries(block.returns)) {
            const path = theirs.startsWith('case.') ? theirs.slice(5) : theirs;
            const [head, ...rest] = path.split('.');
            const value = pathValue(child?.values[head!]?.value, rest.join('.'));
            if (value === undefined) continue;
            writes[mine] = { value, provenance: { kind: 'system', at, note: `from ${childWf ? titleOf(childWf) : link.child_workflow} case ${link.child_case_id}` } };
          }
          if (Object.keys(writes).length) await cases.applyWrites(db, parent.case_id, writes);
        }
        await sendInTx(db, client, parent.id, { type: ended }, `outcome:${parent.id}:${link.entered_seq}`, link.entered_seq);
      });
    }
    return 'done';
  }

  async function childWorkflow(db: Queryable, runId: string): Promise<WorkflowDef | undefined> {
    const r = (await db.query(`select workflow_id, workflow_hash from mw.runs where id = $1`, [runId])).rows[0];
    return r ? loadWorkflowDef(db, r.workflow_id, r.workflow_hash).catch(() => undefined) : undefined;
  }

  /** A stopped run stops the children it called (and fanned out with call) that are still active. */
  async function cascade(row: OutboxRow): Promise<string> {
    const { rows } = await pool.query(
      `select l.child_run_id from mw.case_links l join mw.runs r on r.id = l.child_run_id
        where l.parent_run_id = $1 and l.kind = 'called' and r.status = 'active' order by l.entered_seq, l.item_index`, [row.run_id]);
    for (const r of rows) {
      await send(r.child_run_id, { type: 'stop', reason: 'the case that called it was stopped' }, `cascade:${r.child_run_id}`);
    }
    return 'done';
  }

  // ---------------------------------------------------------------- wait_until

  /** The record a wait_until state watches, from its Ref case field. */
  async function waitTarget(run: RunNow, state: string) {
    const { workflow, block } = await blockOf(run, state);
    if (block?.kind !== 'wait_until') return undefined;
    const field = caseField(block.record);
    const snapshot = await cases.get(pool, run.case_id);
    const recordId = snapshot?.values[field]?.value;
    const entity = refTarget(workflow, workflow.caseType.fields[field]?.type, deps.entities());
    return { block, entity, recordId: typeof recordId === 'string' ? recordId : undefined };
  }

  async function checkWait(row: OutboxRow): Promise<string> {
    const { state, enteredSeq } = row.payload as { state: string; enteredSeq: number };
    const run = await runNow(pool, row.run_id);
    if (!stillIn(run, state, enteredSeq)) return 'left';
    const target = await waitTarget(run, state);
    if (!target) return 'done';
    if (target.entity && target.recordId) {
      const r = await deps.evaluate(target.entity, target.recordId, target.block.condition);
      if (r.holds) {
        await send(run.id, { type: 'met' }, `met:${run.id}:${enteredSeq}`, enteredSeq);
        return 'done';
      }
    }
    await pool.query(`update mw.run_outbox set payload = payload || $2 where id = $1`,
      [row.id, JSON.stringify({ entity: target.entity ?? null, recordId: target.recordId ?? null })]);
    return 'waiting';
  }

  /** The `waits` consumer: re-check the waits on the event's record. */
  const waits: EventConsumer = {
    name: 'waits',
    async handle(event) {
      const { rows } = await pool.query<OutboxRow>(
        `select * from mw.run_outbox where status = 'waiting' and kind = 'wait_until'
            and payload ->> 'entity' = $1 and payload ->> 'recordId' = $2 order by id`, [event.entity, event.recordId]);
      for (const row of rows) await finish(row, await checkWait(row));
    },
  };

  // ---------------------------------------------------------------- the worker

  async function finish(row: OutboxRow, status: string) {
    if (status === row.status) return;
    await pool.query(`update mw.run_outbox set status = $2, done_at = case when $2 = 'waiting' then null else now() end, error = null where id = $1`,
      [row.id, status]);
  }

  async function perform(row: OutboxRow): Promise<string> {
    switch (row.kind) {
      case 'start': case 'call': case 'for_each': return handOff(row);
      case 'wait_until': return checkWait(row);
      case 'outcome': return outcome(row);
      case 'cascade': return cascade(row);
      default: return 'done';
    }
  }

  return {
    waits,

    /** Pending outbox rows, oldest first; true when it did any. */
    async work(): Promise<boolean> {
      const { rows } = await pool.query<OutboxRow>(
        `select * from mw.run_outbox where status = 'pending' and attempts < $1 order by id limit $2`, [MAX_ATTEMPTS, BATCH]);
      let did = false;
      for (const row of rows) {
        try {
          await finish(row, await perform(row));
          did = true;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          deps.log?.(`hand-off ${row.kind} of ${row.run_id} failed (try ${row.attempts + 1}): ${message}`);
          const r = await pool.query(
            `update mw.run_outbox set attempts = attempts + 1, error = $2, status = case when attempts + 1 >= $3 then 'failed' else status end
              where id = $1 returning status`, [row.id, message, MAX_ATTEMPTS]);
          const run = r.rows[0]?.status === 'failed' && row.payload?.state ? await runNow(pool, row.run_id) : undefined;
          if (run && stillIn(run, row.payload.state, row.payload.enteredSeq)) await stop(run, `the hand-off in ${row.payload.state} kept failing: ${message}`);
        }
      }
      return did;
    },

    async pending(): Promise<boolean> {
      const { rows } = await pool.query(`select 1 from mw.run_outbox where status = 'pending' and attempts < $1 limit 1`, [MAX_ATTEMPTS]);
      return rows.length > 0;
    },

    /** The case view's links (24 §8): the cases this one started or called, and the one that started or called it. */
    async links(caseId: string, workflow: (id: string, hash: string) => Promise<WorkflowDef>): Promise<CaseLinkView[]> {
      const { rows } = await pool.query(
        `select 'down' as dir, l.kind, l.created_at, r.id as run_id, r.case_id, r.workflow_id, r.workflow_hash, r.state, r.status
           from mw.case_links l join mw.runs r on r.id = l.child_run_id where l.parent_case_id = $1
         union all
         select 'up', l.kind, l.created_at, r.id, r.case_id, r.workflow_id, r.workflow_hash, r.state, r.status
           from mw.case_links l join mw.runs r on r.id = l.parent_run_id where l.child_case_id = $1
         order by 3, 4`, [caseId]);
      const out: CaseLinkView[] = [];
      for (const r of rows) {
        const wf = await workflow(r.workflow_id, r.workflow_hash).catch(() => undefined);
        out.push({
          kind: r.dir === 'down' ? r.kind : r.kind === 'called' ? 'called_by' : 'started_by',
          caseId: r.case_id, runId: r.run_id, workflowId: r.workflow_id, title: wf ? titleOf(wf) : r.workflow_id, state: r.state, status: r.status,
        });
      }
      return out;
    },

    /** The case view's `waiting` (24 §14): the condition a run in a wait_until state waits on, evaluated now. */
    async waiting(runId: string): Promise<WaitingCondition | undefined> {
      const run = await runNow(pool, runId);
      if (!run || run.status !== 'active' || run.state === END_STATE) return undefined;
      const target = await waitTarget(run, run.state);
      if (!target?.entity || !target.recordId) return undefined;
      const def = deps.entities()[target.entity];
      if (!def) return undefined;
      const record = await recordRef(pool, def, target.entity, target.recordId);
      if (!record) return undefined;
      const r = await deps.evaluate(target.entity, target.recordId, target.block.condition).catch(() => undefined);
      return { record, condition: target.block.condition, holds: r?.holds ?? false, values: r?.values ?? {} };
    },
  };
}

export type Handoffs = ReturnType<typeof createHandoffs>;
