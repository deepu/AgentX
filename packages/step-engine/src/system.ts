/**
 * System (mechanical) steps (19 §4): no model. Each required tool is called in order, with the
 * arguments the step's `map` gives, through the same gateway as an agent's calls (policy check,
 * approval wait, effect ledger), and the writes are read from the results by `from: { tool, field }`.
 * One DBOS workflow per step run, with stable step names:
 *
 *   record.start, then per tool: policy:<tool> → [approval.request/answer:<tool>] → tool:<tool>,
 *   record.finish
 *
 * The outcome is the step's only one, or with `outcomeFrom: { tool, field }` (Phase 3) that field
 * of that tool's result, which must be one of the step's outcomes.
 *
 * The idempotency key of a call is `${stepRunId}:${tool}`, so a crash between the call and the
 * commit replays the call from the ledger instead of repeating its effect.
 *
 * Literature (25 §3): a tool whose `map` says `each: case.<List field>` is called once per item,
 * in order, with `item.<path>` beside `case.<path>`; its calls are `<tool>:<index>` (step names
 * and the idempotency key `${stepRunId}:${tool}:${index}`), and a write from it gets the list of
 * results. `{ today: n }` and `{ now: true }` are read from the step run's start, so a replay
 * maps the same arguments.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  crashPoint, systemOutcome, validateValue, type ApprovalDecision, type ApprovalRequest, type ArgSource, type CaseSnapshot,
  type CaseValue, type JournalEntry, type StepRecord,
} from '@memwise/defs';
import type { GatewayCallResult, GatewayDecision } from '@memwise/gateway';
import { engineDeps } from './deps.ts';
import { approvalTopic, type StepResult, type StepResultStatus, type StepRunInput } from './types.ts';

export const SYSTEM_STEP_WORKFLOW = 'memwise.step.system';

const APPROVAL_WAIT_SECONDS = 7 * 24 * 3600;
const isCancel = (e: unknown) => e instanceof Error && /cancel/i.test(e.name);

/** The value at a dotted path, or undefined. */
export function valueAt(v: unknown, path: string | undefined): unknown {
  if (!path) return v;
  let cur = v;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** A case path (`documents`, `topic.name`): the value of its first field, then the rest of the path. */
export function caseValueAt(snapshot: CaseSnapshot, path: string): unknown {
  const [head, ...rest] = path.split('.');
  return valueAt(snapshot.values[head!]?.value, rest.join('.') || undefined);
}

/** `YYYY-MM-DD` of `at` plus `days`, in the local time zone. */
export function localDate(at: Date, days = 0): string {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A tool's arguments from the step's `map`: `case.<path>` reads the case, `item.<path>` the item
 * of an `each:` call, `{ today: n }` and `{ now: true }` the clock `at` (absent values are left out).
 */
export function mapArgs(map: Record<string, ArgSource> | undefined, snapshot: CaseSnapshot, opts: { item?: unknown; at?: Date } = {}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const at = opts.at ?? new Date();
  for (const [arg, src] of Object.entries(map ?? {})) {
    let v: unknown;
    if ('case' in src) v = caseValueAt(snapshot, src.case);
    else if ('item' in src) v = valueAt(opts.item, src.item || undefined);
    else if ('today' in src) v = localDate(at, src.today);
    else if ('now' in src) v = at.toISOString();
    else v = src.value;
    if (v !== undefined && ('value' in src || v !== null)) args[arg] = v;
  }
  return args;
}

const failure = (r: GatewayCallResult) => (r.status === 'error' ? r.error : r.status === 'ok' ? '' : r.reason);

export async function systemStepWorkflow(input: StepRunInput): Promise<StepResult> {
  const deps = engineDeps();
  const { step } = input;
  const t0 = input.startedAt;
  const journal = (entry: Omit<JournalEntry, 'stepRunId'>) => deps.recorder.journal({ stepRunId: input.stepRunId, ...entry });
  let toolCalls = 0;
  let activeMs = 0;
  // Arguments mapped from tainted case values make the calls tainted (07 §6).
  let tainted = input.tainted === true;
  /** By tool: its result, or with `each` the list of its results in item order. */
  const results: Record<string, { result: unknown; callId: string; tainted: boolean; each?: boolean }> = {};

  await DBOS.runStep(() => deps.recorder.start({
    stepRunId: input.stepRunId, runId: input.runId, caseId: input.case.id, stepId: step.id, attempt: input.attempt,
    workflowId: input.workflow.id, workflowVersion: input.workflow.version, workflowHash: input.workflow.hash,
    stepHash: step.hash, performer: step.performer, token: input.token, startedAt: new Date(t0).toISOString(),
  }), { name: 'record.start' });

  const finish = async (status: StepResultStatus, reason?: string, writes: Record<string, CaseValue> = {}, chosen?: string): Promise<StepResult> => {
    const outcome = status === 'completed' ? (chosen ?? systemOutcome(step)) : status;
    const usage = { tokens: 0, modelCalls: 0, toolCalls };
    const { durationMs } = await DBOS.runStep(async () => {
      const finishedAt = Date.now();
      if (reason) {
        await journal({ journalKey: 'record.finish', kind: 'checkpoint', name: 'stop', request: { status }, error: reason, startedAt: new Date(finishedAt).toISOString() });
      }
      const record: StepRecord = {
        stepRunId: input.stepRunId, runId: input.runId, caseId: input.case.id, stepId: step.id, attempt: input.attempt,
        workflowId: input.workflow.id, workflowVersion: input.workflow.version, workflowHash: input.workflow.hash,
        stepHash: step.hash, performer: step.performer, status, outcome, token: input.token, outputs: writes, checkpoint: [],
        ...(reason ? { rationale: reason } : {}),
        usage: { ...usage, durationMs: activeMs }, tainted, startedAt: new Date(t0).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
      };
      await deps.recorder.finish(record);
      return { durationMs: activeMs };
    }, { name: 'record.finish' });
    return {
      stepRunId: input.stepRunId, status, outcome, writes, checkpoint: [], usage: { ...usage, durationMs }, tainted,
      ...(reason ? { reason, rationale: reason } : {}),
    };
  };

  const at0 = new Date(t0);
  for (const tool of step.tools.required) {
    // Once, or once per item of a List case field (`each:`, 25 §3).
    const over = step.each?.[tool];
    let items: unknown[] | undefined;
    if (over !== undefined) {
      const list = caseValueAt(input.case, over);
      if (list !== undefined && list !== null && !Array.isArray(list)) return finish('needs_person', `${tool} is called once per item of case.${over}, which is not a list`);
      items = (list as unknown[] | null | undefined) ?? [];
    }
    const calls = items ? items.map((item, index) => ({ item, callId: `${tool}:${index}` })) : [{ item: undefined, callId: tool }];
    const got: unknown[] = [];
    let gotTainted = false;

    for (const { item, callId } of calls) {
      const args = mapArgs(step.map?.[tool], input.case, { item, at: at0 });
      const decision = await DBOS.runStep(async () => {
        const d = await deps.tools.check({ tool, args, token: input.token }, input.policy, { tainted });
        await journal({ journalKey: `policy:${callId}`, kind: 'policy', name: tool, callId, request: { args, tainted }, response: d, effect: d.effect, startedAt: new Date().toISOString() });
        return d;
      }, { name: `policy:${callId}` }) as GatewayDecision;
      const verdict = decision.decision.verdict;
      if (verdict === 'deny') {
        // No rule behind it: the tool itself can't run now (an unknown tool, no public address).
        const why = decision.decision.origins.length ? 'was refused by policy' : "can't run now";
        return finish('needs_person', `${tool} ${why}: ${decision.decision.reason}`);
      }

      if (verdict === 'approve') {
        const id = `${input.stepRunId}:${callId}`;
        let executed = false;
        await DBOS.runStep(async () => {
          executed = true;
          const request: ApprovalRequest = {
            id, stepRunId: input.stepRunId, tool, effect: decision.effect, treatment: verdict, args,
            preview: decision.preview ?? { summary: `${tool} ${JSON.stringify(args)}` }, requestedAt: new Date().toISOString(),
          };
          await deps.recorder.approvalRequested(request);
          await deps.recorder.status(input.stepRunId, 'waiting');
          await journal({ journalKey: `approval.request:${callId}`, kind: 'approval', name: tool, callId, request, effect: decision.effect, startedAt: request.requestedAt });
        }, { name: `approval.request:${callId}` });
        if (executed) crashPoint('waiting-approval', tool);
        const waitSeconds = deps.approvalTimeoutSeconds ?? APPROVAL_WAIT_SECONDS;
        const answer = await DBOS.recv<ApprovalDecision>(approvalTopic(id), { timeoutSeconds: waitSeconds });
        await DBOS.runStep(async () => {
          await deps.recorder.status(input.stepRunId, 'running');
          await journal({
            journalKey: `approval.answer:${callId}`, kind: 'approval', name: tool, callId, request: { id },
            response: answer ?? undefined, ...(answer ? {} : { error: 'no answer in time' }), startedAt: new Date().toISOString(),
          });
        }, { name: `approval.answer:${callId}` });
        if (!answer) return finish('needs_person', `the approval for ${tool} got no answer in time`);
        if (answer.status === 'rejected') return finish('needs_person', `${tool} was rejected by ${answer.by}${answer.comment ? `: ${answer.comment}` : ''}`);
      }

      let out: { result: GatewayCallResult; startedAt: string; durationMs: number; quarantine: boolean };
      let ran = false;
      try {
        out = await DBOS.runStep(async () => {
          ran = true;
          const startedAt = new Date();
          const idempotencyKey = `${input.stepRunId}:${callId}`;
          const result = await deps.tools.execute({ tool, args, callId, idempotencyKey, token: input.token }, decision);
          const durationMs = Date.now() - startedAt.getTime();
          await journal({
            journalKey: `tool:${callId}`, kind: 'tool', name: tool, callId, request: { args, idempotencyKey }, response: result,
            ...(result.status !== 'ok' ? { error: failure(result) } : {}), effect: decision.effect, startedAt: startedAt.toISOString(), durationMs,
          }).catch((e) => DBOS.logger.warn(`step ${input.stepRunId}: journal entry tool:${callId} not recorded: ${e instanceof Error ? e.message : String(e)}`));
          return { result, startedAt: startedAt.toISOString(), durationMs, quarantine: deps.tools.get(tool)?.quarantine === true };
        }, { name: `tool:${callId}` });
      } catch (e) {
        if (isCancel(e)) throw e;
        return finish('needs_person', `${tool} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // A kill here (the call done, the step not committed) must not repeat the call on resume.
      if (ran) crashPoint('after-system-tool', tool);
      toolCalls += 1;
      activeMs += out.durationMs;
      if (out.result.status !== 'ok') return finish('needs_person', `${tool} did not succeed: ${failure(out.result)}`);
      if (out.quarantine) tainted = true;
      got.push(out.result.result);
      gotTainted ||= out.quarantine;
    }
    results[tool] = items ? { result: got, callId: tool, tainted: gotTainted, each: true } : { result: got[0], callId: tool, tainted: gotTainted };
  }

  // Writes from results; a value that is missing or of the wrong type ends the step for a person.
  const at = new Date(t0).toISOString();
  const writes: Record<string, CaseValue> = {};
  const problems: string[] = [];
  for (const [field, w] of Object.entries(step.writes)) {
    if (w.from.kind !== 'tool') { problems.push(`${field} has no tool to come from`); continue; }
    const hit = results[w.from.tool];
    // A tool called once per item gives the list of what each call returned.
    const value = !hit ? undefined : hit.each ? (hit.result as unknown[]).map((r) => valueAt(r, w.from.kind === 'tool' ? w.from.field : undefined) ?? null) : valueAt(hit.result, w.from.field);
    if (value === undefined) {
      // With `outcomeFrom` the result's shape follows its outcome (a stale publish has no
      // version), so only a required write must be there.
      if (w.required || (hit && !step.outcomeFrom)) problems.push(`${w.from.tool} returned no ${w.from.field ?? 'value'} for ${field}`);
      continue;
    }
    const errors = validateValue(w.type, value, input.recordTypes);
    if (errors.length) { problems.push(`${field}: ${errors.join('; ')}`); continue; }
    writes[field] = { value, provenance: { kind: 'tool', at, stepRunId: input.stepRunId, tool: w.from.tool, callId: hit!.callId, ...(hit!.tainted ? { tainted: true } : {}) } };
  }
  if (problems.length) return finish('needs_person', `the results could not be written: ${problems.join('; ')}`);
  const outcome = outcomeOf(step, results);
  if ('reason' in outcome) return finish('needs_person', outcome.reason);
  crashPoint('before-finish');
  return finish('completed', undefined, writes, outcome.outcome);
}

/**
 * The outcome a system step finishes with: with `outcomeFrom`, that field of that tool's result
 * (a name the step declares), else its only outcome. A result that names no declared outcome
 * is not guessed at: the step goes to a person, saying what came back.
 */
export function outcomeOf(step: StepRunInput['step'], results: Record<string, { result: unknown }>): { outcome: string } | { reason: string } {
  const from = step.outcomeFrom;
  if (!from) return { outcome: systemOutcome(step) };
  const hit = results[from.tool];
  if (!hit) return { reason: `the outcome comes from ${from.tool}, which this step did not call` };
  const value = valueAt(hit.result, from.field);
  if (value === undefined || value === null) return { reason: `${from.tool} returned no ${from.field} to take the outcome from` };
  if (typeof value !== 'string' || !step.outcomes.includes(value)) {
    return { reason: `${from.tool} returned ${from.field} ${JSON.stringify(value)}, which is not one of this step's outcomes (${step.outcomes.join(', ')})` };
  }
  return { outcome: value };
}
