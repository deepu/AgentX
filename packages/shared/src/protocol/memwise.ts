/**
 * MemWise app API: the data shapes the playbook, case, inbox and map screens use
 * (docs/memwise/19-phase-2-interfaces.md).
 *
 * PHASE 2 CONTRACT. `@memwise/server-core` (handlers/rpc/memwise.ts) builds these from the
 * kernel; the renderer only ever sees these shapes, never kernel types. Plain JSON only.
 * Change only additively.
 *
 * Vocabulary: the UI says "playbook" for what the code and files call a workflow.
 */

// ---------------------------------------------------------------- people

export interface MwPerson {
  id: string
  name: string
  email: string
  roles: string[]
}

export interface MwRole {
  id: string
  title: string
  description?: string
}

export interface MwStatus {
  /** The kernel is running and the project is indexed. */
  ready: boolean
  /** Why not, in plain words ("Starting the database…", "No model connected"). */
  message?: string
  /** Who the current client acts as; absent when nobody is signed in. */
  me?: MwPerson
  /** Desktop: the owner may switch who they act as (for trying approvals with two roles). */
  canActAs: boolean
  /**
   * This connection signed in with the person's own account (server mode: a personal token or a
   * web login). Only the playbook screens are available to it; the web app offers to sign out.
   */
  signedIn?: boolean
  /** A model is configured for agent steps; without one, agent steps stop and need a person. */
  modelConfigured: boolean
  /** Project folder holding the playbooks (definitions are files, D13). */
  projectDir?: string
  /** Loader and check diagnostics from the last index. */
  diagnostics: MwDiagnostic[]
}

export interface MwDiagnostic {
  severity: 'error' | 'warning'
  code: string
  message: string
  file?: string
  line?: number
}

// ---------------------------------------------------------------- playbooks (workflows)

export type MwPerformer = 'agent' | 'person' | 'external' | 'system'
export type MwEffectClass = 'read' | 'draft' | 'write' | 'outbound' | 'irreversible'
export type MwTreatment = 'allow' | 'preview' | 'approve' | 'deny'

export interface MwPlaybookSummary {
  id: string
  version: number
  title: string
  /** Number of steps (states with a step file). */
  stepCount: number
  /** Cases by status. */
  open: number
  waitingOnMe: number
  done: number
}

export interface MwField {
  name: string
  /** Type expression as written, e.g. `Identifier(GSTIN)`, `List<Flag>`. */
  type: string
  /** JSON Schema for the value, for generated forms. */
  schema: Record<string, unknown>
  required?: boolean
  description?: string
  /** Roles allowed to see it; absent: everyone. */
  access?: string[]
}

export interface MwToolRef {
  name: string
  description?: string
  effect: MwEffectClass
  /** False when the tool declared no class (counted as irreversible). */
  classified: boolean
  required: boolean
  plugin?: string
}

export interface MwPolicyRule {
  /** What the rule covers, in plain words: "outbound", "email.send", "tokens", "taint". */
  subject: string
  /** Its value in plain words: "needs approval", "40,000", "denied". */
  value: string
  /** The layer it came from. */
  layer: 'platform' | 'plugin' | 'domain' | 'workflow' | 'step'
  layerName: string
  source?: string
  /** Shown but not enforced. */
  notEnforced?: boolean
}

export interface MwStep {
  /** State name, e.g. `check`. */
  id: string
  title: string
  performer: MwPerformer
  /** Role that does a person or external step (or approves it). */
  assignee?: string
  strictness: 'strict' | 'guided' | 'open'
  /** Instructions in Markdown, the expert's own words. */
  instructions: string
  reads: string[]
  writes: MwField[]
  tools: MwToolRef[]
  modelRole?: string
  checkpoint: string[]
  outcomes: string[]
  /** The effective policy the step runs under, each rule with its layer. */
  policy: MwPolicyRule[]
  file: string
}

export interface MwState {
  id: string
  /** Absent for wait states without a step file (e.g. `needs_person`). */
  stepId?: string
  /** outcome or event -> target state (or `end`). */
  on: Record<string, string>
  wait?: { remindMs?: number; timeout?: { afterMs: number; target: string } }
  /** Who handles a wait state with no step file (attention items). */
  assignee?: string
}

