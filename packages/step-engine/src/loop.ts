/**
 * The agent loop for strict and guided steps (07 §1-2, D38): one DBOS workflow per step run,
 * and inside it every unit of work is a DBOS step with a stable name:
 *
 *   record.start, context,
 *   model:<turn> → for each tool call: policy:<callId> → [approval.request/answer:<callId>] → tool:<name>:<callId>
 *   step.finish → checkpoint:<n>:structural → verify:<n>,
 *   record.finish
 *
 * On resume DBOS replays the body: finished steps return their journaled output without
 * running, so the message list is rebuilt from the journal and no finished call repeats.
 * The body itself is deterministic: clocks and ids are read only inside steps or from the input.
 */
import { DBOS, type StepConfig } from '@dbos-inc/dbos-sdk';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  crashPoint, type ApprovalDecision, type ApprovalRequest, type AssembledContext, type CaseValue, type CheckResult,
  type JournalEntry, type StepRecord,
} from '@memwise/defs';
import {
  BudgetExceededError, toolNameFromModel, type Budget, type GatewayCallResult, type GatewayDecision, type ModelCallResult,
  type ModelRequest,
} from '@memwise/gateway';
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
const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_REPAIRS = 2;

type ModelOutcome =
  | { kind: 'ok'; call: ModelCallResult }
  | { kind: 'budget'; limit: keyof Budget; message: string }
  /** Every attempt failed (provider down, bad key): the step stops as `failed`. */
  | { kind: 'error'; message: string };

const isBudgetError = (e: unknown): e is BudgetExceededError =>
  e instanceof BudgetExceededError || (e instanceof Error && e.name === 'BudgetExceededError');

/** Aborts the provider request when DBOS cancels the workflow or the attempt times out. */
function stepSignal(): AbortSignal | undefined {
  const st = DBOS.stepStatus;
  const signals = [st?.cancelSignal, st?.timeoutSignal].filter((s): s is AbortSignal => !!s);
  return signals.length ? AbortSignal.any(signals) : undefined;
}

const minDefined = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** The step's budget: the tighter of the effective policy and the step file. */
export function stepBudget(input: StepRunInput): Budget {
  const p = input.policy.budgets;
  const s = input.step.budget ?? {};
  const budget: Budget = {};
  const tokens = minDefined(p.tokens?.value, s.tokens);
  const modelCalls = minDefined(p.modelCalls?.value, s.modelCalls);
  const timeMs = minDefined(p.timeMs?.value, s.timeMs);
  if (tokens !== undefined) budget.tokens = tokens;
  if (modelCalls !== undefined) budget.modelCalls = modelCalls;
  if (timeMs !== undefined) budget.timeMs = timeMs;
  return budget;
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

/** Models sometimes send `writes` as a JSON string; anything else that is not an object counts as no writes. */
function finishArgs(raw: Record<string, unknown>): FinishArgs {
  let writes = raw.writes;
  if (typeof writes === 'string') { try { writes = JSON.parse(writes); } catch { /* checked below */ } }
  const plain = writes && typeof writes === 'object' && !Array.isArray(writes) ? (writes as Record<string, unknown>) : {};
  return { outcome: String(raw.outcome ?? ''), writes: plain, ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}) };
}

/** State of one step run, rebuilt identically on replay from journaled step outputs. */
class StepRun {
  readonly messages: Message[];
  readonly evidence: Evidence[] = [];
  tainted = false;
  tokens = 0;
  costUsd = 0;
  modelCalls = 0;
  toolCalls = 0;
  /** Model and tool time only, so a long approval wait does not eat the time budget. */
  activeMs = 0;
  repairs = 0;
  finishRounds = 0;
  checkpoint: CheckResult[] = [];
  ctx?: AssembledContext;
  rationale?: string;
  private readonly budget: Budget;
  private readonly required: string[];

