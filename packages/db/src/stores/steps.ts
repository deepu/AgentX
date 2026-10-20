/** Step records (05 §11): the writer a running step uses, and the reader for recall and the CLI. */
import type {
  ApprovalRequest, AssembledContext, JournalEntry, StepRecord, StepRecordReader, StepRecorder, StepRunStatus,
} from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';

/** Every method is idempotent on its key: a resumed step may repeat calls already recorded. */
export class PgStepRecorder implements StepRecorder {
  constructor(private readonly db: Queryable) {}

  async start(r: Parameters<StepRecorder['start']>[0]): Promise<void> {
    await this.db.query(
      `insert into mw.step_runs (id, run_id, case_id, step_id, attempt, workflow_id, workflow_version, workflow_hash,
         step_hash, performer, status, token, started_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running', $11, $12)
       on conflict (id) do nothing`,
      [r.stepRunId, r.runId, r.caseId, r.stepId, r.attempt, r.workflowId, r.workflowVersion, r.workflowHash,
        r.stepHash, r.performer, json(r.token), r.startedAt],
    );
  }

  async context(stepRunId: string, context: AssembledContext): Promise<void> {
    await this.db.query('update mw.step_runs set context = $2 where id = $1', [stepRunId, json(context)]);
  }

  async journal(e: JournalEntry): Promise<void> {
    await this.db.query(
      `insert into mw.step_journal (step_run_id, journal_key, kind, name, call_id, request, response, error, effect,
         model, attempt, started_at, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (step_run_id, journal_key) do nothing`,
      [e.stepRunId, e.journalKey, e.kind, e.name, e.callId ?? null, json(e.request), json(e.response), e.error ?? null,
        e.effect ?? null, json(e.model), e.attempt ?? null, e.startedAt, e.durationMs ?? null],
    );
  }

  async approvalRequested(a: ApprovalRequest): Promise<void> {
    await this.db.query(
      `insert into mw.approvals (id, step_run_id, tool, effect, treatment, args, preview, status, requested_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       on conflict (id) do nothing`,
      [a.id, a.stepRunId, a.tool, a.effect, a.treatment, json(a.args), json(a.preview), a.requestedAt],
    );
  }

  /** Ignored once the step run has finished, so a late repeat can't reopen it. */
  async status(stepRunId: string, status: StepRunStatus): Promise<void> {
    await this.db.query('update mw.step_runs set status = $2 where id = $1 and finished_at is null', [stepRunId, status]);
  }

  /** Writes the whole record (inserting it if `start` was never recorded). The first finish time stands. */
  async finish(r: StepRecord): Promise<void> {
    await this.db.query(
      `insert into mw.step_runs (id, run_id, case_id, step_id, attempt, workflow_id, workflow_version, workflow_hash,
         step_hash, performer, status, outcome, token, context, outputs, checkpoint, rationale, usage, tainted,
         started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, coalesce($21, now()))
       on conflict (id) do update set
         status = excluded.status, outcome = excluded.outcome,
         context = coalesce(excluded.context, mw.step_runs.context),
         outputs = excluded.outputs, checkpoint = excluded.checkpoint, rationale = excluded.rationale,
         usage = excluded.usage, tainted = excluded.tainted,
         finished_at = coalesce(mw.step_runs.finished_at, excluded.finished_at)`,
      [r.stepRunId, r.runId, r.caseId, r.stepId, r.attempt, r.workflowId, r.workflowVersion, r.workflowHash,
        r.stepHash, r.performer, r.status, r.outcome ?? null, json(r.token), json(r.context), json(r.outputs ?? {}),
        json(r.checkpoint ?? []), r.rationale ?? null, json(r.usage), r.tainted, r.startedAt, r.finishedAt ?? null],
    );
  }
}

export class PgStepRecordReader implements StepRecordReader {
  constructor(private readonly db: Queryable) {}

