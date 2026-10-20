import type {
  ApprovalDecision, ApprovalRequest, ApprovalStatus, CaseSnapshot, Diagnostic, JournalEntry, StepRecord,
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

export interface StartRunInput {
  workflowId: string;
  /** Plain values; stored with provenance `input`. */
  case: Record<string, unknown>;
  /** State to start in; default the workflow's `start`. */
  startAt?: string;
  runId?: string;
  /** Exact definition to pin (D36); default the latest indexed. */
  workflowHash?: string;
  /** Who started it, recorded in the input provenance. */
  by?: string;
}

export interface Kernel {
  /** Load the project folder and index it; returns the loader's diagnostics. */
  index(): Promise<Diagnostic[]>;
  startRun(input: StartRunInput): Promise<{ runId: string; caseId: string }>;
  /**
   * An outside event. A repeated `idemKey` sends nothing; `forSeq` names the state entry it
   * answers, by default the run's current one, so an answer never applies to a later state.
   */
  sendEvent(runId: string, event: string | RunEvent, opts: { idemKey: string; forSeq?: number }): Promise<{ sent: boolean }>;
  /**
   * Decide a pending approval and wake the waiting step. Deciding twice changes nothing; an
   * approval whose step run is no longer waiting is refused with status `expired`.
   */
  decideApproval(decision: ApprovalDecision): Promise<{ applied: boolean; status: ApprovalStatus | 'expired' | 'missing' }>;
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
