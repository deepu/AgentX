import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CaseValue, IndexedDefinition, JournalEntry, StepRecord, StepToken, WorkflowDef } from '@memwise/defs';
import {
  createTestDatabase, PgApprovalStore, PgCaseStore, PgDefinitionStore, PgEffectLedger, PgStepRecorder,
  PgStepRecordReader, postgresAvailable, withTransaction, type TestDatabase,
} from '../src/index.ts';

const at = '2026-10-20T10:00:00.000Z';
const input = (value: unknown): CaseValue => ({ value, provenance: { kind: 'input', at } });

describe.skipIf(!postgresAvailable())('stores', () => {
  let db: TestDatabase;
  const cases = new PgCaseStore();

  beforeAll(async () => { db = await createTestDatabase('mw_stores'); }, 60_000);
  afterAll(() => db?.drop());

  /** A case plus the run row that step runs point at. */
  async function seedRun(caseId: string, values: Record<string, CaseValue> = {}) {
    await cases.create(db.pool, { id: caseId, caseType: 'ClientIntake', workflowId: 'client-intake', workflowHash: 'h1', values });
    const runId = `run_${caseId}`;
    await db.pool.query(
      `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id)
       values ($1, 'client-intake', 1, 'h1', $2, 'check', 'active', '{}', $1) on conflict do nothing`, [runId, caseId]);
    return runId;
  }

  function token(runId: string, caseId: string, stepRunId: string): StepToken {
    return { runId, caseId, stepId: 'check', stepRunId, workflowId: 'client-intake', workflowVersion: 1, agentRole: 'intake.check', issuedAt: at, expiresAt: at };
  }

  async function count(table: string) {
    return (await db.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
  }

  // ---------------------------------------------------------------- definitions

  test('definitions: upsert is idempotent; exact and latest lookups', async () => {
    const store = new PgDefinitionStore(db.pool);
    const wf = (hash: string, version: number): IndexedDefinition => ({
      kind: 'workflow', id: 'client-intake', hash, version, path: 'workflows/client-intake', body: { id: 'client-intake', version, hash } });
    const refs = [{ fromKind: 'workflow' as const, fromId: 'client-intake', fromHash: 'a', toKind: 'tool' as const, toId: 'gst.validate_gstin' }];

    await store.upsert([wf('a', 1)], refs);
    const before = (await db.pool.query(`select indexed_at from mw.definitions where hash = 'a'`)).rows[0].indexed_at;
    await store.upsert([wf('a', 1)], refs);
    expect(await count('mw.definitions')).toBe(1);
    expect(await count('mw.definition_refs')).toBe(1);
    expect((await db.pool.query(`select indexed_at from mw.definitions where hash = 'a'`)).rows[0].indexed_at).toEqual(before);

    await store.upsert([wf('b', 2)], []);
    expect(((await store.latestWorkflow('client-intake')) as unknown as { hash: string }).hash).toBe('b');
    expect(((await store.getWorkflow('client-intake', 'a')) as unknown as { hash: string }).hash).toBe('a');
    expect(await store.getWorkflow('client-intake', 'zzz')).toBeUndefined();
    expect(await store.latestWorkflow('nope')).toBeUndefined();

    // Reverting the file to an earlier hash makes that hash the latest again.
    await store.upsert([wf('a', 1)], []);
    expect(((await store.latestWorkflow('client-intake')) as WorkflowDef & { hash: string }).hash).toBe('a');
  });

  // ---------------------------------------------------------------- effect ledger

  test('ledger: new → pending → done, and done returns the stored result', async () => {
    const ledger = new PgEffectLedger(db.pool);
    const entry = { stepRunId: 'sr1', tool: 'mail.send', effect: 'outbound' as const, args: ['to@x.com'] };
    expect(await ledger.begin('sr1:1', entry)).toEqual({ status: 'new' });
    const pending = await ledger.begin('sr1:1', entry);
    expect(pending.status).toBe('pending');
    expect(pending.status === 'pending' && !Number.isNaN(Date.parse(pending.startedAt))).toBe(true);

    await ledger.complete('sr1:1', { messageId: 'm1' });
    expect(await ledger.begin('sr1:1', entry)).toEqual({ status: 'done', result: { messageId: 'm1' } });
    // A second completion, or a late failure, never changes a done effect.
    await ledger.complete('sr1:1', { messageId: 'other' });
    await ledger.fail('sr1:1', 'late');
    expect(await ledger.begin('sr1:1', entry)).toEqual({ status: 'done', result: { messageId: 'm1' } });
    const { rows } = await db.pool.query(`select args from mw.effects where idempotency_key = 'sr1:1'`);
    expect(rows[0].args).toEqual(['to@x.com']); // stored as JSON, not a Postgres array
  });

  test('ledger: a failed key reports failure, then can be re-claimed', async () => {
    const ledger = new PgEffectLedger(db.pool);
    const entry = { stepRunId: 'sr1', tool: 'mail.send', effect: 'outbound' as const, args: {} };
    expect(await ledger.begin('sr1:2', entry)).toEqual({ status: 'new' });
    await ledger.fail('sr1:2', 'smtp down');
    const { rows } = await db.pool.query(`select status, error from mw.effects where idempotency_key = 'sr1:2'`);
    expect(rows[0]).toEqual({ status: 'failed', error: 'smtp down' });
    expect(await ledger.begin('sr1:2', entry)).toEqual({ status: 'new' });
    expect((await ledger.begin('sr1:2', entry)).status).toBe('pending');
    await expect(ledger.complete('missing', 1)).rejects.toThrow(/no effect was begun/);
  });

  test('ledger: concurrent begins on one key give exactly one owner', async () => {
    const ledger = new PgEffectLedger(db.pool);
    const entry = { stepRunId: 'sr1', tool: 't', effect: 'write' as const, args: null };
    const states = await Promise.all([0, 1, 2, 3, 4].map(() => ledger.begin('sr1:race', entry)));
    expect(states.filter((s) => s.status === 'new')).toHaveLength(1);
  });

  // ---------------------------------------------------------------- cases

  test('cases: create is idempotent; writes bump seq once per batch and log every field', async () => {
    const created = await cases.create(db.pool, { id: 'case_a', caseType: 'ClientIntake', workflowId: 'client-intake', workflowHash: 'h1', values: { name: input('Asha'), gstin: input(null) } });
    expect(created).toEqual({ id: 'case_a', caseType: 'ClientIntake', seq: 1, values: { name: input('Asha'), gstin: input(null) } });
    const again = await cases.create(db.pool, { id: 'case_a', caseType: 'ClientIntake', workflowId: 'client-intake', workflowHash: 'h1', values: { name: input('Other') } });
    expect(again).toEqual(created);

    const judged: CaseValue = { value: 'ok', provenance: { kind: 'judgement', at, stepRunId: 'sr-a', rationale: 'looks fine' } };
    const after = await withTransaction(db.pool, (c) => cases.applyWrites(c, 'case_a', { gstin: input('29ABCDE1234F1Z5'), verdict: judged }, 'sr-a'));
    expect(after.seq).toBe(2);
    expect(after.values).toEqual({ name: input('Asha'), gstin: input('29ABCDE1234F1Z5'), verdict: judged });
    expect((await cases.applyWrites(db.pool, 'case_a', {})).seq).toBe(2);

    const history = await cases.history(db.pool, 'case_a');
    expect(history.map((e) => [e.seq, e.field, e.value, e.stepRunId])).toEqual([
      [1, 'gstin', null, undefined], [1, 'name', 'Asha', undefined],
      [2, 'gstin', '29ABCDE1234F1Z5', 'sr-a'], [2, 'verdict', 'ok', 'sr-a'],
    ]);
    expect(history[3]!.provenance).toEqual(judged.provenance);
    expect(await cases.get(db.pool, 'case_missing')).toBeUndefined();
    await expect(cases.applyWrites(db.pool, 'case_missing', { a: input(1) })).rejects.toThrow(/No case/);
  });

  test('cases: writes roll back with the caller\'s transaction', async () => {
    await cases.create(db.pool, { id: 'case_tx', caseType: 'ClientIntake', workflowId: 'client-intake', workflowHash: 'h1', values: {} });
    await expect(withTransaction(db.pool, async (c) => {
      await cases.applyWrites(c, 'case_tx', { a: input(1) });
      throw new Error('commit lost');
    })).rejects.toThrow('commit lost');
    expect(await cases.get(db.pool, 'case_tx')).toEqual({ id: 'case_tx', caseType: 'ClientIntake', seq: 0, values: {} });
    expect(await cases.history(db.pool, 'case_tx')).toEqual([]);
  });

  // ---------------------------------------------------------------- step records

  test('step recorder: every call is idempotent; reader returns the record and its journal', async () => {
    const runId = await seedRun('case_s');
    const id = `${runId}/1/check`;
    const rec = new PgStepRecorder(db.pool);
    const reader = new PgStepRecordReader(db.pool);
    const start = { stepRunId: id, runId, caseId: 'case_s', stepId: 'check', attempt: 1, workflowId: 'client-intake', workflowVersion: 1, workflowHash: 'h1', stepHash: 's1', performer: 'agent' as const, token: token(runId, 'case_s', id), startedAt: at };
    const context = { systemPrompt: 'Check the answers', tools: [], pushed: { name: input('Asha') }, priorAttempts: [], modelRole: 'default', hash: 'ctx1' };
    const j1: JournalEntry = { stepRunId: id, journalKey: 'model#1', kind: 'model', name: 'default', request: { messages: [] }, response: { text: 'hi' }, model: { provider: 'scripted', model: 'm', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: 'stop' }, attempt: 1, startedAt: '2026-10-20T10:00:01.000Z', durationMs: 5 };
    const j2: JournalEntry = { stepRunId: id, journalKey: 'tool#2', kind: 'tool', name: 'mail.send', callId: 'c1', request: { to: 'a' }, effect: 'outbound', startedAt: '2026-10-20T10:00:02.000Z' };
    const approval = { id: `${id}:c1`, stepRunId: id, tool: 'mail.send', effect: 'outbound' as const, treatment: 'approve' as const, args: { to: 'a' }, preview: { summary: 'Send mail to a' }, requestedAt: at };

    for (let i = 0; i < 2; i++) {
      await rec.start(start);
      await rec.context(id, context);
      await rec.journal(j2);
      await rec.journal(j1);
      await rec.approvalRequested(approval);
      await rec.status(id, 'waiting');
    }
    expect(await count('mw.step_journal')).toBe(2);
    expect(await count('mw.approvals')).toBe(1);

    const running = await reader.get(id);
    expect(running?.status).toBe('waiting');
    expect(running?.context).toEqual(context);
    expect(running?.finishedAt).toBeUndefined();
    expect(running?.usage).toEqual({ tokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 });
    expect(running?.journal).toEqual([j1, j2]);

    const finished: StepRecord = { ...start, status: 'completed', outcome: 'complete', context, outputs: { verdict: input('ok') }, checkpoint: [{ rule: 'has verdict', kind: 'structural', passed: true }], rationale: 'all good', usage: { tokens: 3, modelCalls: 1, toolCalls: 1, durationMs: 9 }, tainted: false, finishedAt: '2026-10-20T10:00:03.000Z' };
    await rec.finish(finished);
    await rec.finish({ ...finished, finishedAt: '2026-10-20T11:00:00.000Z' });
    await rec.status(id, 'running'); // too late: ignored
    const { journal, ...record } = (await reader.get(id))!;
    expect(record).toEqual(finished);
    expect(await reader.forCase('case_s')).toEqual([finished]);
    expect(await reader.get('nope')).toBeUndefined();
  });

  test('similar: ranks by matching case values, then recency, excluding a case', async () => {
    const rec = new PgStepRecorder(db.pool);
    const reader = new PgStepRecordReader(db.pool);
    const make = async (caseId: string, values: Record<string, unknown>, finishedAt: string | undefined) => {
      const runId = await seedRun(caseId, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, input(v)])));
      const id = `${runId}/1/check`;
      const base = { stepRunId: id, runId, caseId, stepId: 'check', attempt: 1, workflowId: 'client-intake', workflowVersion: 1, workflowHash: 'h1', stepHash: 's1', performer: 'agent' as const, token: token(runId, caseId, id), startedAt: at };
      if (finishedAt) await rec.finish({ ...base, status: 'completed', outcome: 'complete', outputs: {}, checkpoint: [], usage: { tokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0 }, tainted: false, finishedAt });
      else await rec.start(base);
    };
    await make('sim_both', { state: 'KA', type: 'llp' }, '2026-10-01T00:00:00.000Z');
    await make('sim_one_old', { state: 'KA', type: 'pvt' }, '2026-10-02T00:00:00.000Z');
    await make('sim_one_new', { state: 'MH', type: 'llp' }, '2026-10-03T00:00:00.000Z');
    await make('sim_none', { state: 'TN', type: 'pvt' }, '2026-10-04T00:00:00.000Z');
    await make('sim_unfinished', { state: 'KA', type: 'llp' }, undefined);
    await make('sim_self', { state: 'KA', type: 'llp' }, '2026-10-05T00:00:00.000Z');

    const found = await reader.similar({ workflowId: 'client-intake', stepId: 'check', caseValues: { state: 'KA', type: 'llp' }, excludeCaseId: 'sim_self', limit: 10 });
    const ids = found.map((r) => r.caseId).filter((c) => c.startsWith('sim_'));
    expect(ids).toEqual(['sim_both', 'sim_one_new', 'sim_one_old', 'sim_none']);
    const top2 = await reader.similar({ workflowId: 'client-intake', stepId: 'check', caseValues: { state: 'KA', type: 'llp' }, limit: 2 });
    expect(top2.map((r) => r.caseId)).toEqual(['sim_self', 'sim_both']);
    expect(await reader.similar({ workflowId: 'other', stepId: 'check', caseValues: {}, limit: 5 })).toEqual([]);
  });

  // ---------------------------------------------------------------- approvals

  test('approvals: pending list, and a decision lands only once', async () => {
    const rec = new PgStepRecorder(db.pool);
    const approvals = new PgApprovalStore(db.pool);
    for (const [id, requestedAt] of [['ap:2', '2026-10-20T10:00:02.000Z'], ['ap:1', '2026-10-20T10:00:01.000Z']] as const) {
      await rec.approvalRequested({ id, stepRunId: 'ap', tool: 'mail.send', effect: 'outbound', treatment: 'approve', args: { n: id }, preview: { summary: id, detail: { to: 'x' } }, requestedAt });
    }
    expect((await approvals.pending()).filter((a) => a.id.startsWith('ap:')).map((a) => a.id)).toEqual(['ap:1', 'ap:2']);

    const decision = { id: 'ap:1', status: 'approved' as const, by: 'manager@firm', comment: 'go', at: '2026-10-20T10:05:00.000Z' };
    expect(await approvals.decide(db.pool, decision)).toBe(true);
    expect(await approvals.decide(db.pool, { ...decision, status: 'rejected', by: 'someone-else' })).toBe(false);
    expect(await approvals.decide(db.pool, { ...decision, id: 'ap:missing' })).toBe(false);

    expect(await approvals.get('ap:1')).toEqual({
      id: 'ap:1', stepRunId: 'ap', tool: 'mail.send', effect: 'outbound', treatment: 'approve', args: { n: 'ap:1' },
      preview: { summary: 'ap:1', detail: { to: 'x' } }, requestedAt: '2026-10-20T10:00:01.000Z',
      status: 'approved', decidedBy: 'manager@firm', comment: 'go', decidedAt: '2026-10-20T10:05:00.000Z',
    });
    expect((await approvals.pending()).map((a) => a.id)).not.toContain('ap:1');
    expect(await approvals.get('ap:missing')).toBeUndefined();
  });
});