export interface MwPlaybook {
  id: string
  version: number
  hash: string
  title: string
  start: string
  /** In the order the playbook reads: start first, then breadth-first along the happy path. */
  states: MwState[]
  steps: Record<string, MwStep>
  caseFields: MwField[]
  diagnostics: MwDiagnostic[]
  /** Case fields a person may fill in when starting a case (the kernel refuses others). */
  startFields?: string[]
}

/** Live mode of the map: where the open cases are. */
export interface MwLiveCounts {
  workflowId: string
  /** state -> number of active runs in it. */
  byState: Record<string, number>
  /** Transitions taken in the last 30 days, `from>to` -> count, for edge weight. */
  edges: Record<string, number>
}

// ---------------------------------------------------------------- cases

export type MwProvenance =
  | { kind: 'input'; at: string; by?: string }
  | { kind: 'tool'; at: string; stepRunId: string; tool: string; callId: string }
  | { kind: 'judgement'; at: string; stepRunId: string; rationale?: string; /** Set when a conversation step's chat wrote it (Phase 3). */ chatId?: string }
  | { kind: 'person'; at: string; by: string; stepRunId?: string }
  | { kind: 'system'; at: string; note?: string }

export interface MwCaseValue {
  value: unknown
  provenance: MwProvenance
  /** Came from untrusted content (an uploaded document) through quarantined reading. */
  tainted?: boolean
  /** The viewer may not see this field; `value` is null. */
  hidden?: boolean
}

/** A file attached to a case (`Document` and `File` values). */
export interface MwDocument {
  id: string
  name: string
  mime: string
  size: number
  sha256: string
}

export type MwRunStatus = 'active' | 'done' | 'stopped'

export interface MwCaseSummary {
  caseId: string
  runId: string
  workflowId: string
  workflowVersion: number
  /** A readable title, e.g. the client's name, else the case id. */
  title: string
  state: string
  stateTitle: string
  status: MwRunStatus
  stopReason?: string
  /** Who the current state waits on, if anyone. */
  waitingOn?: { kind: 'role' | 'agent' | 'system'; role?: string }
  createdAt: string
  updatedAt: string
}

export interface MwStepRunSummary {
  stepRunId: string
  stepId: string
  title: string
  performer: MwPerformer
  attempt: number
  status: 'running' | 'waiting' | 'completed' | 'needs_person' | 'failed'
  outcome?: string
  rationale?: string
  /** Who decided a person step. */
  decidedBy?: string
  comment?: string
  tainted: boolean
  startedAt: string
  finishedAt?: string
}

export interface MwTransition {
  seq: number
  from: string
  to: string
  event: string
  source: 'step' | 'external' | 'timer'
  accepted: boolean
  note?: string
  stepRunId?: string
  at: string
}

export interface MwCase extends MwCaseSummary {
  fields: MwField[]
  values: Record<string, MwCaseValue>
  /** Step runs, oldest first. */
  timeline: MwStepRunSummary[]
  transitions: MwTransition[]
  /** The path the case took through the map, for highlighting: state ids in order. */
  path: string[]
}

/** Why a case is back at a step it already did: the step that sent it back, its outcome and words. */
export interface MwReturnedNote {
  stepTitle: string
  outcome: string
  /** A person's comment, or the agent's rationale. */
  text: string
  /** Person id when a person decided. */
  by?: string
  at?: string
}

export interface MwJournalEntry {
  key: string
  kind: 'context' | 'model' | 'policy' | 'tool' | 'approval' | 'checkpoint'
  name: string
  callId?: string
  request?: unknown
  response?: unknown
  error?: string
  effect?: MwEffectClass
  startedAt: string
  durationMs?: number
  /**
   * The step handles fields this viewer may not see, so `request`, `response` and `error` are
   * left out; name, kind and timings stay.
   */
  redacted?: boolean
  /** With `redacted`: the entry recorded an error. */
  failed?: boolean
}

