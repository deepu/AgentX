/**
 * Kernel records and store interfaces shared across packages.
 *
 * PHASE 1 CONTRACT. These live in `@memwise/defs` because it is the one package every
 * other kernel package may depend on. `@memwise/db` implements the store interfaces;
 * `@memwise/gateway`, `@memwise/step-engine` and `@memwise/runtime` call them.
 * Change only additively.
 */
import type { EffectClass, Money, StepDef, Treatment, WorkflowDef } from './types.ts';

// ---------------------------------------------------------------- provenance and case values

/** Where a case value came from (05 §5: values are typed and carry provenance). */
export type Provenance =
  | { kind: 'input'; at: string; by?: string }
  /** `tainted`: the value came from (or was judged after reading) untrusted content (Phase 2, D21). */
  | {
      kind: 'tool'; at: string; stepRunId: string; tool: string; callId: string; tainted?: boolean;
      /** Phase 5 (D68): read from this document by a form's extraction, with this confidence, and kept by `confirmedBy`. */
      document?: string; confidence?: number; confirmedBy?: string;
      /** Phase 6 (24 §11): where in the document it was read: the page (1-based) and the text quoted. */
      page?: number; quote?: string;
    }
  | { kind: 'judgement'; at: string; stepRunId: string; rationale?: string; tainted?: boolean; /** A conversation step's chat wrote it, for this person (Phase 3). */ chatId?: string; by?: string }
  | { kind: 'person'; at: string; by: string; stepRunId?: string }
  | { kind: 'system'; at: string; note?: string }
  /** Phase 5 (D67): typed by an external participant through a link; always tainted (untrusted input). */
  | { kind: 'external'; at: string; by: string; linkId: string; stepRunId: string; tainted: true };

export interface CaseValue<T = unknown> { value: T; provenance: Provenance }

export interface CaseSnapshot {
  id: string;
  caseType: string;
  /** Number of change events applied; bumps on every write. */
  seq: number;
  values: Record<string, CaseValue>;
}

// ---------------------------------------------------------------- step tokens (08 §1)

/**
 * Names who is acting in a step. Checked by the gateway, written on every journaled call,
 * and (from Phase 2) read by Postgres RLS.
 */
export interface StepToken {
  runId: string;
  caseId: string;
  /** The state the step belongs to. */
  stepId: string;
  stepRunId: string;
  workflowId: string;
  workflowVersion: number;
  /** What the agent is doing, e.g. `intake.check`; for person steps the role. */
  agentRole: string;
  /** The person the step acts for, when there is one. */
  onBehalfOf?: string;
  /**
   * Phase 6 (24 §7): the role a triggered case's steps act for (the trigger's `as`, else the
   * workflow's owner), so `role:` rules treat them as a person in that role would be.
   */
  actsFor?: string;
  issuedAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- step records (05 §11)

export type StepRunStatus = 'running' | 'waiting' | 'completed' | 'needs_person' | 'failed';

/** Exactly what the agent was given. Recorded once per step run, before the first model call. */
export interface AssembledContext {
  systemPrompt: string;
  /** Model-facing tool declarations (names already mapped to provider-safe form). */
  tools: { name: string; tool: string; description: string; parameters: unknown }[];
  /** The case fields pushed into the prompt, with provenance. */
  pushed: Record<string, CaseValue>;
  /** Earlier attempts' failures, when re-running. */
  priorAttempts: { attempt: number; outcome?: string; reason: string }[];
  modelRole: string;
  /** sha256 of systemPrompt + tools, so caching and replays can be compared. */
  hash: string;
}

export type JournalKind = 'context' | 'model' | 'policy' | 'tool' | 'approval' | 'checkpoint';

/** One journaled call inside a step run. `journalKey` is unique per step run (the DBOS step name). */
export interface JournalEntry {
  stepRunId: string;
  journalKey: string;
  kind: JournalKind;
  /** Tool name, model role, or checkpoint rule. */
  name: string;
  /** The model's tool-call id, when the entry belongs to one. */
  callId?: string;
  request: unknown;
  response?: unknown;
  error?: string;
  effect?: EffectClass;
  /** For model calls: provider, model and usage. */
  model?: { provider: string; model: string; usage: TokenUsage; stopReason: string };
  attempt?: number;
  startedAt: string;
  durationMs?: number;
}

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; costUsd?: number }

export interface CheckResult {
  rule: string;
  kind: 'structural' | 'verifier';
  passed: boolean;
  reason?: string;
}

