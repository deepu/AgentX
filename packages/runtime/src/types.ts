import type {
  ApprovalDecision, ApprovalRequest, ApprovalStatus, CaseSnapshot, CaseValue, Diagnostic, JournalEntry, StepRecord,
} from '@memwise/defs';
import type { ModelProvider, ModelRoleConfig, SecretProvider, ToolDefinition } from '@memwise/gateway';
import type { StepResult, StepRunInput } from '@memwise/step-engine';
import type pg from 'pg';
import type { RunEvent } from './machine.ts';

/** Runs one agent step. Registered as the DBOS workflow `memwise.step.agent`; tests swap in a fake. */
export type StepExecutor = (input: StepRunInput) => Promise<StepResult>;

export interface KernelOptions {
  databaseUrl: string;
  /** Project folder `index()` loads. */
  projectDir?: string;
  tools: ToolDefinition[];
  modelRoles: Record<string, ModelRoleConfig>;
  providers: ModelProvider[];
  secrets?: SecretProvider;
  /** DBOS executor id; stable per worker slot (S2). Default `local`. */
  executorId?: string;
  /** DBOS applicationVersion: an explicit engine label, never a source hash (D36). */
  engineVersion?: string;
  /** Test override for the agent step workflow. Default: the step engine's agentStepWorkflow. */
  stepExecutor?: StepExecutor;
  /** DBOS log level. Default `warn`. */
  logLevel?: string;
  /** Where uploaded files are kept (content-addressed). Default `MEMWISE_FILES_DIR`, else `~/.memwise/files`. */
  filesDir?: string;
  /** Model role for quarantined reading (`intake.extract_fields`). Default `extractor`. */
  extractorRole?: string;
}

export type RunStatus = 'active' | 'done' | 'stopped';

export interface TimerRecord { timerId: string; armedSeq: number; event: RunEvent; fireAt: string; status: 'pending' | 'fired' | 'cancelled' }

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowHash: string;
  caseId: string;
  state: string;
  status: RunStatus;
  /** Events applied; every transition row bumps it. */
  seq: number;
  /** Seq at which the current state was entered; outside answers name it in `for`. */
  enteredSeq: number;
  stopReason?: string;
  /** Pending timers, earliest first. */
  timers: TimerRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface TransitionRecord {
  seq: number;
  from: string;
  to: string;
  event: RunEvent;
  source: 'step' | 'external' | 'timer';
  accepted: boolean;
  note?: string;
  stepRunId?: string;
  at: string;
}

export interface SendEventOptions {
  idemKey: string;
  forSeq?: number;
  /**
   * Who sends it (Phase 2). A person must hold the state's assignee role (assigneeOf) or the
   * workflow owner's role, else the event is refused with `forbidden`; their id is recorded as
   * the event's `by` (in the transition row). Without `by` (timers, CLI, tests) only the
   * person-step rule applies.
   */
  by?: Actor;
}

export interface SendEventResult {
  sent: boolean;
  /**
   * Why nothing was sent, when it was refused (absent for a repeated `idemKey`):
   * `use_submit` the state is a person or external step, answer it with submitStep;
   * `forbidden` the person lacks the state's role.
   */
  reason?: 'use_submit' | 'forbidden';
  message?: string;
}

export interface StartRunInput {
  workflowId: string;
  /**
   * Plain values; stored with provenance `input`. Each must be a field of the case with a value
   * of its type; started at the workflow's `start`, only the fields a person enters at the start
   * (`startFields`). Otherwise startRun throws a `StartRunError` (field -> problems).
   */
  case: Record<string, unknown>;
  /** State to start in; default the workflow's `start`. */
  startAt?: string;
  runId?: string;
  /** Exact definition to pin (D36); default the latest indexed. */
  workflowHash?: string;
  /** Who started it, recorded in the input provenance. */
  by?: string;
}

