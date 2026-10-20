/**
 * Test doubles and fixtures: a fresh DBOS system database per test file, in-memory recorder,
 * ledger, scripted model gateway and tool gateway, and step-run inputs built from the sample
 * intake project.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import {
  loadProject, type ApprovalRequest, type AssembledContext, type CaseValue, type EffectClass, type EffectLedger,
  type ExampleCase, type JournalEntry, type LedgerState, type ScriptedTurn, type StepDef, type StepRecord,
  type StepRecorder, type StepRunStatus, type StepToken, type WorkflowDef,
} from '@memwise/defs';
import {
  BudgetExceededError, createModelGateway, createToolGateway, exceededLimit, modelToolName, scriptedProvider, stubTools,
  type GatewayDecision, type ModelCallResult, type ModelGateway, type ModelRequest, type ToolDefinition, type ToolGateway,
} from '@memwise/gateway';
import { compilePolicy, decide, layersFor, type EffectivePolicy } from '@memwise/policy';
import { createTestDatabase } from '@memwise/db';
import { join } from 'node:path';
import type { StepRunInput } from '../src/index.ts';

export const APP_VERSION = 'memwise-step-engine-test-1';
export const PROJECT_ROOT = join(import.meta.dir, '../../../examples/intake');

// ---------------------------------------------------------------- databases and DBOS

/** A fresh database for DBOS's system tables: on MEMWISE_TEST_DATABASE_URL when set, else a throwaway cluster. */
export async function createDatabase(label: string): Promise<{ url: string; drop(): Promise<void> }> {
  const db = await createTestDatabase(`mw_se_${label}`, { migrate: false });
  return { url: db.url, drop: () => db.drop() };
}

export async function launchDbos(systemDatabaseUrl: string) {
  DBOS.setConfig({ name: 'memwise-step-engine-test', systemDatabaseUrl, applicationVersion: APP_VERSION, runAdminServer: false, logLevel: 'error' });
  await DBOS.launch();
}

// ---------------------------------------------------------------- recorder and ledger

export class MemoryRecorder implements StepRecorder {
  starts: string[] = [];
  contexts = new Map<string, AssembledContext>();
  journals = new Map<string, JournalEntry[]>();
  approvals: ApprovalRequest[] = [];
  statuses: { stepRunId: string; status: StepRunStatus }[] = [];
  records = new Map<string, StepRecord>();

  async start(r: { stepRunId: string }) { this.starts.push(r.stepRunId); }
  async context(id: string, c: AssembledContext) { this.contexts.set(id, c); }
  async journal(e: JournalEntry) {
    const list = this.journals.get(e.stepRunId) ?? [];
    // Idempotent on the key, as the contract requires.
    if (!list.some((x) => x.journalKey === e.journalKey)) list.push(e);
    this.journals.set(e.stepRunId, list);
  }
  async approvalRequested(r: ApprovalRequest) { if (!this.approvals.some((a) => a.id === r.id)) this.approvals.push(r); }
  async status(stepRunId: string, status: StepRunStatus) { this.statuses.push({ stepRunId, status }); }
  async finish(r: StepRecord) { this.records.set(r.stepRunId, r); }

  keys(id: string) { return (this.journals.get(id) ?? []).map((e) => e.journalKey); }
  entry(id: string, key: string) { return this.journals.get(id)?.find((e) => e.journalKey === key); }
}

export class MemoryLedger implements EffectLedger {
  rows = new Map<string, LedgerState>();
  async begin(key: string): Promise<LedgerState> {
    const row = this.rows.get(key);
    if (row) return row;
    this.rows.set(key, { status: 'pending', startedAt: new Date().toISOString() });
    return { status: 'new' };
  }
  async complete(key: string, result: unknown) { this.rows.set(key, { status: 'done', result }); }
  async fail(key: string, error: string) { this.rows.set(key, { status: 'failed', error }); }
}

// ---------------------------------------------------------------- model gateway double

/** Turns by conversation turn (like the real scripted provider), or a function of the call count per role. */
export type RoleScript = ScriptedTurn[] | ((request: ModelRequest, n: number) => ScriptedTurn);