  constructor(readonly input: StepRunInput, readonly deps: StepEngineDeps) {
    this.messages = [{ role: 'user', content: `Begin the step: ${input.step.title}.`, timestamp: input.startedAt }];
    this.budget = stepBudget(input);
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
      if (out.kind === 'budget') return this.stop('needs_person', out.message);
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

  /** One model call as a DBOS step. A budget stop is a designed outcome, returned rather than thrown. */
  private async model(
    name: string, role: string, request: ModelRequest, journalRequest: unknown,
    after?: (call: ModelCallResult) => Promise<void>,
  ): Promise<ModelOutcome> {
    const { deps, input } = this;
    const spent = { tokens: this.tokens, modelCalls: this.modelCalls, elapsedMs: this.activeMs };
    let ran: { value: ModelOutcome; executed: boolean };
    try {
      ran = await this.step(name, async (): Promise<ModelOutcome> => {
      const startedAt = new Date().toISOString();
      const attempt = DBOS.stepStatus?.currentAttempt;
      try {
        const call = await deps.models.call(request, { role, sessionId: input.stepRunId, signal: stepSignal(), budget: this.budget, spent });
        const { message } = call;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          throw new Error(`model call ${message.stopReason}: ${message.errorMessage ?? 'no message'}`);
        }
        await this.journal({
          journalKey: name, kind: 'model', name: role, request: journalRequest,
          response: { content: message.content, stopReason: message.stopReason },
          model: { provider: call.provider, model: call.model, usage: call.usage, stopReason: message.stopReason },
          attempt, startedAt, durationMs: call.durationMs,
        });
        await after?.(call);
        return { kind: 'ok', call };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (isBudgetError(e)) {
          await this.journal({ journalKey: name, kind: 'model', name: role, request: journalRequest, error, attempt, startedAt });
          return { kind: 'budget', limit: e.limit, message: `budget exceeded: ${e.limit} (limit ${e.budget[e.limit]}, spent ${JSON.stringify(e.spent)})` };
        }
        // Each failed attempt is kept in the record (D38), so lost calls are visible in metering.
        await this.journal({ journalKey: `${name}#${attempt ?? 1}`, kind: 'model', name: role, request: journalRequest, error, attempt, startedAt });
        throw e;
      }
      }, MODEL_STEP);
    } catch (e) {
      // DBOS replays a recorded failure as the same throw, so this path is deterministic too.
      // Cancellation is not a step outcome: let DBOS handle it.
      if (e instanceof Error && /cancel/i.test(e.name)) throw e;
      return { kind: 'error', message: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const { value, executed } = ran;
    if (value.kind === 'ok') {
      this.modelCalls += 1;
      this.tokens += value.call.usage.totalTokens;
      this.costUsd += value.call.usage.costUsd ?? 0;
      this.activeMs += value.call.durationMs;
      // After DBOS recorded the call: a kill here must not repeat it on resume.
      if (executed) crashPoint('after-model-call', this.modelCalls);
    }
    return value;
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
      const answer = await DBOS.recv<ApprovalDecision>(approvalTopic(id), { timeoutSeconds: APPROVAL_WAIT_SECONDS });
      const answeredAt = (await this.step(`approval.answer:${call.id}`, async () => {
        await deps.recorder.status(input.stepRunId, 'running');
        await this.journal({
          journalKey: `approval.answer:${call.id}`, kind: 'approval', name: tool, callId: call.id, request: { id },
          response: answer ?? undefined, ...(answer ? {} : { error: 'no answer in time' }), startedAt: new Date().toISOString(),
        });
        return Date.now();
      })).value;
      if (!answer) return this.stop('needs_person', `the approval for ${tool} got no answer within ${APPROVAL_WAIT_SECONDS / 86400} days`);
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
      await this.journal({
        journalKey: `tool:${tool}:${call.id}`, kind: 'tool', name: tool, callId: call.id, request: { args, idempotencyKey },
        response: result, ...(result.status !== 'ok' ? { error: 'error' in result ? result.error : result.reason } : {}),
        effect: decision.effect, startedAt: startedAt.toISOString(), durationMs,
      });
      return { result, at: Date.now(), durationMs, quarantine: deps.tools.get(tool)?.quarantine === true };
    })).value;
    this.toolCalls += 1;
    this.activeMs += out.durationMs;
    if (out.result.status === 'ok') {
      this.evidence.push({ tool, callId: call.id, args, result: out.result.result });
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
      const role = deps.verifierRole ?? 'verifier';
      const request = verifierRequest(step.checkpoint, args, this.evidence, assistant.timestamp);
      const out = await this.model(`verify:${n}`, role, request, { round: n, rules: step.checkpoint }, async (v) => {
        await this.journal({
          journalKey: `checkpoint:${n}:verifier`, kind: 'checkpoint', name: 'verifier', callId: call.id,
          request: { rules: step.checkpoint }, response: parseVerdict(v.message, step.checkpoint), startedAt: new Date().toISOString(),
        });
      });
      if (out.kind === 'budget') return this.stop('needs_person', out.message);
      if (out.kind === 'error') return this.stop('failed', out.message);
      checks = [...checks, ...parseVerdict(out.call.message, step.checkpoint)];
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
        usage: { ...usage, durationMs, ...(this.costUsd ? { costUsd: this.costUsd } : {}) },
        tainted: this.tainted, startedAt: new Date(input.startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
      };
      await deps.recorder.finish(record);
      return { durationMs };
    })).value;
    return {
      stepRunId: input.stepRunId, status, outcome: finalOutcome, writes,
      ...(this.rationale !== undefined ? { rationale: this.rationale } : {}),
      checkpoint: this.checkpoint, usage: { ...usage, durationMs }, tainted: this.tainted,
      ...(reason ? { reason } : {}),
    };
  }
}

/**
 * The step run's DBOS workflow body, unregistered. The runtime registers it itself (so it can
 * deregister between kernels in tests); everyone else uses `registerAgentStep()`.
 * Start it with `workflowID: input.stepRunId`.
 */
export async function agentStepWorkflow(input: StepRunInput): Promise<StepResult> {
  return new StepRun(input, engineDeps()).run();
}

let registered: ((input: StepRunInput) => Promise<StepResult>) | undefined;

/** Registers `memwise.step.agent` once per process (before DBOS.launch()) and returns the workflow. */
export function registerAgentStep(): (input: StepRunInput) => Promise<StepResult> {
  return (registered ??= DBOS.registerWorkflow(agentStepWorkflow, { name: AGENT_STEP_WORKFLOW }));
}

/** Starts a step run as its own DBOS workflow (id = step run id) and returns the handle. */
export function runAgentStep(input: StepRunInput) {
  return DBOS.startWorkflow(registerAgentStep(), { workflowID: input.stepRunId })(input);
}
