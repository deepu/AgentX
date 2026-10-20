/**
 * Tool and effect gateway, and the thin model gateway (docs/memwise/07-agent-runtime.md §4-5).
 *
 * PHASE 1 CONTRACT. `@memwise/step-engine` calls these; `@memwise/runtime` wires them with
 * the stores from `@memwise/db`. Change only additively.
 */
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type {
  EffectClass, EffectLedger, EffectPreview, JournalEntry, Money, ScriptedTurn, StepToken, TokenUsage,
} from '@memwise/defs';
import type { PolicyDecision } from '@memwise/policy';

// ---------------------------------------------------------------- tools

/** MCP tool annotations, used to seed the class of imported tools (06 §3). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  /** Pass to the provider where it supports idempotency keys. */
  idempotencyKey: string;
  token: StepToken;
  /** Injected by the gateway from the secret provider; never shown to the model or journaled. */
  secrets: Record<string, string>;
  signal?: AbortSignal;
}

export interface ToolDefinition<A = any, R = any> {
  /** Dotted name, e.g. `gst.validate_gstin`. */
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Declared class, or a function of the arguments. Undefined: unclassified, treated as `irreversible`. */
  effect?: EffectClass | ((args: A) => EffectClass);
  /** Reads untrusted content: its results taint the session (07 §6). */
  quarantine?: boolean;
  /** The provider honours `ctx.idempotencyKey`, so a call whose result was lost may be retried with the same key. */
  idempotent?: boolean;
  /** Secret names to inject into `ctx.secrets`. */
  secrets?: string[];
  /** What would happen, for `draft`, `outbound` and `irreversible` tools. */
  preview?(args: A): EffectPreview | Promise<EffectPreview>;
  execute(args: A, ctx: ToolContext): Promise<R>;
  source?: { plugin?: string; mcpServer?: string; annotations?: McpToolAnnotations };
}

export interface SecretProvider {
  get(name: string, token: StepToken): Promise<string | undefined>;
}

export interface ToolCallRequest {
  tool: string;
  args: unknown;
  /** The model's tool-call id. */
  callId: string;
  /** D38: `${workflowID}:${stepID}` of the DBOS step that executes the call. */
  idempotencyKey: string;
  token: StepToken;
  /** Passed to the tool as `ctx.signal`, e.g. the DBOS step's cancel signal. */
  signal?: AbortSignal;
}

/** Policy and classification for one call. Pure given its inputs, so the step engine journals it. */
export interface GatewayDecision {
  tool: string;
  effect: EffectClass;
  classified: boolean;
  decision: PolicyDecision;
  /** Present for verdicts `preview` and `approve`. */
  preview?: EffectPreview;
  /**
   * The tool's rate limit under the policy, copied at check time so it is journaled with the
   * decision; `execute` counts the call against it (19 §7).
   */
  rateLimit?: { count: number; perMs: number };
}

export type GatewayCallResult =
  | { status: 'ok'; result: unknown; effect: EffectClass; /** Came from the ledger, the effect did not run again. */ replayed: boolean }
  | { status: 'denied'; reason: string }
  /** An earlier attempt started the effect and its result was lost; the tool is not idempotent, so it is not retried blindly. */
  | { status: 'unknown'; reason: string }
  | { status: 'error'; error: string };

/** Provider-safe tool name: `gst.validate_gstin` -> `gst__validate_gstin` (providers reject dots). */
export const modelToolName = (tool: string) => tool.replaceAll('.', '__');
export const toolNameFromModel = (name: string) => name.replaceAll('__', '.');

// ---------------------------------------------------------------- models

export interface ModelRoleConfig {
  /** Provider id registered with the gateway, e.g. `anthropic` or `scripted`. */
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Tried in order when the primary provider fails. */
  fallbacks?: { provider: string; model: string; price?: ModelPrice }[];
  /** What the model costs, so money budgets can be enforced (19 §7). Absent: pi-ai's USD cost, if any. */
  price?: ModelPrice;
}

/** Price per million tokens. */
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number; currency: string }

