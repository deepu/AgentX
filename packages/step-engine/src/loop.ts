/**
 * The agent loop for strict and guided steps (07 §1-2, D38): one DBOS workflow per step run,
 * and inside it every unit of work is a DBOS step with a stable name:
 *
 *   record.start, context,
 *   model:<turn> → for each tool call: policy:<callId> → [approval.request/answer:<callId>] → tool:<name>:<callId>
 *   step.finish → checkpoint:<n>:structural → verify:<n>,
 *   record.finish
 *
 * plus a `journal:<key>` step after each model, verifier and tool call that writes its entry in
 * the step record. On resume DBOS replays the body: finished steps return their journaled output
 * without running, so the message list is rebuilt from DBOS's journal and no finished call
 * repeats. The step record is written alongside and never decides whether a call succeeded.
 * The body itself is deterministic: clocks and ids are read only inside steps or from the input.
 */
import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  crashPoint, type ApprovalDecision, type ApprovalRequest, type AssembledContext, type CaseValue, type CheckResult,
  type JournalEntry, type Money, type StepRecord,
} from '@memwise/defs';
import {
  addMoney, exceedsMoney, exceededLimit, toolNameFromModel, type Budget, type GatewayCallResult, type GatewayDecision, type ModelCallResult,
  type ModelRequest, type Spent,
} from '@memwise/gateway';
import { VERIFIER_ROLE, type Sourced } from '@memwise/policy';
import { parseVerdict, repairMessage, structuralChecks, verifierRequest, type Evidence, type FinishArgs } from './checkpoint.ts';
import { assembleContext, requiredTools } from './context.ts';
import { engineDeps } from './deps.ts';
import {
  FINISH_TOOL, approvalTopic, type StepEngineDeps, type StepResult, type StepResultStatus, type StepRunInput,
} from './types.ts';

export const AGENT_STEP_WORKFLOW = 'memwise.step.agent';

/** Approvals hibernate this long before the step gives up and goes to a person. */
const APPROVAL_WAIT_SECONDS = 7 * 24 * 3600;
/** pi-ai retries are off (D38): a failed model attempt is retried here, as a DBOS step retry. */
const MODEL_STEP: StepConfig = { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1, backoffRate: 2, timeoutMS: 300_000 };
/** Step-record writes after a call are idempotent on their key, so they retry on their own. */
const JOURNAL_STEP: StepConfig = { retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2 };
const DEFAULT_MAX_TURNS = 24;
const waitTime = (seconds: number) => (seconds % 86_400 === 0 ? `${seconds / 86_400} days` : `${seconds} seconds`);
const DEFAULT_MAX_REPAIRS = 2;

type ModelOutcome =
  | { kind: 'ok'; call: ModelCallResult }
  /** A budget is spent or the policy does not permit the role: nothing was sent, the step goes to a person. */
  | { kind: 'stop'; message: string }
  /** Every attempt failed (provider down, bad key): the step stops as `failed`. */
  | { kind: 'error'; message: string };

type Entry = Omit<JournalEntry, 'stepRunId' | 'journalKey'>;
const isCancel = (e: unknown) => e instanceof Error && /cancel/i.test(e.name);

/** Aborts the provider request when DBOS cancels the workflow or the attempt times out. */
function stepSignal(): AbortSignal | undefined {
  const st = DBOS.stepStatus;
  const signals = [st?.cancelSignal, st?.timeoutSignal].filter((s): s is AbortSignal => !!s);
  return signals.length ? AbortSignal.any(signals) : undefined;
}

const minDefined = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

function budgetOf(pick: (key: keyof Budget) => number | undefined): Budget {
  const budget: Budget = {};
  for (const key of ['tokens', 'modelCalls', 'timeMs'] as const) {
    const v = pick(key);
    if (v !== undefined) budget[key] = v;
  }
  return budget;
}

/**
 * The step's own budget, for this step run alone: the policy's budgets set by the step layer,
 * and the step file's.
 */
