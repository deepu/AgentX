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
  /** Phase 4: a plugin's workflow (referenced through its binding) or a fork of one. */
  origin?: MwWorkflowOrigin
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
  /** Phase 4: a plugin's workflow (referenced through its binding) or a fork of one. */
  origin?: MwWorkflowOrigin
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
      /** Phase 4: a bind-plugin step (`fix`): the screens show the binding review instead of a form. */
      binding?: MwInboxBinding
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
      /** Phase 4: the bind-plugin `fix` step was sent back by the reviewer: their step, outcome and comment. */
      returned?: MwReturnedNote
      /** Phase 4: a bind-plugin step (`fix`, `review`): the screens show the binding review. */
      binding?: MwInboxBinding
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
  /**
   * Phase 4: an uncertain identity match (22 §6): a domain record and a connector's record that
   * may be the same. "Same record" links them; "Different" records the rejection. No case.
   */
  | {
      kind: 'identity'
      id: string
      candidateId: string
      /** Not part of a case or run (absent; declared so code reading any item's case compiles). */
      caseId?: undefined
      runId?: undefined
      workflowId?: undefined
      /** The domain record's title, for the list row. */
      caseTitle: string
      /** "Same company?" in plain words, for the list row. */
      stepTitle: string
      entity: string
      recordId: string
      plugin: string
      pluginTitle: string
      source: string
      externalId: string
      /** 0..1 */
      score: number
      /** Plain words: "same GSTIN", "name 0.82 similar". */
      reasons: string[]
      /** The domain record's values (fields the viewer may not see are left out). */
      record: Record<string, unknown>
      /** The outside record's mapped values when the match was made. */
      external: Record<string, unknown>
      /** The fields to show side by side, in order (the identity keys first). */
      fields: string[]
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
  /** Phase 4: the outside records this row is linked to (a source badge each). */
  links?: MwEntityLinkBadge[]
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
  /**
   * `drafts`: a draft was created, edited, checked, published or discarded (`id` = draft id).
   * `plugins` (Phase 4): a plugin was installed, or a binding or identity link changed.
   */
  kind: 'run' | 'case' | 'inbox' | 'definitions' | 'status' | 'drafts' | 'plugins'
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
  /** `binding` (Phase 4): a plugin's binding (`domain/bindings/<slug>.yaml`), edited on the binding review screen. */
  kind: 'create' | 'change' | 'binding'
  /** Binding drafts: the plugin and version the binding is for. */
  plugin?: { id: string; version: string }
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
  /** The run is still at its chat step: the draft is finished (and sent for review) from that chat. */
  inChat?: boolean
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
  /**
   * Other live playbooks that use what changed. `uses` is in English (the CLI's words); the app
   * shows `title`, `entities` and `roles`.
   */
  otherPlaybooks: { id: string; uses: string[]; title?: string; entities?: string[]; roles?: string[] }[]
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
  /** Phase 4: a plugin playbook's version came from its binding ("from Client intake 1.0.0 · binding 2"). */
  origin?: MwWorkflowOrigin
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

// ================================================================ Phase 4 (docs/memwise/22-phase-4-interfaces.md)
// PHASE 4 CONTRACT: plugins, bindings, identity, read-through. Change only additively.

/** Who wrote the plugin (06 §10). Imported Claude plugins are `community`. */
export type MwPluginTrust = 'first-party' | 'verified' | 'community' | 'local'

/** Where a workflow comes from (06 §5): referenced from a plugin through its binding, or forked from one. */
export interface MwWorkflowOrigin {
  kind: 'plugin' | 'fork'
  plugin: string
  /** The plugin's title, for "from Client intake 1.0.0". */
  pluginTitle: string
  pluginVersion: string
  bindingVersion?: number
}

/** Where a plugin stands in this domain. */
export type MwBindingState =
  | { status: 'unbound' }
  /** A bind-plugin case is open for it. */
  | { status: 'binding'; runId: string; caseId: string; draftId?: string }
  | { status: 'bound'; version: number; pluginVersion: string; frozenAt?: string; frozenBy?: string; frozenByName?: string }

export interface MwPluginSummary {
  id: string
  /** Newest installed version. */
  version: string
  /** Every installed version, newest first. */
  versions: string[]
  title: string
  description?: string
  trust: MwPluginTrust
  /** Converted from a Claude plugin (`.claude-plugin/plugin.json`). */
  imported?: 'claude-plugin'
  /** Number of tools. */
  tools: number
  workflows: string[]
  /** Capability names it provides / requires. */
  provides: string[]
  requires: string[]
  binding: MwBindingState
  /** Bound to an older version than the newest installed. */
  upgradeAvailable?: boolean
}

/** Where a tool's effect class came from: the manifest, MCP hints, the binding (agent or person), or nowhere. */
export type MwClassSource = 'declared' | 'annotations' | 'binding' | 'none'

export interface MwPluginTool {
  name: string
  description: string
  /** Effective class in this domain; absent = unclassified (counts as irreversible). */
  effect?: MwEffectClass
  from: MwClassSource
  /** Bound `off`: not available to any step. */
  off?: boolean
  /** The manifest's class, when it declares one (a binding may tighten, never loosen it). */
  declared?: MwEffectClass
  /** The class the MCP annotations suggest (`readOnlyHint` → read, `destructiveHint` → irreversible). */
  hinted?: MwEffectClass
  /** Why the binding chose its class (the binder agent's reason, or a person's note). */
  reason?: string
  /** How the core reaches its code. */
  route: 'builtin' | 'mcp' | 'command'
  /** The capability it provides, if any. */
  capability?: string
}

export interface MwPluginWorkflow {
  id: string
  title: string
  /** Resolved into this domain through a frozen binding (a live playbook). */
  live: boolean
}

export interface MwBindingVersion {
  version: number
  pluginVersion: string
  hash: string
  frozenBy?: string
  frozenByName?: string
  runId?: string
  draftId?: string
  frozenAt: string
}

export interface MwPluginDetail extends MwPluginSummary {
  dir: string
  hash: string
  /** Tools with their effective class in this domain and where it came from. */
  toolList: MwPluginTool[]
  workflowList: MwPluginWorkflow[]
  skills: { name: string; description?: string }[]
  /** Capabilities it provides (name → tool) and requires (name → the name its workflows use, and what the binding fills it with). */
  providesList: { name: string; tool: string }[]
  requiresList: { name: string; as: string; optional?: boolean; boundTo?: string }[]
  /** Entities it expects, in its own terms. */
  entities: { name: string; fields: { name: string; type: string; required?: boolean }[] }[]
  roles: { id: string; title: string }[]
  /** Record kinds a connector exposes (mapped onto domain entities by the binding). */
  records: { name: string; title?: string; key: string; fields: Record<string, string> }[]
  /** MCP servers it brings: a command, a URL, or a connector set up in the workspace. */
  servers: { name: string; kind: 'command' | 'url' | 'source'; detail: string }[]
  /** Install notes (ignored Claude plugin parts, discovery problems). */
  notes: string[]
  /** Recorded only (built in Phase 7). */
  environment?: { runtime?: string; network?: string[] }
  /** Freezes of its binding, newest first. */
  bindingHistory: MwBindingVersion[]
}

/** A plugin folder on the machine running the kernel that can be installed (an example, or a workspace connector). */
export interface MwInstallableSource {
  slug: string
  name: string
  /** Folder on the machine running the kernel. */
  dir: string
  description?: string
  /** The plugin id, when known. */
  pluginId?: string
  /** The version already installed, when the same id is. */
  installed?: string
}

/** `memwise:plugins:examples`: what the Install dialog offers. */
export interface MwInstallChoices {
  /** Example plugins shipped with the app (`examples/plugins/`). */
  examples: MwInstallableSource[]
  /** MCP connectors set up in this workspace, installable as plugins `source/<slug>`. */
  sources: MwInstallableSource[]
  /** This connection may install (the owner's own connection). */
  canInstall: boolean
  /** It may also install from any folder path (desktop). */
  canInstallPath: boolean
}

export interface MwInstallPluginInput {
  /** A folder on the machine running the kernel: a MemWise plugin, or a Claude plugin. */
  path: string
}

export interface MwBindResult {
  runId: string
  caseId: string
}

// ---------------------------------------------------------------- bindings

/** A deterministic transform (no model when a mapping runs), applied left to right. */
export type MwTransform =
  | 'trim' | 'lower' | 'upper' | 'digits' | 'squash'
  | { default: unknown }
  | { map: Record<string, unknown> }
  | { money: string }
  | { template: string }

export interface MwFieldMapping {
  /** Source field (dotted path); absent with a `template` transform. */
  from?: string
  transform?: MwTransform[]
  /** Default `read`. */
  direction?: 'read' | 'write' | 'both'
}

export interface MwIdentityRules {
  keys: string[]
  fuzzy?: { field: string; auto: number; review: number }
  createMissing?: boolean
}

export interface MwRecordBinding {
  entity: string
  /** Domain field → mapping. */
  fields: Record<string, MwFieldMapping>
  identity: MwIdentityRules
}

export type MwTreatmentMap = Partial<Record<MwEffectClass, MwTreatment>>

/** A policy layer as data (the binding's tightening), in the shape the YAML reads. */
export interface MwPolicyDoc {
  effects?: MwTreatmentMap
  tools?: {
    allow?: string[]
    deny?: string[]
    require?: string[]
    rules?: Record<string, { treatment?: MwTreatment; rateLimit?: { count: number; perMs: number } }>
  }
  budgets?: { tokens?: number; timeMs?: number; modelCalls?: number; money?: { amount: number; currency: string } }
  modelRoles?: string[]
  taint?: { enabled?: boolean; outboundWhenTainted?: MwTreatment }
  approvals?: { by?: string[] }
}

/** `domain/bindings/<slug>.yaml`, as data. */
export interface MwBinding {
  plugin: string
  pluginVersion: string
  pluginHash: string
  /** Bumped by every freeze; 0 in a draft never frozen. */
  version: number
  frozen?: { by: string; byName?: string; at: string; runId?: string }
  tools: Record<string, { effect?: MwEffectClass; off?: boolean; reason?: string }>
  /** Capability → the bound tool that provides it. */
  capabilities: Record<string, string>
  /** Plugin entity → domain entity and field renames (plugin field → domain field). */
  entities: Record<string, { entity: string; fields: Record<string, string> }>
  /** Plugin role → domain role. */
  roles: Record<string, string>
  records: Record<string, MwRecordBinding>
  policy?: MwPolicyDoc
  dryRun?: { at: string; hash: string; passed: boolean; summary: string }
}

export interface MwBindingGap {
  kind: 'tool-unclassified' | 'capability-missing' | 'entity-unmapped' | 'field-unmapped' | 'role-unmapped' | 'record-unmapped' | 'type-mismatch'
  /** The plugin's name for the thing (tool, capability, `Client.tax_id`, role, record source). */
  subject: string
  message: string
  suggestions?: string[]
}

/** One sample record pushed through a mapping at dry run. */
export interface MwMappedRecord {
  source: string
  externalId: string
  /** The record as the connector returned it, when the dry run kept it ("before"). */
  raw?: Record<string, unknown>
  /** Domain field → value after the transforms ("after"). */
  values: Record<string, unknown>
  /** Fields no mapping uses, kept under the plugin's namespace. */
  extra: Record<string, unknown>
  errors: string[]
  /** For `both`/`write` fields: values that don't survive the round trip. */
  roundTrip: string[]
}

export interface MwBindingReport {
  hash: string
  at: string
  diagnostics: MwDiagnostic[]
  errors: number
  warnings: number
  examples: MwExampleOutcome[]
  records: MwMappedRecord[]
  /** Upgrades: how each workflow changes against the live binding. */
  impact?: { workflowId: string; title: string; diff: MwStructuralDiff }[]
  outcome: 'passed' | 'failed'
  summary: string
}

/** A policy rule in plain words, for the binding review's policy section. */
export interface MwPolicyLine {
  /** "outbound", "email.send", "tokens". */
  subject: string
  /** "needs approval", "30 per minute". */
  value: string
}

/** What the binding review screen shows: the binding (live or a draft), and what it binds. */
export interface MwBindingView {
  pluginId: string
  pluginTitle: string
  pluginVersion: string
  /** Set when this is a draft (being bound); absent for the live binding. */
  draftId?: string
  /** The draft is open: the binding may be edited (through `memwise:drafts:write`). */
  editable: boolean
  binding: MwBinding
  /** The YAML as on disk (live or the draft's): edits rewrite the sections they change and keep the rest. */
  text: string
  /** Project-relative path of the file (`domain/bindings/<slug>.yaml`). */
  path: string
  gaps: MwBindingGap[]
  report?: MwBindingReport
  /** The binding changed since `report` was made. */
  reportStale: boolean
  /** The plugin's tools with their class and where it came from. */
  tools: MwPluginTool[]
  /** Capabilities it requires, with the bound tools that can provide each. */
  capabilities: { name: string; as: string; optional?: boolean; providers: string[] }[]
  /** Entities it expects, in its own terms. */
  entities: { name: string; fields: { name: string; type: string; required?: boolean }[] }[]
  /** The domain's entities, for the entity and field selects. */
  domainEntities: { name: string; fields: { name: string; type: string }[] }[]
  roles: { id: string; title: string }[]
  /** Record sources the plugin exposes. */
  records: { name: string; title?: string; key: string; fields: Record<string, string> }[]
  /** The plugin's own default policy, and the binding's tightening, in plain words. */
  pluginPolicy: MwPolicyLine[]
  bindingPolicy: MwPolicyLine[]
  /** The bind-plugin case, while one is open. */
  run?: { runId: string; caseId: string; state: string }
}

/** `memwise:bindings:get` */
export interface MwGetBindingInput {
  pluginId: string
  /** A binding draft; default the draft of the open bind-plugin case, else the live binding. */
  draftId?: string
}

/** On a bind-plugin inbox item: which plugin and draft it is about. */
export interface MwInboxBinding {
  pluginId: string
  draftId?: string
  /** `fix`: edit, then Done; `review`: approve or ask for changes. */
  mode: 'edit' | 'review'
}

// ---------------------------------------------------------------- identity

export type MwMatchMethod = 'key' | 'fuzzy' | 'person' | 'created'

export interface MwIdentityCandidate {
  id: string
  entity: string
  recordId: string
  recordTitle?: string
  plugin: string
  pluginTitle: string
  source: string
  externalId: string
  score: number
  reasons: string[]
  external: Record<string, unknown>
  /** `settled`: no longer asked, because one side was linked otherwise (not a person's rejection). */
  status: 'pending' | 'confirmed' | 'rejected' | 'settled'
  decidedBy?: string
  decidedByName?: string
  decidedAt?: string
  createdAt: string
}

export interface MwDecideIdentityInput {
  candidateId: string
  decision: 'confirm' | 'reject'
}

/** A source badge on an entity row. */
export interface MwEntityLinkBadge {
  plugin: string
  pluginTitle: string
  source: string
  method: MwMatchMethod
}

export interface MwIdentityLink extends MwEntityLinkBadge {
  id: string
  externalId: string
  score: number
  reasons: string[]
  linkedBy?: string
  linkedByName?: string
  at: string
  /** The linked record's mapped values, read live; absent when it couldn't be read. */
  values?: Record<string, unknown>
  extra?: Record<string, unknown>
  error?: string
}

/** `memwise:entities:record`: a domain record with its links and the fields read through them. */
export interface MwEntityRecord {
  entity: string
  id: string
  title: string
  values: Record<string, MwCaseValue>
  createdAt: string
  links: MwIdentityLink[]
  /** Field → the value read live through a link, and the plugin it came from. */
  readThrough: Record<string, { plugin: string; pluginTitle: string; value: unknown }>
}

export interface MwEntityRecordInput {
  entity: string
  id: string
}
