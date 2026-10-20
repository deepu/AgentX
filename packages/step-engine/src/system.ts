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

/** A tool's arguments from the step's `map`: `case.<path>` reads the case (absent values are left out). */
export function mapArgs(map: Record<string, ArgSource> | undefined, snapshot: CaseSnapshot): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [arg, src] of Object.entries(map ?? {})) {
    if ('case' in src) {
      const [head, ...rest] = src.case.split('.');
      const v = valueAt(snapshot.values[head!]?.value, rest.join('.') || undefined);
      if (v !== undefined && v !== null) args[arg] = v;
    } else if (src.value !== undefined) args[arg] = src.value;
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
  const results: Record<string, { result: unknown; callId: string; tainted: boolean }> = {};

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

  for (const tool of step.tools.required) {
    const callId = tool;
    const args = mapArgs(step.map?.[tool], input.case);
    const decision = await DBOS.runStep(async () => {
      const d = await deps.tools.check({ tool, args, token: input.token }, input.policy, { tainted });
      await journal({ journalKey: `policy:${tool}`, kind: 'policy', name: tool, callId, request: { args, tainted }, response: d, effect: d.effect, startedAt: new Date().toISOString() });
      return d;
    }, { name: `policy:${tool}` }) as GatewayDecision;
    const verdict = decision.decision.verdict;
    if (verdict === 'deny') return finish('needs_person', `${tool} was refused by policy: ${decision.decision.reason}`);

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
        await journal({ journalKey: `approval.request:${tool}`, kind: 'approval', name: tool, callId, request, effect: decision.effect, startedAt: request.requestedAt });
      }, { name: `approval.request:${tool}` });
      if (executed) crashPoint('waiting-approval', tool);
      const waitSeconds = deps.approvalTimeoutSeconds ?? APPROVAL_WAIT_SECONDS;
      const answer = await DBOS.recv<ApprovalDecision>(approvalTopic(id), { timeoutSeconds: waitSeconds });
      await DBOS.runStep(async () => {
        await deps.recorder.status(input.stepRunId, 'running');
        await journal({
          journalKey: `approval.answer:${tool}`, kind: 'approval', name: tool, callId, request: { id },
          response: answer ?? undefined, ...(answer ? {} : { error: 'no answer in time' }), startedAt: new Date().toISOString(),
        });
      }, { name: `approval.answer:${tool}` });
      if (!answer) return finish('needs_person', `the approval for ${tool} got no answer in time`);
      if (answer.status === 'rejected') return finish('needs_person', `${tool} was rejected by ${answer.by}${answer.comment ? `: ${answer.comment}` : ''}`);
    }

    let out: { result: GatewayCallResult; startedAt: string; durationMs: number; quarantine: boolean };
    let ran = false;
    try {
      out = await DBOS.runStep(async () => {
        ran = true;
        const startedAt = new Date();
        const idempotencyKey = `${input.stepRunId}:${tool}`;
        const result = await deps.tools.execute({ tool, args, callId, idempotencyKey, token: input.token }, decision);
        const durationMs = Date.now() - startedAt.getTime();
        await journal({
          journalKey: `tool:${tool}`, kind: 'tool', name: tool, callId, request: { args, idempotencyKey }, response: result,
          ...(result.status !== 'ok' ? { error: failure(result) } : {}), effect: decision.effect, startedAt: startedAt.toISOString(), durationMs,
        }).catch((e) => DBOS.logger.warn(`step ${input.stepRunId}: journal entry tool:${tool} not recorded: ${e instanceof Error ? e.message : String(e)}`));
        return { result, startedAt: startedAt.toISOString(), durationMs, quarantine: deps.tools.get(tool)?.quarantine === true };
      }, { name: `tool:${tool}` });
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
    results[tool] = { result: out.result.result, callId, tainted: out.quarantine };
  }

  // Writes from results; a value that is missing or of the wrong type ends the step for a person.
  const at = new Date(t0).toISOString();
  const writes: Record<string, CaseValue> = {};
  const problems: string[] = [];
  for (const [field, w] of Object.entries(step.writes)) {
    if (w.from.kind !== 'tool') { problems.push(`${field} has no tool to come from`); continue; }
    const hit = results[w.from.tool];
    const value = hit ? valueAt(hit.result, w.from.field) : undefined;
    if (value === undefined) {
      if (w.required || hit) problems.push(`${w.from.tool} returned no ${w.from.field ?? 'value'} for ${field}`);
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