export function stepBudget(input: StepRunInput): Budget {
  const p = input.policy.budgets;
  const s = input.step.budget ?? {};
  return budgetOf((key) => minDefined(p[key]?.origin.layer === 'step' ? p[key].value : undefined, s[key]));
}

/**
 * The run's budget: the policy's budgets set above the step layer, checked against
 * `input.runSpent` plus this step run.
 */
export function runBudget(input: StepRunInput): Budget {
  const p = input.policy.runBudgets ?? input.policy.budgets;
  const above = (b?: Sourced<number>) => (b && b.origin.layer !== 'step' ? b.value : undefined);
  return budgetOf((key) => above(p[key]));
}

function toolResult(call: ToolCall, text: string, isError: boolean, timestamp: number, durationMs?: number): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError, timestamp,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function resultText(r: GatewayCallResult): { text: string; isError: boolean } {
  switch (r.status) {
    case 'ok': return { text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result) ?? 'null', isError: false };
    case 'denied': return { text: `Refused: ${r.reason}`, isError: true };
    case 'unknown': return { text: `The outcome of this call is unknown and it was not retried: ${r.reason}`, isError: true };
    case 'error': return { text: `Error: ${r.error}`, isError: true };
  }
}

/** An object argument, which models sometimes send as a JSON string; anything else that is not an object is none. */
function objectArg(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Models sometimes send `writes` (and `quotes`) as a JSON string; anything else that is not an object counts as none. */
function finishArgs(raw: Record<string, unknown>): FinishArgs {
  const quotes = objectArg(raw.quotes);
  return {
    outcome: String(raw.outcome ?? ''), writes: objectArg(raw.writes) ?? {}, ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
    // A quote that isn't text is kept as it came, so the check says it is empty rather than losing it.
    ...(quotes && Object.keys(quotes).length ? { quotes: quotes as Record<string, string> } : {}),
  };
}

/** State of one step run, rebuilt identically on replay from journaled step outputs. */
class StepRun {
  readonly messages: Message[];
  readonly evidence: Evidence[] = [];
  tainted = false;
  tokens = 0;
  costUsd = 0;
  /** What this step run's model calls cost; `mixed` once two currencies meet (then unenforced). */
  cost: Money | undefined | 'mixed';
  /** Every model call, verifier calls included (usage and crash points). */
  modelCalls = 0;
  /** The agent's own calls: what model-call budgets count. A verifier call does not use up a turn. */
  agentCalls = 0;
  toolCalls = 0;
  /** Model and tool time only, so a long approval wait does not eat the time budget. */
  activeMs = 0;
  repairs = 0;
  finishRounds = 0;
  checkpoint: CheckResult[] = [];
  ctx?: AssembledContext;
  rationale?: string;
  private readonly budget: Budget;
  private readonly runBudget: Budget;
  private readonly required: string[];

  constructor(readonly input: StepRunInput, readonly deps: StepEngineDeps) {
    this.messages = [{ role: 'user', content: `Begin the step: ${input.step.title}.`, timestamp: input.startedAt }];
    // Untrusted content read from the case counts like content read in this session (07 §6).
    this.tainted = input.tainted === true;
    this.budget = stepBudget(input);
    this.runBudget = runBudget(input);
    this.required = requiredTools(input);
  }

  get turnLimit() { return this.budget.modelCalls ?? this.deps.maxTurns ?? DEFAULT_MAX_TURNS; }

  private async step<T>(name: string, fn: () => Promise<T>, cfg: StepConfig = {}): Promise<{ value: T; executed: boolean }> {
    let executed = false;
    const value = await DBOS.runStep(async () => { executed = true; return fn(); }, { name, ...cfg });
    return { value, executed };
  }

  private journal(entry: Omit<JournalEntry, 'stepRunId'>) {
    return this.deps.recorder.journal({ stepRunId: this.input.stepRunId, ...entry });
  }

  /**
   * A step-record entry for a call that already ran, written as its own retried DBOS step
   * `journal:<key>` after the call's step. The record never decides whether a call succeeded
   * (DBOS's journal is what a replay reads), so a write that keeps failing is logged and the
   * step run goes on.
   */
  private async record(journalKey: string, entry: () => Entry): Promise<void> {
    try {
      await this.step(`journal:${journalKey}`, () => this.journal({ journalKey, ...entry() }), JOURNAL_STEP);
    } catch (e) {
      if (isCancel(e)) throw e;
      DBOS.logger.warn(`step ${this.input.stepRunId}: journal entry ${journalKey} not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A step-record write inside a call's step, which must not fail the call: errors are logged. */
  private async bestEffort(journalKey: string, entry: Entry): Promise<void> {
    try {
      await this.journal({ journalKey, ...entry });
    } catch (e) {
      DBOS.logger.warn(`step ${this.input.stepRunId}: journal entry ${journalKey} not recorded: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Why a model call for `role` may not be made: a role the policy does not permit, or a spent budget. */
  private refusal(role: string, verifier: boolean): string | undefined {
    const roles = this.input.policy.modelRoles;
    if (roles && !roles.value.includes(role)) {
      return `model role ${role} is not permitted by the policy (${roles.origin.layer} ${roles.origin.name} permits ${roles.value.join(', ') || 'no role'})`;
    }
    // Verifier calls count tokens and time, not model calls: checking the last turn's result must not break the turn limit.
    const calls = (b: Budget): Budget => { if (!verifier) return b; const { modelCalls: _, ...rest } = b; return rest; };
    const own: Spent = { tokens: this.tokens, modelCalls: this.agentCalls, elapsedMs: this.activeMs };
    const before = this.input.runSpent ?? { tokens: 0, modelCalls: 0, elapsedMs: 0 };
    const run: Spent = { tokens: before.tokens + own.tokens, modelCalls: before.modelCalls + own.modelCalls, elapsedMs: before.elapsedMs + own.elapsedMs };
    for (const [scope, budget, spent] of [['the step', this.budget, own], ['the run', this.runBudget, run]] as const) {
      const limit = exceededLimit(calls(budget), spent);
      if (limit) return `budget exceeded: ${limit} (limit ${budget[limit]} for ${scope}, spent ${JSON.stringify(spent)})`;
    }
    return this.moneyRefusal();
  }

  /**
   * Money budgets (19 §7), like the token budget: one set by the step layer is for this step run,
   * any other for the whole run. Spend in another currency than the budget is not compared (the
   * check warns "money budget not enforced"), and neither is spend nobody priced.
   */
  private moneyRefusal(): string | undefined {
    const p = this.input.policy;
    const own = this.cost === 'mixed' ? undefined : this.cost;
    if (!own) return undefined;
    const stepBudget = p.budgets.money?.origin.layer === 'step' ? p.budgets.money.value : undefined;
    const runRule = (p.runBudgets ?? p.budgets).money;
    const runBudget = runRule && runRule.origin.layer !== 'step' ? runRule.value : undefined;
    const before = this.input.runSpent?.money;
    const runSpent = before ? addMoney(before, own) : own;
    const fmt = (m: Money) => `${m.amount} ${m.currency}`;
    for (const [scope, budget, spent] of [['the step', stepBudget, own], ['the run', runBudget, runSpent]] as const) {
      if (!budget || !spent) continue;
      if (exceedsMoney(spent, budget)) return `budget exceeded: money (limit ${fmt(budget)} for ${scope}, spent ${fmt(spent)})`;
    }
    return undefined;
  }

  async run(): Promise<StepResult> {
    const { input, deps } = this;
    const { step } = input;
    await this.step('record.start', () => deps.recorder.start({
      stepRunId: input.stepRunId, runId: input.runId, caseId: input.case.id, stepId: step.id, attempt: input.attempt,
      workflowId: input.workflow.id, workflowVersion: input.workflow.version, workflowHash: input.workflow.hash,
      stepHash: step.hash, performer: step.performer, token: input.token, startedAt: new Date(input.startedAt).toISOString(),
    }));
    if (!step.model) return this.stop('failed', `step ${step.id} names no model role`);

    // Recorded once: a resume uses exactly the prompt and tools the run started with, even after a deploy.
    const ctx = (this.ctx = (await this.step('context', async () => {
      const c = assembleContext(input, deps);
      await deps.recorder.context(input.stepRunId, c);
      return c;
    })).value);
    const tools = ctx.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const byModelName = new Map(ctx.tools.map((t) => [t.name, t.tool]));

    for (let turn = 1; ; turn++) {
      if (turn > this.turnLimit) return this.stop('needs_person', `no ${FINISH_TOOL} within the limit of ${this.turnLimit} model calls`);
      const out = await this.model(`model:${turn}`, step.model, { systemPrompt: ctx.systemPrompt, messages: [...this.messages], tools },
        { turn, contextHash: ctx.hash, messages: this.messages.length });
      if (out.kind === 'stop') return this.stop('needs_person', out.message);
      if (out.kind === 'error') return this.stop('failed', out.message);
      const assistant = out.call.message;
      this.messages.push(assistant);

      const calls = assistant.content.filter((b): b is ToolCall => b.type === 'toolCall');
      if (!calls.length) {
        this.messages.push({ role: 'user', content: `Call one of your tools, or ${FINISH_TOOL} when the step is done.`, timestamp: assistant.timestamp });
        continue;
      }
      for (const call of calls) {
        const tool = byModelName.get(call.name) ?? (ctx.tools.some((t) => t.tool === call.name) ? call.name : undefined);
        if (tool === FINISH_TOOL) {
          const done = await this.finish(call, assistant);
          if (done) return done;
        } else if (!tool) {
          const offered = ctx.tools.map((t) => t.tool).join(', ');
          this.messages.push(toolResult(call, `${toolNameFromModel(call.name)} is not available in this step. Available: ${offered}.`, true, assistant.timestamp));
        } else {
          const stopped = await this.toolCall(tool, call);
          if (stopped) return stopped;
        }
      }
    }
  }

  /**
   * One model call as a DBOS step. A refused role or a spent budget is a designed outcome,
   * returned rather than thrown, and nothing is sent.
   */
  private async model(name: string, role: string, request: ModelRequest, journalRequest: unknown, verifier = false): Promise<ModelOutcome> {
    const { deps, input } = this;
    // Checked here, not by the gateway: the step's budget and the run's count different spending.
    const refused = this.refusal(role, verifier);
    if (refused) {
      await this.record(name, () => ({ kind: 'model', name: role, request: journalRequest, error: refused, startedAt: new Date().toISOString() }));
      return { kind: 'stop', message: refused };
    }
    let ran: { value: { call: ModelCallResult; attempt: number; startedAt: string }; executed: boolean };
    try {
      ran = await this.step(name, async () => {
        const startedAt = new Date().toISOString();
        const attempt = DBOS.stepStatus?.currentAttempt ?? 1;
        // D38: each attempt is recorded before it is sent, so a kill mid-request leaves a trace.
        await this.bestEffort(`${name}#${attempt}`, { kind: 'model', name: role, request: journalRequest, attempt, startedAt });
        const t0 = Date.now();
        try {
          const call = await deps.models.call(request, { role, sessionId: input.stepRunId, signal: stepSignal() });
          const { message } = call;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            throw new Error(`model call ${message.stopReason}: ${message.errorMessage ?? 'no message'}`);
          }
          return { call, attempt, startedAt };
        } catch (e) {
          // Each failed attempt is kept in the record (D38), so lost calls are visible in metering.
          const error = e instanceof Error ? e.message : String(e);
          await this.bestEffort(`${name}#${attempt}:failed`, { kind: 'model', name: role, request: journalRequest, error, attempt, startedAt, durationMs: Date.now() - t0 });
          throw e;
        }
      }, MODEL_STEP);
    } catch (e) {
      // DBOS replays a recorded failure as the same throw, so this path is deterministic too.
      // Cancellation is not a step outcome: let DBOS handle it.
      if (isCancel(e)) throw e;
      return { kind: 'error', message: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const { value: { call, attempt, startedAt }, executed } = ran;
    this.modelCalls += 1;
    if (!verifier) this.agentCalls += 1;
    this.tokens += call.usage.totalTokens;
    this.costUsd += call.usage.costUsd ?? 0;
    if (call.cost && this.cost !== 'mixed') this.cost = addMoney(this.cost, call.cost) ?? 'mixed';
    this.activeMs += call.durationMs;
    // After DBOS recorded the call, in its own step: a recorder failure can't make the call run again.
    const { message } = call;
    await this.record(name, () => ({
      kind: 'model', name: role, request: journalRequest, response: { content: message.content, stopReason: message.stopReason },
      model: { provider: call.provider, model: call.model, usage: call.usage, stopReason: message.stopReason },
      attempt, startedAt, durationMs: call.durationMs,
    }));
    // A kill here must not repeat the call on resume.
    if (executed) crashPoint('after-model-call', this.modelCalls);
    return { kind: 'ok', call };
  }

  /** Policy check, approval wait if needed, then the call through the gateway. Returns a StepResult only to stop. */
  private async toolCall(tool: string, call: ToolCall): Promise<StepResult | undefined> {
    const { deps, input } = this;
    const args = call.arguments;
    const tainted = this.tainted;
    // Journaled, so a policy edit between crash and resume cannot flip a decision already acted on.
    const policy = (await this.step(`policy:${call.id}`, async () => {
      const startedAt = new Date().toISOString();
      const decision = await deps.tools.check({ tool, args, token: input.token }, input.policy, { tainted });
      await this.journal({
        journalKey: `policy:${call.id}`, kind: 'policy', name: tool, callId: call.id, request: { args, tainted },
        response: decision, effect: decision.effect, startedAt,
      });
      return { decision, at: Date.now() };
    })).value;
    const decision: GatewayDecision = policy.decision;
    const verdict = decision.decision.verdict;

    if (verdict === 'deny') {
      this.messages.push(toolResult(call, `Refused by policy: ${decision.decision.reason}`, true, policy.at));
      return;
    }
    if (verdict === 'approve') {
      const id = `${input.stepRunId}:${call.id}`;
      const { executed } = await this.step(`approval.request:${call.id}`, async () => {
        const request: ApprovalRequest = {
          id, stepRunId: input.stepRunId, tool, effect: decision.effect, treatment: verdict, args,
          preview: decision.preview ?? { summary: `${tool} ${JSON.stringify(args)}` }, requestedAt: new Date().toISOString(),
        };
        await deps.recorder.approvalRequested(request);
        await deps.recorder.status(input.stepRunId, 'waiting');
        await this.journal({ journalKey: `approval.request:${call.id}`, kind: 'approval', name: tool, callId: call.id, request, effect: decision.effect, startedAt: request.requestedAt });
      });
      if (executed) crashPoint('waiting-approval', tool);
      // Hibernates: no worker or model is held, and the wait survives restarts.
      const waitSeconds = deps.approvalTimeoutSeconds ?? APPROVAL_WAIT_SECONDS;
      const answer = await DBOS.recv<ApprovalDecision>(approvalTopic(id), { timeoutSeconds: waitSeconds });
      const answeredAt = (await this.step(`approval.answer:${call.id}`, async () => {
        await deps.recorder.status(input.stepRunId, 'running');
        await this.journal({
          journalKey: `approval.answer:${call.id}`, kind: 'approval', name: tool, callId: call.id, request: { id },
          response: answer ?? undefined, ...(answer ? {} : { error: 'no answer in time' }), startedAt: new Date().toISOString(),
        });
        return Date.now();
      })).value;
      if (!answer) {
        // The request lapses: the record shows it, and a late decision is refused (the step run is no longer waiting).
        await this.record(`approval.expired:${call.id}`, () => ({
          kind: 'approval', name: tool, callId: call.id, request: { id }, error: 'expired', startedAt: new Date().toISOString(),
        }));
        return this.stop('needs_person', `the approval for ${tool} got no answer within ${waitTime(waitSeconds)}`);
      }
      if (answer.status === 'rejected') {
        const text = `Rejected by ${answer.by}${answer.comment ? `: ${answer.comment}` : ''}. The call was not made.`;
        this.messages.push(toolResult(call, text, true, answeredAt));
        return;
      }
    }

    const out = (await this.step(`tool:${tool}:${call.id}`, async () => {
      const startedAt = new Date();
      // D38: unique and deterministic per step run, so a re-run of this step reuses the key.
      const idempotencyKey = `${DBOS.workflowID}:${DBOS.stepID}`;
      const result = await deps.tools.execute({ tool, args, callId: call.id, idempotencyKey, token: input.token }, decision);
      const durationMs = Date.now() - startedAt.getTime();
      return { result, idempotencyKey, startedAt: startedAt.toISOString(), at: Date.now(), durationMs, quarantine: deps.tools.get(tool)?.quarantine === true };
    })).value;
    // After DBOS recorded the call, in its own step: a recorder failure can't fail a call whose effect is done.
    await this.record(`tool:${tool}:${call.id}`, () => ({
      kind: 'tool', name: tool, callId: call.id, request: { args, idempotencyKey: out.idempotencyKey },
      response: out.result, ...(out.result.status !== 'ok' ? { error: 'error' in out.result ? out.result.error : out.result.reason } : {}),
      effect: decision.effect, startedAt: out.startedAt, durationMs: out.durationMs,
    }));
    this.toolCalls += 1;
    this.activeMs += out.durationMs;
    if (out.result.status === 'ok') {
      this.evidence.push({ tool, callId: call.id, args, result: out.result.result, ...(out.quarantine ? { tainted: true } : {}) });
      // Untrusted content entered the session (07 §6): outbound calls from here on are checked as tainted.
      if (out.quarantine) this.tainted = true;
    }
    const { text, isError } = resultText(out.result);
    this.messages.push(toolResult(call, text, isError, out.at, out.durationMs));
  }

  /** The output checkpoint. Returns a StepResult when the step ends here, nothing when the agent should repair. */
  private async finish(call: ToolCall, assistant: AssistantMessage): Promise<StepResult | undefined> {
    const { deps, input } = this;
    const { step } = input;
    const n = ++this.finishRounds;
    const args = finishArgs(call.arguments);
    this.rationale = args.rationale;

    const structural = (await this.step(`checkpoint:${n}:structural`, async () => {
      const startedAt = new Date().toISOString();
      const res = structuralChecks(input, args, this.evidence, this.required, startedAt);
      await this.journal({ journalKey: `checkpoint:${n}:structural`, kind: 'checkpoint', name: 'structural', callId: call.id, request: args, response: res.checks, startedAt });
      return { ...res, at: Date.now() };
    })).value;
    let checks = structural.checks;
    let at = structural.at;

    if (structural.passed && step.checkpoint.length) {
      const role = deps.verifierRole ?? VERIFIER_ROLE;
      const request = verifierRequest(step.checkpoint, args, this.evidence, assistant.timestamp);
      const out = await this.model(`verify:${n}`, role, request, { round: n, rules: step.checkpoint }, true);
      if (out.kind === 'stop') return this.stop('needs_person', out.message);
      if (out.kind === 'error') return this.stop('failed', out.message);
      const verdict = parseVerdict(out.call.message, step.checkpoint);
      await this.record(`checkpoint:${n}:verifier`, () => ({
        kind: 'checkpoint', name: 'verifier', callId: call.id, request: { rules: step.checkpoint }, response: verdict, startedAt: new Date().toISOString(),
      }));
      checks = [...checks, ...verdict];
      at = out.call.message.timestamp;
    }
    this.checkpoint = checks;

    const failed = checks.filter((c) => !c.passed);
    if (!failed.length) {
      crashPoint('before-finish');
      return this.stop('completed', undefined, args.outcome, structural.writes);
    }
    const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    if (this.repairs >= maxRepairs) {
      return this.stop('needs_person', `the checkpoint failed after ${maxRepairs} repair rounds: ${failed.map((c) => `${c.rule}: ${c.reason ?? 'failed'}`).join('; ')}`);
    }
    this.repairs += 1;
    this.messages.push(toolResult(call, repairMessage(failed, maxRepairs - this.repairs + 1), true, at));
    return undefined;
  }

  private async stop(status: StepResultStatus, reason?: string, outcome?: string, writes: Record<string, CaseValue> = {}): Promise<StepResult> {
    const { deps, input } = this;
    const finalOutcome = status === 'completed' ? outcome! : status;
    const usage = { tokens: this.tokens, modelCalls: this.modelCalls, toolCalls: this.toolCalls };
    const { durationMs } = (await this.step('record.finish', async () => {
      const finishedAt = Date.now();
      const durationMs = finishedAt - input.startedAt;
      if (reason) {
        await this.journal({ journalKey: 'record.finish', kind: 'checkpoint', name: 'stop', request: { status }, error: reason, startedAt: new Date(finishedAt).toISOString() });
      }
      const record: StepRecord = {
        stepRunId: input.stepRunId, runId: input.runId, caseId: input.case.id, stepId: input.step.id, attempt: input.attempt,
        workflowId: input.workflow.id, workflowVersion: input.workflow.version, workflowHash: input.workflow.hash,
        stepHash: input.step.hash, performer: input.step.performer, status, outcome: finalOutcome, token: input.token,
        ...(this.ctx ? { context: this.ctx } : {}), outputs: writes, checkpoint: this.checkpoint,
        ...(this.rationale !== undefined ? { rationale: this.rationale } : {}),
        usage: { ...usage, durationMs, ...(this.costUsd ? { costUsd: this.costUsd } : {}), ...(this.cost && this.cost !== 'mixed' ? { cost: this.cost } : {}) },
        tainted: this.tainted, startedAt: new Date(input.startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
      };
      await deps.recorder.finish(record);
      return { durationMs };
    })).value;
    return {
      stepRunId: input.stepRunId, status, outcome: finalOutcome, writes,
      ...(this.rationale !== undefined ? { rationale: this.rationale } : {}),
      checkpoint: this.checkpoint, usage: { ...usage, durationMs, ...(this.cost && this.cost !== 'mixed' ? { cost: this.cost } : {}) }, tainted: this.tainted,
      ...(reason ? { reason } : {}),
    };
  }
}

/**
 * The step run's DBOS workflow body, unregistered. A kernel process (`@memwise/runtime`) registers
 * it itself under `AGENT_STEP_WORKFLOW`, so it can deregister between kernels in tests.
 * Start it with `workflowID: input.stepRunId`.
 */
export async function agentStepWorkflow(input: StepRunInput): Promise<StepResult> {
  return new StepRun(input, engineDeps()).run();
}

let registered: ((input: StepRunInput) => Promise<StepResult>) | undefined;

/**
 * For using the step engine standalone (tests, scripts), not inside a kernel process, which
 * registers `agentStepWorkflow` itself: registers `memwise.step.agent` once per process (before
 * DBOS.launch()) and returns the workflow.
 */
export function registerAgentStep(): (input: StepRunInput) => Promise<StepResult> {
  return (registered ??= DBOS.registerWorkflow(agentStepWorkflow, { name: AGENT_STEP_WORKFLOW }));
}

/**
 * For using the step engine standalone, not inside a kernel process (see `registerAgentStep`):
 * starts a step run as its own DBOS workflow (id = step run id) and returns the handle.
 */
export function runAgentStep(input: StepRunInput) {
  return DBOS.startWorkflow(registerAgentStep(), { workflowID: input.stepRunId })(input);
}
