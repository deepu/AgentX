/**
 * The step engine: our own agent loop on pi-ai for strict and guided steps
 * (docs/memwise/07-agent-runtime.md §1-3, decision D38).
 *
 * PHASE 1 CONTRACT. `@memwise/runtime` starts a step run as a DBOS workflow and receives a
 * `StepResult`. Change only additively.
 */
import type {
  CaseSnapshot, CaseValue, CheckResult, RecordTypeDef, StepDef, StepRecorder, StepRecordReader, StepToken,
} from '@memwise/defs';
import type { ModelGateway, ToolGateway } from '@memwise/gateway';
import type { EffectivePolicy } from '@memwise/policy';

/** Input to one step run. Journaled by DBOS as the workflow input, so it must be plain JSON. */
export interface StepRunInput {
  /** Also the DBOS workflow id: `${runId}/${enteredSeq}/${stepId}` (deterministic, D39). */
  stepRunId: string;
  runId: string;
  workflow: { id: string; version: number; hash: string };
  step: StepDef;
  /** Record types the step's writes may use (the case file's `types:`), e.g. `Flag`. */
  recordTypes: Record<string, RecordTypeDef>;
  case: CaseSnapshot;
  policy: EffectivePolicy;
  token: StepToken;
  attempt: number;
  priorAttempts: { attempt: number; outcome?: string; reason: string }[];
  /** Epoch ms, fixed by the caller so a replay builds identical messages. */
  startedAt: number;
  /**
   * What earlier step runs of this run already used. Budgets set above the step layer
   * (platform, plugin, domain, workflow) are run budgets: they apply to this plus `runSpent`.
   * Budgets set by the step layer apply to this step run alone.
   */
  runSpent?: { tokens: number; modelCalls: number; elapsedMs: number };
}

export type StepResultStatus = 'completed' | 'needs_person' | 'failed';

export interface StepResult {
  stepRunId: string;
  status: StepResultStatus;
  /**
   * One of the step's declared outcomes when `completed`. For `needs_person` and `failed`
   * the runtime routes to the state's `needs_person` / `failed` transition if the shape has
   * one, otherwise the run stops in a needs-a-person condition.
   */
  outcome: string;
  /** Values to write to the case, with provenance. Applied by the runtime when the outcome commits. */
  writes: Record<string, CaseValue>;
  rationale?: string;
  checkpoint: CheckResult[];
  usage: { tokens: number; modelCalls: number; toolCalls: number; durationMs: number };
  tainted: boolean;
  /** Why the step stopped short, for `needs_person` and `failed`. */
  reason?: string;
}

export interface StepEngineDeps {
  tools: ToolGateway;
  models: ModelGateway;
  recorder: StepRecorder;
  /** For the recall tools' read side; optional so the engine runs without a database in unit tests. */
  records?: StepRecordReader;
  /** Model role used to judge prose checkpoint rules. Default `verifier`. */
  verifierRole?: string;
  /** Repair rounds after a failed checkpoint before the step stops with `needs_person`. Default 2. */
  maxRepairs?: number;
  /** Turn limit per step run when the step sets no model-call budget. Default 24. */
  maxTurns?: number;
}

/** The DBOS topic a step waits on for the answer to an approval request. */
export const approvalTopic = (approvalId: string) => `approval:${approvalId}`;

/** Name of the built-in tool the agent calls to finish a step with an outcome and its writes. */
export const FINISH_TOOL = 'step.finish';

export { modelToolName, toolNameFromModel } from '@memwise/gateway';