export interface MwStepRecord extends MwStepRunSummary {
  runId: string
  caseId: string
  workflowId: string
  workflowVersion: number
  modelRole?: string
  /** What the agent saw: the case fields pushed into its prompt. */
  context?: { pushed: Record<string, MwCaseValue>; tools: string[]; modelRole: string }
  outputs: Record<string, MwCaseValue>
  checkpoint: { rule: string; kind: 'structural' | 'verifier'; passed: boolean; reason?: string }[]
  journal: MwJournalEntry[]
  usage: { tokens?: number; modelCalls?: number; durationMs?: number; costUsd?: number }
  /** The step handles fields this viewer may not see: those values are hidden and the journal shows no request or response bodies. */
  restricted?: boolean
}

export interface MwStartCaseInput {
  workflowId: string
  /** Plain initial values (provenance `input`, by the current person). */
  values?: Record<string, unknown>
}

// ---------------------------------------------------------------- inbox

export type MwInboxItem =
  /** A person or external step waiting for input (a form generated from the step's writes). */
  | {
      kind: 'input'
      id: string
      stepRunId: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      stepTitle: string
      assignee?: string
      /** Fields to fill, in order, with current values to prefill. */
      fields: MwField[]
      prefill: Record<string, MwCaseValue>
      outcomes: string[]
      /** Fields shown read-only above the form (the step's reads). */
      context: Record<string, MwCaseValue>
      since: string
      dueAt?: string
      /** The case came back to this step: what sent it back and why (a comment, else the step's rationale). */
      returned?: MwReturnedNote
    }
  /** A person step that only decides (approval card: approve / send back with a comment). */
  | {
      kind: 'decision'
      id: string
      stepRunId: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      stepTitle: string
      instructions: string
      assignee?: string
      outcomes: string[]
      context: Record<string, MwCaseValue>
      since: string
      dueAt?: string
    }
  /** An agent step wants to run an effect that needs approval (e.g. sending an email). */
  | {
      kind: 'approval'
      id: string
      approvalId: string
      stepRunId: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      stepTitle: string
      tool: string
      effect: MwEffectClass
      preview: { summary: string; detail?: unknown }
      /** Why it needs approval, e.g. "outbound needs approval (domain policy)". */
      reason: string
      since: string
    }
  /** A run stopped or is in a needs-a-person state. */
  | {
      kind: 'attention'
      id: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      state: string
      reason: string
      /** What `reason` says, for the screens to word: the run stopped (with `stopReason`), or it waits in a state with no step. */
      reasonCode?: 'stopped' | 'waiting'
      stopReason?: string
      /** Events the state accepts, e.g. `resolved`. */
      events: string[]
      since: string
    }
  /**
   * A conversation step (Phase 3, `engine: open`) waiting on its chat: building or changing a
   * playbook. "Continue" opens the chat anchored to this step run (memwise:chat:open, kind step).
   */
  | {
      kind: 'conversation'
      id: string
      stepRunId: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      stepTitle: string
      assignee?: string
      /** The chat already opened on it, if any. */
      sessionId?: string
      /** The draft being built, when there is one yet. */
      draftId?: string
      since: string
    }
  /** A reminder fired on a waiting step. */
  | {
      kind: 'reminder'
      id: string
      caseId: string
      runId: string
      caseTitle: string
      workflowId: string
      stepTitle: string
      text: string
      /** `still_waiting`: the step has waited past its reminder time (`text` is the English). */
      code?: 'still_waiting'
      since: string
    }

export interface MwSubmitStepInput {
  stepRunId: string
  outcome: string
  values?: Record<string, unknown>
  comment?: string
}

export interface MwSubmitResult {
  applied: boolean
  /** Field -> problems, when values failed validation. */
  errors?: Record<string, string[]>
  /** In English; the screens show the translation of `code` when they know it. */
  message?: string
  /** Why it was refused, e.g. `submit.stale`, `approval.forbidden`, `event.use_submit` (screens translate `memwise.result.<code>`). */
  code?: string
}

/** `memwise:cases:start` refused the starting values: field -> problems, as MwSubmitResult. */
export interface MwStartCaseRefusal {
  applied: false
  errors: Record<string, string[]>
  message?: string
  code?: string
}

export interface MwDecideApprovalInput {
  approvalId: string
  status: 'approved' | 'rejected'
  comment?: string
}