export interface ModelRequest {
  systemPrompt: string;
  messages: Message[];
  tools: { name: string; description: string; parameters: unknown }[];
}

export interface ModelCallOptions {
  role: string;
  /** Stable across resume (the step run id); providers use it for cache affinity. */
  sessionId: string;
  signal?: AbortSignal;
}

export interface ModelProvider {
  id: string;
  /** One attempt, no internal retries (retries belong to the DBOS step policy, D38). */
  complete(model: string, request: ModelRequest, options: ModelCallOptions & { maxTokens?: number; temperature?: number }): Promise<AssistantMessage>;
}

// Money is not a key here (step engines iterate `keyof Budget` over numeric limits): price calls
// with `spendOf` and compare with `exceedsMoney` (money.ts).
export interface Budget { tokens?: number; modelCalls?: number; timeMs?: number }
export interface Spent { tokens: number; modelCalls: number; elapsedMs: number }

export interface ModelCallResult {
  message: AssistantMessage;
  provider: string;
  model: string;
  usage: TokenUsage;
  durationMs: number;
  /** What this call cost (`spendOf(usage, price)`); absent when nothing prices it. */
  cost?: Money;
}

/** Thrown before a call that would exceed the budget; the step takes its designed outcome. */
export class BudgetExceededError extends Error {
  constructor(readonly limit: keyof Budget, readonly budget: Budget, readonly spent: Spent) {
    super(`budget exceeded: ${limit}`);
    this.name = 'BudgetExceededError';
  }
}

/** Optional sink for every model call made through the gateway (metering; the step engine journals separately). */
export interface ModelCallSink {
  record(entry: Pick<JournalEntry, 'name' | 'model' | 'startedAt' | 'durationMs' | 'error'> & { sessionId: string }): Promise<void> | void;
}

// ---------------------------------------------------------------- the two gateways

export interface ToolGateway {
  /** Tools bound in the domain (names), with their class; unclassified tools have `effect` undefined. */
  bound(): Record<string, { effect?: EffectClass }>;
  get(name: string): ToolDefinition | undefined;
  /** Resolve the class for these arguments, run policy, build a preview when the verdict needs one. */
  check(req: Pick<ToolCallRequest, 'tool' | 'args' | 'token'>, policy: import('@memwise/policy').EffectivePolicy, state: { tainted: boolean }): Promise<GatewayDecision>;
  /**
   * Run the call through the ledger with secrets injected. The caller has already obtained an
   * `allow`/`preview` verdict, or an approval for an `approve` verdict. Never throws for tool
   * errors; returns `{ status: 'error' }`.
   */
  execute(req: ToolCallRequest, decision: GatewayDecision): Promise<GatewayCallResult>;
}

export interface ToolGatewayOptions {
  tools: ToolDefinition[];
  ledger: EffectLedger;
  secrets?: SecretProvider;
  /** Counts calls of rate-limited tools (19 §7); without it rate limits are not enforced. `PgRateCounter` in @memwise/db. */
  rates?: RateCounter;
  /** What calls are counted per (the domain). Default `domain`. */
  rateScope?: string;
}

/** Counts tool calls for rate limits. */
export interface RateCounter {
  /**
   * Counts one call of `tool` in `scope` if fewer than `limit.count` were counted in the last
   * `limit.perMs`, atomically; otherwise counts nothing and refuses.
   */
  take(tool: string, scope: string, limit: { count: number; perMs: number }): Promise<{ allowed: boolean; used: number }>;
}

export interface ModelGateway {
  roles(): Record<string, ModelRoleConfig>;
  /** Throws BudgetExceededError before calling when `spent` already meets `budget`. */
  call(request: ModelRequest, options: ModelCallOptions & { budget?: Budget; spent?: Spent }): Promise<ModelCallResult>;
}

export interface ModelGatewayOptions {
  roles: Record<string, ModelRoleConfig>;
  providers: ModelProvider[];
  sink?: ModelCallSink;
}

export type { EffectLedger, ScriptedTurn };
