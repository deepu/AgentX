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
  /** Phase 6: the domain it belongs to (for the sidebar's domain filter). */
  domain?: string
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
  /** Phase 6 adds `workspace` (house rules above every domain). */
  layer: 'platform' | 'plugin' | 'workspace' | 'domain' | 'workflow' | 'step'
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
  | { kind: 'tool'; at: string; stepRunId: string; tool: string; callId: string; /** Phase 5: read from this document with this confidence, kept by this participant. */ document?: string; confidence?: number; confirmedBy?: string }
  | { kind: 'judgement'; at: string; stepRunId: string; rationale?: string; /** Set when a conversation step's chat wrote it (Phase 3). */ chatId?: string }
  | { kind: 'person'; at: string; by: string; stepRunId?: string }
  | { kind: 'system'; at: string; note?: string }
  /** Phase 5: typed by an outside participant (the client) through a link; `by` is their label. */
  | { kind: 'external'; at: string; by: string; linkId: string; stepRunId: string }

export interface MwCaseValue {
  value: unknown
  provenance: MwProvenance
  /** Came from untrusted content (an uploaded document) through quarantined reading. */
  tainted?: boolean
  /** The viewer may not see this field; `value` is null. */
  hidden?: boolean
  /** Phase 6: a Ref value's record, by its title (`value` keeps the id). */
  refTitle?: string
  /** Literature: the records a list of refs, or its rows' Ref columns, point at: id → title. */
  refTitles?: Record<string, string>
  /** Literature: a list of records' column types as written (`year: Number`, `phase: Enum[...]`). */
  itemTypes?: Record<string, string>
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
  /** `condition`: a `wait_until` block, waiting on a record's data rather than on anyone. */
  waitingOn?: { kind: 'role' | 'agent' | 'system' | 'condition'; role?: string }
  createdAt: string
  updatedAt: string
  /** Phase 6: the playbook's domain (for the domain filter). */
  domain?: string
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
  /** Phase 5: links sent to outside participants on this case, newest first. */
  links?: MwExternalLink[]
  /** Phase 5: messages sent for this case (invites, reminders), newest first. */
  deliveries?: MwDelivery[]
  /** Phase 6: parent, called and started cases (24 §8). */
  caseLinks?: MwCaseLink[]
  /** Phase 6: what a `wait_until` state waits for, with the record's current values. */
  waiting?: MwWaitingCondition
  domain?: string
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
      /** Phase 5: the step can read its documents (`extract:`); call memwise:external:extract. */
      extract?: { documentsField: string; fields: string[]; minConfidence: number }
      /** Fields shown read-only above the form (the step's reads). */
      context: Record<string, MwCaseValue>
      since: string
      dueAt?: string
      /** The case came back to this step: what sent it back and why (a comment, else the step's rationale). */
      returned?: MwReturnedNote
      /** Phase 4: a bind-plugin step (`fix`): the screens show the binding review instead of a form. */
      binding?: MwInboxBinding
      /** Phase 6: the domain, how it is reviewed (document review opens the record page) and the signature it needs. */
      domain?: string
      review?: MwInboxReview['review']
      sign?: MwInboxReview['sign']
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
      /** Phase 6, as on `input`. */
      domain?: string
      review?: MwInboxReview['review']
      sign?: MwInboxReview['sign']
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
  /** Phase 6: a record broke one of its entity's invariants (24 §4); opens the record. No case. */
  | {
      kind: 'flag'
      id: string
      caseId?: undefined
      runId?: undefined
      workflowId?: undefined
      caseTitle: string
      stepTitle: string
      domain: string
      flag: MwRecordFlag
      since: string
    }
  /** Phase 6: the storm guard held firings of a trigger (24 §7): start them or discard them. No case. */
  | {
      kind: 'trigger-hold'
      id: string
      caseId?: undefined
      runId?: undefined
      caseTitle: string
      stepTitle: string
      triggerId: string
      workflowId: string
      held: number
      description: string
      since: string
    }

export interface MwSubmitStepInput {
  stepRunId: string
  outcome: string
  values?: Record<string, unknown>
  comment?: string
  /** Phase 5: field -> suggestion id (memwise:external:extract) for values kept as read from a document. */
  sources?: Record<string, string>
  /** Phase 6: a step with `sign:` needs the person's password (re-authentication, 24 §9). */
  signature?: { password: string }
}

export interface MwSubmitResult {
  applied: boolean
  /** Field -> problems, when values failed validation. */
  errors?: Record<string, string[]>
  /** In English; the screens show the translation of `code` when they know it. */
  message?: string
  /** Why it was refused, e.g. `submit.stale`, `approval.forbidden`, `event.use_submit` (screens translate `memwise.result.<code>`). */
  code?: string
  /** Phase 6 (app addition): `submit.locked`: when the person may try signing again. */
  retryAfter?: string
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

/**
 * Open the regular chat screen anchored to a case or step (09 §1), or (doc 25 §6) to a record:
 * `entity` is the entity key (`literature.topic`). A record chat gets `record_get`,
 * `record_query` and, when its domain has an entity with `keep_from_chat`, `record_keep`.
 */
export interface MwOpenChatInput {
  anchor: { kind: 'case' | 'step' | 'workflow'; id: string } | { kind: 'record'; entity: string; id: string }
}

// ---------------------------------------------------------------- domain

export interface MwEntityType {
  name: string
  fields: MwField[]
  lifecycle?: string[]
  /** Phase 6 (the Entities page's Definition tab): the entity key, its domain and definition in display form. */
  key?: string
  domain?: string
  definition?: MwEntityDefinition
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
  kind: 'run' | 'case' | 'inbox' | 'definitions' | 'status' | 'drafts' | 'plugins' | 'external' | 'relay' | 'records' | 'triggers'
  /** Phase 6 `records`: the entity key and record id that changed. */
  entity?: string
  /** The run id for `run` changes; the record id for `records`. */
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

// ================================================================ Phase 5 (docs/memwise/23-phase-5-interfaces.md)
// PHASE 5 CONTRACT: external links, the relay (public address) and channels. The same shapes
// as the kernel's (`@memwise/defs/external`), kept here like the others so the renderer needs no kernel package.

export type MwChannelName = 'email' | 'whatsapp'

export interface MwExternalParticipant { name?: string; email?: string; phone?: string }

/** A link as staff see it on the case (never the token). */
export interface MwExternalLink {
  id: string
  kind: 'step' | 'inbox'
  status: 'open' | 'used' | 'closed' | 'expired' | 'revoked'
  runId: string
  caseId: string
  stepId?: string
  stepRunId?: string
  participant: MwExternalParticipant
  via?: MwChannelName | 'copy'
  note?: string
  createdAt: string
  createdBy?: string
  expiresAt: string
  sentAt?: string
  firstOpenedAt?: string
  lastOpenedAt?: string
  draftSavedAt?: string
  usedAt?: string
  closedAt?: string
  closedReason?: string
  personId?: string
  itemId?: string
}

export interface MwDelivery {
  id: string
  channel: MwChannelName
  to: string
  purpose: 'invite' | 'reminder' | 'notification'
  linkId?: string
  personId?: string
  itemId?: string
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  error?: string
  providerId?: string
  at: string
}

export interface MwExtractSuggestion {
  id: string
  field: string
  value: unknown
  confidence: number
  document: string
  documentId: string
  quote?: string
  found: boolean
  prefill: boolean
}

export interface MwExtractResult { suggestions: MwExtractSuggestion[]; notes?: string[] }

export interface MwNotifySettings { email?: boolean; whatsapp?: string }

/** `memwise:external:issue`: a link staff copy to send themselves. */
export interface MwIssueLinkInput {
  runId: string
  stepId: string
  participant: MwExternalParticipant
  note?: string
}

export interface MwIssuedLink {
  link: MwExternalLink
  /** The full public URL; absent without a public address (then `message` says why). */
  url?: string
  message?: string
}

export interface MwResendPreview { to: string; via: MwChannelName; subject?: string; body: string }

export interface MwExtractInput { stepRunId: string; documents: string[] }

/** Settings → Public address. */
export interface MwRelayStatus {
  /** Turned on in settings (or by MEMWISE_RELAY_URL). */
  enabled: boolean
  state: 'off' | 'connecting' | 'connected' | 'error'
  relayUrl?: string
  installId?: string
  /** Where links point: the relay's public address, or the server's own MEMWISE_PUBLIC_URL. */
  publicUrl?: string
  source?: 'relay' | 'server'
  error?: string
  since?: string
}

export interface MwRelayConfigureInput { enabled: boolean; relayUrl?: string }

export type MwChannelsAvailable = Record<MwChannelName, { tool: string; plugin?: string } | null>

// ---- Phase 5 renderer additions (additive): the inputs the app sends on the channels above.
// memwise:external:links       (workspaceId, MwExternalLinksFilter)  → MwExternalLink[]
// memwise:external:issue       (workspaceId, MwIssueLinkInput)       → MwIssuedLink
// memwise:external:revoke      (workspaceId, linkId: string)         → MwSubmitResult
// memwise:external:previewResend (workspaceId, MwResendInput)        → MwResendPreview | { message }
// memwise:external:resend      (workspaceId, MwResendInput)          → MwResendResult
// memwise:external:extract     (workspaceId, MwExtractInput)         → MwExtractResult
// memwise:relay:status         (workspaceId)                         → MwRelayStatus
// memwise:relay:configure      (workspaceId, MwRelayConfigureInput)  → MwRelayStatus
// memwise:channels:available   (workspaceId)                         → MwChannelsAvailable
// memwise:notify:get           (workspaceId)                         → MwNotifySettings (the current person's)
// memwise:notify:set           (workspaceId, MwNotifySettings)       → MwNotifySettings

export interface MwExternalLinksFilter { caseId?: string; runId?: string }

/** `memwise:external:previewResend` and `memwise:external:resend`. */
export interface MwResendInput {
  linkId: string
  /** Another channel than the link's own (a copied link has none). */
  via?: MwChannelName
}

export interface MwResendResult extends MwSubmitResult { delivery?: MwDelivery }

// ================================================================ Phase 6 (docs/memwise/24-phase-6-interfaces.md)
// PHASE 6 CONTRACT: domains, record pages, views, dashboards, triggers, regulated mode, review.
// Change only additively. Shapes mirror the kernel's (packages/runtime/src/types.ts, KernelPhase6).

// memwise:domains:list          (workspaceId)                          → MwDomain[]
// memwise:records:page          (workspaceId, MwRecordPageInput)       → MwRecordPage | null
// memwise:records:create        (workspaceId, MwRecordCreateInput)     → MwRecordWriteResult
// memwise:records:update        (workspaceId, MwRecordUpdateInput)     → MwRecordWriteResult
// memwise:records:transition    (workspaceId, MwRecordTransitionInput) → MwRecordWriteResult
// memwise:records:query         (workspaceId, MwRecordQueryInput)      → MwRecordQueryResult
// memwise:records:tree          (workspaceId, MwTreeInput)             → MwTreeNode[]
// memwise:records:notes:save    (workspaceId, MwSaveNoteInput)         → MwRecordWriteResult
// memwise:pages:dashboard       (workspaceId, MwDashboardInput)        → MwDashboard
// memwise:views:list            (workspaceId, { domain, entity? })     → MwView[]
// memwise:views:save            (workspaceId, MwSaveViewInput)         → MwView
// memwise:triggers:list         (workspaceId)                          → MwTrigger[]
// memwise:triggers:release      (workspaceId, MwReleaseTriggerInput)   → MwSubmitResult & { started?: number }
// memwise:audit:get             (workspaceId, { entity, id })          → MwAuditTrail | null
// memwise:audit:export          (workspaceId, MwAuditExportInput)      → MwAuditExport
// memwise:cases:submit          takes `signature?: { password }` (MwSubmitStepInput) and may answer
//                               status 'signature-required' | 'signature-failed' | 'locked' | 'password-not-set'.

export interface MwDomain {
  id: string
  name: string
  description?: string
  regulated: boolean
  owner?: string
  /** Days, for display ("Kept 25 years"). */
  retentionDays?: number
  entities: { key: string; entity: string; title: string; count: number; parent?: string; lifecycle?: string[] }[]
  /** Playbook ids in this domain. */
  workflows: string[]
  pages: { id: string; title: string; under?: { entity: string } }[]
  views: { id: string; title: string; entity: string }[]
  flags: number
  /** App addition: house rules and hand-off settings, for the domain page. */
  detail?: MwDomainDetail
}

export type MwRecordFieldSource =
  | { kind: 'domain' }
  | { kind: 'plugin'; plugin: string; title?: string }
  | { kind: 'link'; domain: string; domainName?: string; entity: string; recordId?: string }
  | { kind: 'calculated' }
  | { kind: 'step'; stepRunId: string; workflowId?: string; label?: string }
  | { kind: 'person'; personId: string; name?: string }
  | { kind: 'source'; source: string }

export interface MwRecordField {
  name: string
  label: string
  type: string
  value: unknown
  hidden?: boolean
  ref?: MwRecordRef
  source: MwRecordFieldSource
  editable: boolean
  calculated?: boolean
  followed?: boolean
  required?: boolean
  description?: string
  controlled?: boolean
}

export interface MwRecordRef { entity: string; id: string; title: string; status?: string }

export type MwPageLayoutShape = 'single' | 'split' | 'sidebar'

export type MwPageBlock =
  | { kind: 'fields'; fields: string[] }
  | { kind: 'details' }
  /** A Document, File or Image field; Literature: a Text field, its data in `MwRecordPage.texts`. */
  | { kind: 'viewer'; field: string }
  | { kind: 'related'; relationships: string[] }
  | { kind: 'cases' }
  | { kind: 'lifecycle' }
  /** Its rows in `MwRecordPage.charts`, under `mwPageBlockKey(area, index)` (Literature adds `interval` and the optional keys). */
  | MwChartBlock
  | { kind: 'checks' }
  | { kind: 'notes' }
  | { kind: 'mentions' }
  | { kind: 'start' }
  | { kind: 'history' }
  /** Literature: tiles for these calculated or Number fields; values in `MwRecordPage.kpis`. */
  | { kind: 'kpis'; fields: string[] }
  /** Literature: "Ask about this record": opens a chat anchored to the record (no data). */
  | { kind: 'chat' }

export interface MwPageLayout {
  layout: MwPageLayoutShape
  header: string[]
  areas: Partial<Record<'main' | 'left' | 'right' | 'side' | 'below', MwPageBlock[]>>
  isDefault?: boolean
}

export interface MwTransitionOption {
  name: string
  label: string
  to: string
  allowed: boolean
  reason?: string
  guard?: { condition: string; holds: boolean }
  signed?: boolean
}

export interface MwRecordFlag { id: string; entity: string; recordId: string; invariant: string; message: string; raisedAt: string; closedAt?: string }

export interface MwSignature {
  id: string
  stepRunId: string
  caseId: string
  personId: string
  name: string
  meaning: string
  at: string
  entity: string
  recordId: string
  contentHash: string
  changedSince: boolean
}

export interface MwRecordVersion {
  version: number
  at: string
  by: string
  byLabel?: string
  via?: string
  reason?: string
  changed: string[]
  hash: string
}

export interface MwMention { sourceKind: 'note' | 'chat' | 'step' | 'comment' | 'page'; sourceId: string; label: string; at: string; caseId?: string }

export interface MwProposedValue {
  field: string
  label: string
  type: string
  value: unknown
  provenance?: MwProvenance
  confidence?: number
  page?: number
  quote?: string
  document?: string
  required?: boolean
  /** A proposed reference's record, by its title (`value` keeps the id). */
  ref?: MwRecordRef
}

export interface MwCheckResult { rule: string; verdict: string; note?: string; stepRunId: string }

/** A record page in review mode (24 §11): the open person step drawn on the record it reviews. */
export interface MwRecordReview {
  stepRunId: string
  runId: string
  caseId: string
  workflowId: string
  stepId: string
  title: string
  instructions?: string
  proposed: MwProposedValue[]
  checks: MwCheckResult[]
  outcomes: string[]
  sign?: { meaning: string; as: { personId: string; name: string; roles: string[] } }
  returnedComments?: { by: string; comment: string; at: string }[]
}

export interface MwRecordPage {
  entity: string
  domain: string
  domainName: string
  entityName: string
  regulated: boolean
  id: string
  title: string
  status?: string
  layout: MwPageLayout
  fields: MwRecordField[]
  parents: MwRecordRef[]
  /** `types`: each row value's declared type, so a date or an enum reads as one. */
  related: Record<string, { entity: string; label: string; total: number; rows: (MwRecordRef & { values: Record<string, unknown> })[]; types?: Record<string, string> }>
  cases: { caseId: string; runId: string; workflowId: string; title: string; state: string; status: MwRunStatus; updatedAt: string; waitingOn?: string }[]
  /** `passed`: the states on the way to the current one; others before it in `states` were skipped. */
  lifecycle?: { states: string[]; current?: string; passed?: string[]; transitions: MwTransitionOption[] }
  flags: MwRecordFlag[]
  signatures: MwSignature[]
  notes?: { body: string; version: number; by: string; at: string }
  mentions: MwMention[]
  start: { workflowId: string; title: string }[]
  documents: Record<string, MwDocument | null>
  history: MwRecordVersion[]
  review?: MwRecordReview
  /** Literature: `kpis` blocks' tiles, by field name. */
  kpis?: Record<string, MwRecordKpi>
  /** Literature: `chart` blocks' rows, by `mwPageBlockKey(area, index)` (`main:1`). */
  charts?: Record<string, MwChartData>
  /** Literature: `viewer` blocks on a Text field: the text and its quotes, by field name. */
  texts?: Record<string, MwTextView>
}

export interface MwRecordPageInput { entity: string; id: string; review?: { stepRunId: string } }
export interface MwRecordCreateInput { entity: string; values: Record<string, unknown>; status?: string; reason?: string }
export interface MwRecordUpdateInput { entity: string; id: string; values: Record<string, unknown>; reason?: string }
export interface MwRecordTransitionInput { entity: string; id: string; transition: string; reason?: string }

export interface MwRecordWriteResult {
  applied: boolean
  status: 'applied' | 'forbidden' | 'invalid' | 'guard' | 'reason-required' | 'signature-required' | 'missing' | 'stale'
  message?: string
  errors?: Record<string, string[]>
  id?: string
  version?: number
}

export interface MwRecordQueryInput {
  entity: string
  domain?: string
  filter?: string
  sort?: { field: string; desc?: boolean }[]
  group?: string
  columns?: string[]
  limit?: number
  offset?: number
}

export interface MwRecordQueryResult {
  entity: string
  columns: { name: string; label: string; type: string; calculated?: boolean; followed?: boolean }[]
  /** `refs`: the records a row's Ref fields point at, by title (absent when none). */
  rows: (MwRecordRef & { values: Record<string, unknown>; hidden: string[]; refs?: Record<string, MwRecordRef> })[]
  total: number
  /** The groups in order, with counts (and the title, when grouped by a Ref). */
  groups?: { key: string | null; count: number; title?: string }[]
}

export interface MwTreeInput { domain: string; parent?: { entity: string; id: string } }

export type MwTreeNode =
  | { kind: 'record'; entity: string; id: string; title: string; status?: string; hasChildren: boolean }
  | { kind: 'group'; entity: string; parent?: { entity: string; id: string }; title: string; count: number; viewFilter?: string }
  | { kind: 'page'; pageId: string; title: string; params: Record<string, string> }

export interface MwSaveNoteInput { entity: string; id: string; body: string; reason?: string }

export interface MwView {
  id: string
  title: string
  domain: string
  entity: string
  filter?: string
  sort?: { field: string; desc?: boolean }[]
  group?: string
  columns?: string[]
  layout: 'table' | 'board'
  personal: boolean
}

export interface MwSaveViewInput { domain: string; view: Omit<MwView, 'personal' | 'domain'> }

export interface MwDashboardInput { domain: string; pageId: string; params?: Record<string, string> }

export type MwDashboardBlock =
  | { kind: 'kpi'; label: string; value: number | null; target?: number; format?: 'number' | 'percent'; detail?: string }
  | { kind: 'table' | 'list'; title?: string; result: MwRecordQueryResult }
  | { kind: 'heatmap'; title?: string; columns: string[]; rows: { record: MwRecordRef; values: (number | null)[] }[] }
  | { kind: 'text'; markdown: string }
  /** Literature: a free page's `chart:` block, computed in SQL. */
  | { kind: 'chart'; chart: MwChartData }

export interface MwDashboard {
  pageId: string
  domain: string
  title: string
  description?: string
  params: Record<string, string>
  computedAt: string
  blocks: MwDashboardBlock[]
}

export type MwTriggerKind = 'entered' | 'created' | 'changed' | 'date' | 'every' | 'message'

export interface MwTrigger {
  id: string
  workflowId: string
  workflowTitle: string
  domain: string
  kind: MwTriggerKind
  description: string
  lastFiredAt?: string
  nextDue?: { at: string; record?: MwRecordRef }
  firings: number
  held: number
}

export interface MwReleaseTriggerInput { trigger: string; decision: 'start' | 'discard' }

export interface MwCaseLink {
  kind: 'started' | 'called' | 'started_by' | 'called_by'
  caseId: string
  runId: string
  workflowId: string
  title: string
  state: string
  status: MwRunStatus
  /** The linked case's own name ("Read a paper" about ATTAIN-2), when it differs from `title`. */
  caseTitle?: string
}

/** `types`: each value's declared type (a percent rollup is `Percentage`), so the screen formats it. */
export interface MwWaitingCondition { record: MwRecordRef; condition: string; holds: boolean; values: Record<string, unknown>; types?: Record<string, string> }

export interface MwAuditTrail {
  entity: string
  id: string
  title: string
  domain: string
  regulated: boolean
  retentionDays?: number
  values: Record<string, unknown>
  versions: (MwRecordVersion & { values: Record<string, unknown>; prevHash: string })[]
  chain: { ok: boolean; brokenAt?: number; message?: string }
  signatures: MwSignature[]
  cases: { caseId: string; workflowId: string; title: string; stepRuns: { stepRunId: string; stepId: string; performer: string; outcome?: string; decidedBy?: string; at: string }[] }[]
  flags: MwRecordFlag[]
  exportedAt: string
}

export interface MwAuditExportInput { entity: string; id: string; format: 'json' | 'pdf' }
export interface MwAuditExport { name: string; mime: string; dataBase64: string }

/** Phase 6 inbox additions (`MwInboxItem` kinds `input`/`decision` gain these optional fields). */
export interface MwInboxReview {
  domain?: string
  review?: { kind: 'document'; entity: string; recordId?: string } | { kind: 'table'; items: string } | { kind: 'diff' } | { kind: 'form' }
  sign?: { meaning: string }
}

// ---------------------------------------------------------------- Phase 6 app additions
// Additive to the contract above, made while building the screens (24 §17 "As built").

// memwise:files:read            (workspaceId, fileId)                  → MwFileData   (the record page's viewer)

/** A stored file's bytes, for the record page's document viewer. */
export interface MwFileData { id: string; name: string; mime: string; dataBase64: string }

/** An entity's definition as the Entities page shows it (`MwEntityType.definition`). */
export interface MwEntityDefinition {
  /** How a record is named: `{site_number} · {name}`. */
  title?: string
  /** The page-tree parent relationship and the entity it points at. */
  parent?: { relationship: string; entity: string }
  /** Where each field's value comes from (fields, calculated and followed ones). */
  sources: Record<string, MwRecordFieldSource>
  relationships: { name: string; cardinality: 'one' | 'many'; target: string; via?: string }[]
  calculated: { name: string; kind: 'rollup' | 'formula'; summary: string; description?: string }[]
  links: { target: string; match: Record<string, string>; follow: string[] }[]
  lifecycle?: {
    initial: string
    states: { name: string; label: string; on: { transition: string; to: string }[]; timers: string[] }[]
    transitions: { name: string; label: string; by: string[]; guard?: string; signed?: boolean }[]
    fromList?: boolean
  }
  invariants: string[]
  /** Playbooks that read, write or start from this entity. */
  usedBy: { workflowId: string; title: string }[]
}

/** Phase 6 domain additions the sidebar and the domain page use (`MwDomain` stays as agreed). */
export interface MwDomainDetail {
  /** The domain's house rules in plain words (policy.yaml), and the workspace's above them. */
  houseRules: MwPolicyLine[]
  workspaceRules: MwPolicyLine[]
  acceptsFrom: string[]
  intake?: string
}

// memwise:people:password:set   (workspaceId, MwSetPasswordInput) → MwSetPasswordResult
// The signed-in person's own password, to sign in a regulated domain (the desktop owner starts
// without one). Changing an existing one needs the current password.
export interface MwSetPasswordInput { password: string; current?: string }
export interface MwSetPasswordResult { applied: boolean; code?: 'password.current-wrong' | 'password.rule'; message?: string }

// ================================================================ Literature (doc 25)
// docs/memwise/25-literature-poc.md §4–§6 (D79–D86): charts on record pages and free pages, KPI
// tiles, a Text viewer with its quotes, and rows kept from a record chat. Additive to Phase 6.
// Shapes mirror the kernel's (packages/runtime/src/types.ts, "Literature").

// memwise:records:keep          (workspaceId, MwRecordKeepInput)       → MwRecordKeepResult

export type MwChartKind = 'bar' | 'line' | 'donut' | 'interval'

/** A record page's `chart` block as written (`MwPageBlock`). */
export interface MwChartBlock {
  kind: 'chart'
  /** bar/line/donut count related rows per value of `by`; interval draws one row per related record. */
  chart: MwChartKind
  /** The many relationship whose rows it draws. */
  of: string
  /** bar/line/donut: the field counted by. */
  by?: string
  /** A condition on the related rows (condition language). */
  where?: string
  /** The heading; absent: made from `of` and `by`. */
  title?: string
  /** interval: each row's label template, "{intervention} vs {comparator}". */
  label?: string
  /** interval: the field holding the value. */
  value?: string
  /** interval: the field holding the interval's low end. */
  low?: string
  /** interval: the field holding the interval's high end. */
  high?: string
  /** interval: the field holding the unit. */
  unit?: string
}

/** The key of a page block's data in `MwRecordPage.charts`: its area and index there. */
export function mwPageBlockKey(area: string, index: number): string {
  return `${area}:${index}`
}

/** One row of a chart; the same as a chat ```chart block's `data` item, plus where it came from. */
export interface MwChartDatum {
  /** bar/line/donut: the `by` value as text (a Ref's record title; "Not set" for none); interval: the row's label. */
  label: string
  /** bar/line/donut: how many records; interval: the record's value. */
  value: number
  /** interval: the low end, when the record has one. */
  low?: number
  /** interval: the high end, when the record has one. */
  high?: number
  /** interval: this row's unit, only when the rows don't share one (`MwChartData.unit` absent). */
  unit?: string
  /** bar/line/donut: the stored value (null: not set), to filter a view by. */
  key?: string | null
  /** interval: the record the row is, to open it. */
  record?: MwRecordRef
}

/** A chart's rows, computed by the kernel now (record page `chart` blocks and free page `chart:` blocks). */
export interface MwChartData {
  kind: MwChartKind
  /** The block's title, when it has one. */
  title?: string
  /** interval: the unit every row shares. */
  unit?: string
  /** bar/line/donut: one row per value, numbers (years) in order and "Not set" last; interval: one per record. */
  data: MwChartDatum[]
  /** bar/line/donut: the records counted; interval: the rows drawn. */
  total: number
  /** interval: records left out because they have no value. */
  skipped?: number
}

/** A `kpis` tile's value (labels are the fields' own, as in `MwRecordPage.fields`). */
export interface MwRecordKpi {
  /** The calculated or Number field. */
  field: string
  /** Its value now; null when not set or hidden from the viewer. */
  value: number | null
  /** Its type as written ("Number", "Percentage"), to format the value. */
  type: string
  /** The field's description, for the tile's detail line. */
  description?: string
}

/** A quote to light up in a Text viewer. */
export interface MwQuoteHighlight {
  /** The words, as stored. */
  quote: string
  /** value: the record's field read from these words; related: the related record's quote field. */
  field: string
  /** The field's name in words ("Sample size"; "Quote" for a related record's). */
  label: string
  /** value: one of the record's values was read from these words; related: a related record quotes them. */
  kind: 'value' | 'related'
  /** value: the record's value it backs, to show on hover. */
  value?: unknown
  /** related: the record quoting the text (an Evidence row), to open it. */
  record?: MwRecordRef
  /** Whether the text holds the quote (the kernel's check: NFKC, case folded, `·` as `.`, dashes as `-`, whitespace collapsed). */
  found: boolean
  /** Where the quote is in `MwTextView.text` (UTF-16 offsets, `end` exclusive), when found. */
  start?: number
  end?: number
}

/** A `viewer` block on a Text field: the text and the quotes in it. */
export interface MwTextView {
  /** The field's text; null when not set or hidden from the viewer. */
  text: string | null
  /** In the order found: the record's own values first, then related records. */
  highlights: MwQuoteHighlight[]
}

/** Rows a person keeps from a chat anchored to a record ("Keep as evidence"). */
export interface MwRecordKeepInput {
  /** The entity key (`literature.Evidence`); its type must say `keep_from_chat: true`. */
  entity: string
  /** Each row's field values; `id` and `status` are ignored (a kept row starts in the initial state). */
  rows: Record<string, unknown>[]
  /** The chat the rows came from; the reason on each record is "kept from chat <chatId>". */
  chatId: string
}

/** Per row, in order: the new record, or why it wasn't kept. */
export interface MwRecordKeepResult {
  /** The entity key. */
  entity: string
  rows: {
    /** The new record's id, when kept. */
    id?: string
    /** With a `quote_of` field: whether its quote is in the source (false: kept, and flagged "Quote not found in the source"). */
    quoteFound?: boolean
    /** Why the row wasn't kept, in plain words. */
    error?: string
    /** Per field, what needs fixing. */
    errors?: Record<string, string[]>
  }[]
}