export interface MwSendEventInput {
  runId: string
  event: string
  comment?: string
}

// ---------------------------------------------------------------- explain (chat on a step)

export interface MwExplainInput {
  stepRunId: string
  question: string
}

export interface MwExplanation {
  id: string
  stepRunId: string
  question: string
  /** Markdown, grounded in the step record; says "not recorded" when it isn't. */
  answer: string
  /** Journal keys and fields the answer relied on. */
  cites: { kind: 'journal' | 'output' | 'checkpoint' | 'context'; ref: string; label: string }[]
  grounded: boolean
  at: string
}

/** Open the regular chat screen anchored to a case or step (09 §1). */
export interface MwOpenChatInput {
  anchor: { kind: 'case' | 'step' | 'workflow'; id: string }
}

// ---------------------------------------------------------------- domain

export interface MwEntityType {
  name: string
  fields: MwField[]
  lifecycle?: string[]
}

export interface MwEntityRow {
  id: string
  values: Record<string, MwCaseValue>
  createdAt: string
}

// ---------------------------------------------------------------- uploads

export interface MwUploadInput {
  name: string
  mime: string
  /** File content, base64. */
  data: string
}

// ---------------------------------------------------------------- push

/** Payload of `memwise:changed`: something the screens show changed; refetch what's affected. */
export interface MwChange {
  /** `drafts`: a draft was created, edited, checked, published or discarded (`id` = draft id). */
  kind: 'run' | 'case' | 'inbox' | 'definitions' | 'status' | 'drafts'
  /** The run id for `run` changes. */
  id?: string
  /** The case the changed run belongs to (`run` changes). */
  caseId?: string
  workflowId?: string
}

// ================================================================ Phase 3 (docs/memwise/20-phase-3-interfaces.md)
// PHASE 3 CONTRACT: drafts, change control, versions, building by chat. Change only additively.

export type MwDraftStage =
  /** Being edited; not checked since the last change. */
  | 'draft'
  /** Checks and example cases passed on the current content. */
  | 'checked'
  /** The last check found errors or failing example cases. */
  | 'failed'
  /** Waiting for approval (a change-playbook run is at its review step). */
  | 'in_review'
  | 'published'
  | 'discarded'

export interface MwDraftSummary {
  id: string
  title: string
  workflowId: string
  /** The playbook's title (the draft's, for a new playbook). */
  playbookTitle: string
  kind: 'create' | 'change'
  stage: MwDraftStage
  createdBy?: string
  createdByName?: string
  createdAt: string
  updatedAt: string
  /** Chat edits waiting for keep or discard. */
  pendingEdits: number
  changedFiles: number
  baseVersion?: number
  publishedVersion?: number
  /** The create-playbook / change-playbook run, and its case. */
  runId?: string
  caseId?: string
}

export interface MwDraftEdit {
  id: string
  at: string
  by: string
  byName?: string
  via: 'chat' | 'editor' | 'cli'
  sessionId?: string
  summary: string
  paths: string[]
  status: 'pending' | 'kept' | 'discarded'
}

export interface MwDiffLine { kind: 'same' | 'added' | 'removed'; text: string }
export interface MwDiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: MwDiffLine[] }

export interface MwFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  hunks: MwDiffHunk[]
  /** The live file changed since the draft was made. */
  conflict?: boolean
  /** Which pending chat edit last touched it (for highlighting). */
  pendingEditId?: string
  /** The live file's text (absent for an added file). */
  before?: string
  /** The draft's text (absent for a deleted file). */
  after?: string
}

export type MwChangeKind = 'added' | 'removed' | 'changed'

/** The map's "proposed change" mode and the editor's highlights. */
export interface MwStructuralDiff {
  states: Record<string, MwChangeKind>
  transitions: { from: string; event: string; to: string; change: 'added' | 'removed' }[]
  steps: Record<string, { change: MwChangeKind; parts: string[] }>
  caseFields: { added: string[]; removed: string[]; changed: string[] }
  tools: { added: string[]; removed: string[] }
  requiredTools: { step: string; tool: string; change: 'added' | 'removed' }[]
  roles: { added: string[]; removed: string[] }
  examples: { added: string[]; removed: string[]; changed: string[] }
  version: { from?: number; to?: number }
  playbook: string[]
}