/** The row a finished (or stopped) step run leaves behind. */
export interface StepRecord {
  stepRunId: string;
  runId: string;
  caseId: string;
  stepId: string;
  attempt: number;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  stepHash: string;
  performer: StepDef['performer'];
  status: StepRunStatus;
  outcome?: string;
  token: StepToken;
  context?: AssembledContext;
  /** Values written to the case, with provenance. */
  outputs: Record<string, CaseValue>;
  checkpoint: CheckResult[];
  rationale?: string;
  usage: { tokens: number; modelCalls: number; toolCalls: number; durationMs: number; costUsd?: number; /** Priced model calls (Phase 2); absent when unpriced or in mixed currencies. */ cost?: Money };
  tainted: boolean;
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------- store interfaces (implemented by @memwise/db)

/** Phase 6 adds `domain` (a domain.yaml), `page` and `view` (`<domain>/<id>`). */
export type DefinitionKind = 'workflow' | 'step' | 'case_type' | 'entity_type' | 'policy' | 'domain' | 'page' | 'view';

export interface IndexedDefinition {
  kind: DefinitionKind;
  /** `client-intake`, `client-intake/check`, `Customer`, `domain` ... */
  id: string;
  version?: number;
  hash: string;
  /** File or folder relative to the project root. */
  path: string;
  /** The parsed definition (for `workflow`: the whole WorkflowDef, i.e. the run snapshot). */
  body: unknown;
}

/** A reference from one definition to something it uses, for impact analysis (08 §3). */
export interface DefinitionRef {
  fromKind: DefinitionKind;
  fromId: string;
  fromHash: string;
  toKind: DefinitionKind | 'tool' | 'model_role' | 'case_field';
  toId: string;
}

export interface DefinitionStore {
  /** Idempotent: re-indexing the same hashes changes nothing. */
  upsert(defs: IndexedDefinition[], refs: DefinitionRef[]): Promise<void>;
  /** The workflow snapshot by exact hash (what a run loads, D36). */
  getWorkflow(id: string, hash: string): Promise<WorkflowDef | undefined>;
  /** The latest indexed hash for a workflow id. */
  latestWorkflow(id: string): Promise<WorkflowDef | undefined>;
}

/** Ledger outcome for an idempotency key. */
export type LedgerState =
  | { status: 'new' }
  | { status: 'pending'; startedAt: string }
  | { status: 'done'; result: unknown }
  | { status: 'failed'; error: string };

/**
 * The effect ledger: one row per idempotency key (07 §2). `begin` claims the key; a key
 * already `done` returns its stored result so the effect is never repeated.
 */
export interface EffectLedger {
  begin(key: string, entry: { stepRunId: string; tool: string; effect: EffectClass; args: unknown }): Promise<LedgerState>;
  complete(key: string, result: unknown): Promise<void>;
  fail(key: string, error: string): Promise<void>;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  /** `${stepRunId}:${callId}`; also the topic the step waits on. */
  id: string;
  stepRunId: string;
  tool: string;
  effect: EffectClass;
  treatment: Treatment;
  args: unknown;
  preview: EffectPreview;
  requestedAt: string;
}

export interface ApprovalDecision {
  id: string;
  status: Exclude<ApprovalStatus, 'pending'>;
  by: string;
  comment?: string;
  at: string;
}

/** What will happen if an effect runs, for approval cards and the record. */
export interface EffectPreview {
  summary: string;
  /** Tool-specific detail, e.g. `{ to, subject, body }` for an email. */
  detail?: unknown;
}

/**
 * Writes the step record as a step runs. Every method is idempotent on its key, because
 * a resumed step may call it again for work that was already recorded.
 */
export interface StepRecorder {
  start(record: Pick<StepRecord, 'stepRunId' | 'runId' | 'caseId' | 'stepId' | 'attempt' | 'workflowId' | 'workflowVersion' | 'workflowHash' | 'stepHash' | 'performer' | 'token' | 'startedAt'>): Promise<void>;
  context(stepRunId: string, context: AssembledContext): Promise<void>;
  journal(entry: JournalEntry): Promise<void>;
  approvalRequested(request: ApprovalRequest): Promise<void>;
  /** Status changes while running, e.g. `waiting` during an approval and back to `running`. */
  status(stepRunId: string, status: StepRunStatus): Promise<void>;
  finish(record: StepRecord): Promise<void>;
}

/** Read side used by recall tools and the CLI. */
export interface StepRecordReader {
  get(stepRunId: string): Promise<(StepRecord & { journal: JournalEntry[] }) | undefined>;
  forCase(caseId: string): Promise<StepRecord[]>;
  /** Finished step runs of the same step on other cases, most similar first (Phase 1: same case type, matching field values). */
  similar(opts: { workflowId: string; stepId: string; caseValues: Record<string, unknown>; excludeCaseId?: string; limit: number }): Promise<StepRecord[]>;
}