export interface Kernel extends KernelPhase2 {
  /** Load the project folder and index it; returns the loader's diagnostics. */
  index(): Promise<Diagnostic[]>;
  startRun(input: StartRunInput): Promise<{ runId: string; caseId: string }>;
  /**
   * An outside event. A repeated `idemKey` sends nothing; `forSeq` names the state entry it
   * answers, by default the run's current one, so an answer never applies to a later state.
   * A person or external step is never decided this way (refused with `use_submit`): submitStep
   * answers it and checks the assignee. With a person `by`, see SendEventOptions.
   */
  sendEvent(runId: string, event: string | RunEvent, opts: SendEventOptions): Promise<SendEventResult>;
  /**
   * Decide a pending approval and wake the waiting step. Deciding twice changes nothing; an
   * approval whose step run is no longer waiting is refused with status `expired`. With `by`, a
   * person without an approver role for the step is refused with status `forbidden` (Phase 2).
   */
  decideApproval(decision: ApprovalDecision, by?: Actor): Promise<{ applied: boolean; status: ApprovalStatus | 'expired' | 'missing' | 'forbidden' }>;
  waitForRun(runId: string, opts: { until: (run: RunRecord) => boolean; timeoutMs: number }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getTransitions(runId: string): Promise<TransitionRecord[]>;
  getCase(caseId: string): Promise<CaseSnapshot | undefined>;
  getStepRecord(stepRunId: string): Promise<(StepRecord & { journal: JournalEntry[] }) | undefined>;
  /** Pending approvals whose step run is waiting for the answer. */
  pendingApprovals(): Promise<ApprovalRequest[]>;
  /** The kernel's own pool on the database, for queries the API doesn't cover. */
  readonly pool: pg.Pool;
  shutdown(): Promise<void>;
}

// ================================================================ Phase 2 (docs/memwise/19-phase-2-interfaces.md)
// PHASE 2 CONTRACT. `@memwise/server-core` codes against these; change only additively.

/** Who is acting (19 §2). `withActor` in `@memwise/db` turns it into Postgres settings RLS reads. */
export type Actor =
  | { kind: 'person'; personId: string; roles: string[] }
  | { kind: 'step'; token: import('@memwise/defs').StepToken }
  | { kind: 'system' };

export interface Person { id: string; name: string; email: string; roles: string[]; disabled?: boolean; createdAt: string }
export interface Role { id: string; title: string; description?: string }

export interface PeopleService {
  list(): Promise<Person[]>;
  get(personId: string): Promise<Person | undefined>;
  byEmail(email: string): Promise<Person | undefined>;
  create(input: { name: string; email: string; roles?: string[]; password?: string }): Promise<Person>;
  setRoles(personId: string, roles: string[]): Promise<Person>;
  setPassword(personId: string, password: string): Promise<void>;
  verifyPassword(email: string, password: string): Promise<Person | undefined>;
  /** A personal sign-in token, returned once; stored as sha256. */
  issueToken(personId: string, label?: string, ttlMs?: number): Promise<string>;
  verifyToken(token: string): Promise<Person | undefined>;
  roles(): Promise<Role[]>;
  /** The actor for a person (roles read now). */
  actorFor(personId: string): Promise<Extract<Actor, { kind: 'person' }>>;
}

/** A Document or File case value (19 §5). */
export interface DocumentValue { id: string; name: string; mime: string; size: number; sha256: string }

export interface SubmitStepInput {
  stepRunId: string;
  outcome: string;
  /** Plain values for the step's writes; validated against their types. */
  values?: Record<string, unknown>;
  comment?: string;
  by: Extract<Actor, { kind: 'person' }>;
}

export interface SubmitResult {
  applied: boolean;
  /** `forbidden`: the person lacks the role; `invalid`: values failed validation; `stale`: the step is no longer waiting. */
  status: 'applied' | 'forbidden' | 'invalid' | 'stale' | 'missing' | 'unknown-outcome';
  errors?: Record<string, string[]>;
  message?: string;
}

export type InboxItem =
  | { kind: 'input' | 'decision'; id: string; stepRunId: string; runId: string; caseId: string; workflowId: string;
      stepId: string; assignee?: string; since: string; dueAt?: string }
  | { kind: 'approval'; id: string; approval: ApprovalRequest; runId: string; caseId: string; workflowId: string; stepId: string;
      since: string }
  | { kind: 'attention'; id: string; runId: string; caseId: string; workflowId: string; state: string; reason: string;
      events: string[]; since: string }
  | { kind: 'reminder'; id: string; runId: string; caseId: string; workflowId: string; stepId: string; stepRunId?: string;
      text: string; since: string };

export interface CaseSummary {
  caseId: string; runId: string; workflowId: string; workflowVersion: number; workflowHash: string;
  state: string; status: RunStatus; stopReason?: string; createdAt: string; updatedAt: string;
  /** For titles: a few leading values. */
  values: Record<string, unknown>;
}

export interface CaseView {
  summary: CaseSummary;
  /** Values with provenance; fields the actor may not see have `hidden: true` and value null. */
  values: Record<string, CaseValue & { hidden?: boolean; tainted?: boolean }>;
  stepRuns: StepRunSummary[];
  transitions: TransitionRecord[];
  /** States entered, in order, starting with the first. */
  path: string[];
}

export interface StepRunSummary {
  stepRunId: string; stepId: string; performer: string; attempt: number;
  status: StepRecord['status']; outcome?: string; rationale?: string; decidedBy?: string; comment?: string;
  tainted: boolean; startedAt: string; finishedAt?: string;
}

export interface LiveCounts { workflowId: string; byState: Record<string, number>; edges: Record<string, number> }

export interface ExplainInput { stepRunId: string; question: string; by: Actor }
export interface Explanation {
  id: string; stepRunId: string; question: string; answer: string;
  cites: { kind: 'journal' | 'output' | 'checkpoint' | 'context'; ref: string; label: string }[];
  grounded: boolean; at: string;
}

export interface EntityRow { id: string; values: Record<string, unknown>; hidden: string[]; createdAt: string }

export type KernelChange =
  | { kind: 'run'; runId: string; caseId: string; workflowId: string }
  | { kind: 'inbox' }
  | { kind: 'definitions' };

export interface KernelPhase2 {
  readonly people: PeopleService;
  submitStep(input: SubmitStepInput): Promise<SubmitResult>;
  inbox(actor: Actor): Promise<InboxItem[]>;
  listCases(filter: { workflowId?: string; status?: RunStatus; limit?: number }, actor: Actor): Promise<CaseSummary[]>;
  getCaseView(caseId: string, actor: Actor): Promise<CaseView | undefined>;
  liveCounts(workflowId: string): Promise<LiveCounts>;
  explain(input: ExplainInput): Promise<Explanation>;
  listEntities(entity: string, actor: Actor): Promise<EntityRow[]>;
  saveFile(input: { name: string; mime: string; data: Uint8Array }, actor: Actor): Promise<DocumentValue>;
  readFile(id: string, actor: Actor): Promise<{ meta: DocumentValue; data: Uint8Array } | undefined>;
  /** The indexed project (definitions as loaded by the last `index()`). */
  project(): Promise<{ project: import('@memwise/defs').ProjectDefs; diagnostics: Diagnostic[] }>;
  effectivePolicy(workflowId: string, stepId: string): Promise<import('@memwise/policy').CompiledPolicy>;
  /** Pushed after commits (LISTEN/NOTIFY on channel `mw_changes`). */
  onChange(listener: (change: KernelChange) => void): () => void;
}