export interface MwExampleOutcome { name: string; status: 'pass' | 'fail' | 'skip'; differences: string[]; reason?: string }

export interface MwPastCaseOutcome {
  caseId: string
  title: string
  status: 'same' | 'different' | 'skip' | 'error'
  differences: string[]
  livePath: string[]
  draftPath: string[]
}

export interface MwImpact {
  liveVersion?: number
  newVersion: number
  openCases: { total: number; byState: Record<string, number> }
  removedStatesWithCases: { state: string; cases: number }[]
  newTools: { name: string; bound: boolean; effect?: MwEffectClass; treatment?: MwTreatment; plugin?: string }[]
  newRequiredTools: { step: string; tool: string }[]
  caseFields: { added: string[]; removed: string[]; changed: string[] }
  otherPlaybooks: { id: string; uses: string[] }[]
  /** Plain sentences for the review card. */
  summary: string[]
}

export interface MwDraftReport {
  hash: string
  at: string
  diagnostics: MwDiagnostic[]
  errors: number
  warnings: number
  examples: MwExampleOutcome[]
  pastCases: MwPastCaseOutcome[]
  impact?: MwImpact
  outcome: 'passed' | 'failed'
  summary: string
}

export interface MwDraft extends MwDraftSummary {
  edits: MwDraftEdit[]
  files: MwFileChange[]
  /** Absent when the draft's playbook doesn't load yet. */
  structure?: MwStructuralDiff
  conflicts: string[]
  report?: MwDraftReport
  /** The draft changed since `report` was made. */
  reportStale: boolean
  /** The draft read as a playbook (for the editor and the map), when it loads. */
  playbook?: MwPlaybook
  /** Checks on the current content (structure and policy; no example cases). */
  diagnostics: MwDiagnostic[]
  /**
   * The draft's files as text, by project-relative path: every file of the draft's playbook folder,
   * plus the domain files it changes (for the step editor). Absent once the draft is closed.
   */
  fileTexts?: Record<string, string>
}

export interface MwCreateDraftInput {
  /** The playbook to change; with `create`, the new playbook's id. */
  workflowId: string
  title: string
  kind?: 'create' | 'change'
}

/** Editor edits: whole files, project-relative paths (`workflows/<id>/steps/check.md`). */
export interface MwWriteDraftInput {
  draftId: string
  files: { path: string; content: string | null }[]
  summary: string
}

export interface MwWriteDraftResult {
  applied: boolean
  editId?: string
  diagnostics: MwDiagnostic[]
  code?: string
  message?: string
}

export interface MwDraftEditInput { draftId: string; editId: string }

export interface MwCheckDraftInput {
  draftId: string
  /** How many recent finished cases of the live version to replay on the draft (default 5; 0 = none). */
  pastCases?: number
}

/** Build a new playbook (no workflowId) or change one, by chat: starts the meta playbook and opens its chat. */
export interface MwBuildPlaybookInput {
  workflowId?: string
  /** What the person wants, in their words; becomes the case's `request`. */
  request?: string
  title?: string
}

export interface MwBuildPlaybookResult {
  sessionId: string
  runId: string
  caseId: string
  stepRunId: string
}

export interface MwSubmitDraftResult {
  applied: boolean
  runId?: string
  caseId?: string
  code?: string
  message?: string
}

export interface MwVersion {
  version: number
  hash: string
  publishedAt: string
  publishedBy?: string
  publishedByName?: string
  source: 'app' | 'cli' | 'files'
  draftId?: string
  runId?: string
  openCases: number
  live: boolean
}

/** Save a case as an example case (a correction becomes a test, 05 §12). */
export interface MwExampleFromCaseInput {
  caseId: string
  name?: string
  /** What a step should have done, when this is a correction: the step and its right outcome. */
  correction?: { step: string; outcome: string; note?: string }
  /** Add to this draft; default a new change draft of the case's playbook. */
  draftId?: string
}

export interface MwExampleFromCaseResult {
  applied: boolean
  draftId?: string
  path?: string
  code?: string
  message?: string
}