/** A scripted ModelGateway double: budget check, deterministic replies, a call log. */
export class ScriptedModels implements ModelGateway {
  calls: { role: string; turn: number }[] = [];
  constructor(private readonly script: Record<string, RoleScript>) {}
  roles() { return Object.fromEntries(Object.keys(this.script).map((r) => [r, { provider: 'double', model: r }])); }
  async call(request: ModelRequest, opts: Parameters<ModelGateway['call']>[1]): Promise<ModelCallResult> {
    const limit = exceededLimit(opts.budget, opts.spent);
    if (limit) throw new BudgetExceededError(limit, opts.budget!, opts.spent!);
    const turn = request.messages.filter((m) => m.role === 'assistant').length;
    const n = this.calls.filter((c) => c.role === opts.role).length;
    this.calls.push({ role: opts.role, turn });
    const s = this.script[opts.role];
    const step = typeof s === 'function' ? s(request, n) : s?.[turn];
    if (!step) throw new Error(`no scripted turn for ${opts.role} turn ${turn}`);
    const content: AssistantMessage['content'] = [];
    if (step.text) content.push({ type: 'text', text: step.text });
    (step.toolCalls ?? []).forEach((c, i) => content.push({ type: 'toolCall', id: `t${turn}_${opts.role}_${n}_${i}`, name: modelToolName(c.name), arguments: c.args as ToolCall['arguments'] }));
    const usage = { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const message: AssistantMessage = {
      role: 'assistant', content, api: 'anthropic-messages', provider: 'double', model: opts.role, usage,
      stopReason: step.toolCalls?.length ? 'toolUse' : 'stop', timestamp: request.messages.at(-1)?.timestamp ?? 0,
    };
    return { message, provider: 'double', model: opts.role, usage: { input: 50, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, durationMs: 1 };
  }
}

// ---------------------------------------------------------------- tool gateway double

/** A ToolGateway double: decisions from the real `decide`, a log of every check's taint state, no ledger. */
export class FakeTools implements ToolGateway {
  checks: { tool: string; tainted: boolean }[] = [];
  executed: { tool: string; idempotencyKey: string }[] = [];
  constructor(private readonly tools: ToolDefinition[]) {}
  bound() { return Object.fromEntries(this.tools.map((t) => [t.name, { effect: typeof t.effect === 'string' ? t.effect : undefined }])); }
  get(name: string) { return this.tools.find((t) => t.name === name); }
  async check(req: { tool: string; args: unknown }, policy: EffectivePolicy, state: { tainted: boolean }): Promise<GatewayDecision> {
    this.checks.push({ tool: req.tool, tainted: state.tainted });
    const effect = (this.get(req.tool)?.effect as EffectClass | undefined) ?? 'irreversible';
    const decision = decide(policy, { tool: req.tool, effect, classified: true, tainted: state.tainted });
    return { tool: req.tool, effect, classified: true, decision, ...(decision.verdict === 'approve' ? { preview: { summary: `${req.tool}` } } : {}) };
  }
  async execute(req: { tool: string; args: unknown; idempotencyKey: string; token: StepToken }, decision: GatewayDecision) {
    if (decision.decision.verdict === 'deny') return { status: 'denied' as const, reason: decision.decision.reason };
    this.executed.push({ tool: req.tool, idempotencyKey: req.idempotencyKey });
    const result = await this.get(req.tool)!.execute(req.args, { idempotencyKey: req.idempotencyKey, token: req.token, secrets: {} });
    return { status: 'ok' as const, result, effect: decision.effect, replayed: false };
  }
}

// ---------------------------------------------------------------- the intake fixture

const loaded = await loadProject(PROJECT_ROOT);
export const project = loaded.project;
export const workflow: WorkflowDef = project.workflows['client-intake']!;
export const example = (name: string): ExampleCase => workflow.examples.find((e) => e.name === name)!;

const obj = { type: 'object', additionalProperties: true };

/** The intake tools, stubbed with an example's results. */
export function intakeTools(ex: ExampleCase, extra: ToolDefinition[] = []) {
  const defs: ToolDefinition[] = [
    { name: 'gst.validate_gstin', description: 'Validate a GSTIN with the GST registry.', inputSchema: { ...obj, properties: { gstin: { type: 'string' } }, required: ['gstin'] }, effect: 'read', execute: async () => null },
    { name: 'intake.extract_fields', description: 'Extract fields from uploaded documents.', inputSchema: obj, effect: 'read', execute: async () => null },
    { name: 'email.send', description: 'Send an email.', inputSchema: obj, effect: 'outbound', idempotent: true, execute: async () => null },
    ...extra,
  ];
  return stubTools(defs, (ex.tools ?? {}) as Record<string, unknown>);
}

/** Real gateways over the example: createToolGateway + createModelGateway + scriptedProvider. */
export function realGateways(ex: ExampleCase, opts: { extra?: ToolDefinition[]; script?: Record<string, ScriptedTurn[]>; onCall?: (role: string, turn: number) => void } = {}) {
  const tools = intakeTools(ex, opts.extra);
  const ledger = new MemoryLedger();
  const script = opts.script ?? ex.model ?? {};
  const models = createModelGateway({
    roles: Object.fromEntries(Object.keys(script).map((r) => [r, { provider: 'scripted', model: r }])),
    providers: [scriptedProvider(script, { onCall: opts.onCall })],
  });
  return { tools: createToolGateway({ tools, ledger }), models, calls: tools.calls, ledger };
}

const STARTED_AT = Date.parse('2026-10-20T10:00:00.000Z');

export function stepInput(id: string, ex: ExampleCase, change: (step: StepDef) => StepDef = (s) => s): StepRunInput {
  const step = change(structuredClone(workflow.steps.check!));
  const runId = `run_${id}`;
  const stepRunId = `${runId}/1/${step.id}`;
  const at = new Date(STARTED_AT).toISOString();
  const values: Record<string, CaseValue> = Object.fromEntries(
    Object.entries(ex.case).map(([k, v]) => [k, { value: v, provenance: { kind: 'input', at } }]),
  );
  const policy = compilePolicy(layersFor({ domainPolicy: project.domainPolicy, workflow, step })).effective;
  const token: StepToken = {
    runId, caseId: `case_${id}`, stepId: step.id, stepRunId, workflowId: workflow.id, workflowVersion: workflow.version,
    agentRole: 'intake.check', issuedAt: at, expiresAt: new Date(STARTED_AT + 86_400_000).toISOString(),
  };
  return {
    stepRunId, runId, workflow: { id: workflow.id, version: workflow.version, hash: workflow.hash }, step,
    recordTypes: workflow.caseType.types, case: { id: `case_${id}`, caseType: workflow.caseType.id, seq: 1, values },
    policy, token, attempt: 1, priorAttempts: [], startedAt: STARTED_AT,
  };
}

/** Polls until `fn` is truthy (for waiting on a running workflow from the test). */
export async function until<T>(fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