  async get(stepRunId: string): Promise<(StepRecord & { journal: JournalEntry[] }) | undefined> {
    const { rows } = await this.db.query<StepRunRow>('select * from mw.step_runs where id = $1', [stepRunId]);
    if (!rows[0]) return undefined;
    const journal = await this.db.query<JournalRow>(
      'select * from mw.step_journal where step_run_id = $1 order by started_at, journal_key', [stepRunId]);
    return { ...toStepRecord(rows[0]), journal: journal.rows.map(toJournalEntry) };
  }

  async forCase(caseId: string): Promise<StepRecord[]> {
    const { rows } = await this.db.query<StepRunRow>(
      'select * from mw.step_runs where case_id = $1 order by started_at, id', [caseId]);
    return rows.map(toStepRecord);
  }

  /**
   * Finished runs of the same step on other cases. Phase 1 similarity: how many of the given
   * case values the other case has exactly (compared as JSON), then the most recent.
   */
  async similar(opts: { workflowId: string; stepId: string; caseValues: Record<string, unknown>; excludeCaseId?: string; limit: number }): Promise<StepRecord[]> {
    const { rows } = await this.db.query<StepRunRow>(
      `select sr.*,
         (select count(*) from jsonb_each($3::jsonb) as want
          where c.values -> want.key -> 'value' = want.value) as score
       from mw.step_runs sr join mw.cases c on c.id = sr.case_id
       where sr.workflow_id = $1 and sr.step_id = $2 and sr.finished_at is not null
         and ($4::text is null or sr.case_id <> $4)
       order by score desc, sr.finished_at desc, sr.id
       limit $5`,
      [opts.workflowId, opts.stepId, json(opts.caseValues ?? {}), opts.excludeCaseId ?? null, opts.limit],
    );
    return rows.map(toStepRecord);
  }
}

// ---------------------------------------------------------------- rows

interface StepRunRow {
  id: string; run_id: string; case_id: string; step_id: string; attempt: number;
  workflow_id: string; workflow_version: number; workflow_hash: string; step_hash: string;
  performer: StepRecord['performer']; status: StepRunStatus; outcome: string | null;
  token: StepRecord['token']; context: AssembledContext | null; outputs: StepRecord['outputs'];
  checkpoint: StepRecord['checkpoint']; rationale: string | null; usage: Partial<StepRecord['usage']>;
  tainted: boolean; started_at: Date; finished_at: Date | null;
}

interface JournalRow {
  step_run_id: string; journal_key: string; kind: JournalEntry['kind']; name: string; call_id: string | null;
  request: unknown; response: unknown; error: string | null; effect: JournalEntry['effect'] | null;
  model: JournalEntry['model'] | null; attempt: number | null; started_at: Date; duration_ms: number | null;
}

function toStepRecord(r: StepRunRow): StepRecord {
  return {
    stepRunId: r.id, runId: r.run_id, caseId: r.case_id, stepId: r.step_id, attempt: r.attempt,
    workflowId: r.workflow_id, workflowVersion: r.workflow_version, workflowHash: r.workflow_hash, stepHash: r.step_hash,
    performer: r.performer, status: r.status, token: r.token, outputs: r.outputs, checkpoint: r.checkpoint,
    // A step run that has not finished has an empty usage object.
    usage: { tokens: 0, modelCalls: 0, toolCalls: 0, durationMs: 0, ...r.usage },
    tainted: r.tainted, startedAt: iso(r.started_at),
    ...compact({ outcome: r.outcome, context: r.context, rationale: r.rationale, finishedAt: iso(r.finished_at) }),
  };
}

function toJournalEntry(r: JournalRow): JournalEntry {
  return {
    stepRunId: r.step_run_id, journalKey: r.journal_key, kind: r.kind, name: r.name, request: r.request, startedAt: iso(r.started_at),
    ...compact({ callId: r.call_id, response: r.response, error: r.error, effect: r.effect, model: r.model, attempt: r.attempt, durationMs: r.duration_ms }),
  };
}
