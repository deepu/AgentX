import type {
  ApprovalDecision, ApprovalRequest, ApprovalStatus, CaseSnapshot, CaseValue, Diagnostic, JournalEntry, StepRecord,
} from '@memwise/defs';
import type { ModelProvider, ModelRoleConfig, SecretProvider, ToolDefinition } from '@memwise/gateway';
import type { StepResult, StepRunInput } from '@memwise/step-engine';
import type pg from 'pg';
import type { RunEvent } from './machine.ts';

/** Runs one agent step. Registered as the DBOS workflow `memwise.step.agent`; tests swap in a fake. */
export type StepExecutor = (input: StepRunInput) => Promise<StepResult>;

export interface KernelOptions extends PhaseFiveKernelOptions {
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
  /** Phase 3: runs example cases for draft checks; default spawns the `memwise` CLI. */
  testRunner?: TestRunner;
  /**
   * Phase 3: admin URL of the Postgres server the default TestRunner makes its throwaway
   * databases on (`memwise test --database-url`); default `MEMWISE_TEST_DATABASE_URL`, else a
   * throwaway cluster of the CLI's own.
   */
  testDatabaseUrl?: string;
  /** Phase 4: implementations for plugin tools with `run: { builtin: <name> }`, by tool name. */
  builtins?: ToolDefinition[];
  /** Phase 4: resolves an MCP server declared `{ source: <slug> }` (a connector set up in the app), with its credentials. */
  resolveMcpSource?: (slug: string) => Promise<import('@memwise/defs').McpServerDef | undefined>;
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

export interface Kernel extends KernelPhase2, KernelPhase3, KernelPhase4, KernelPhase5, KernelPhase6, KernelPages {
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
  /** Phase 6: `roles` are workspace-wide; `grants` are roles in one domain (24 §2). */
  | { kind: 'person'; personId: string; roles: string[]; grants?: import('@memwise/defs').Grant[] }
  | { kind: 'step'; token: import('@memwise/defs').StepToken }
  | { kind: 'system' };

export interface Person { id: string; name: string; email: string; roles: string[]; disabled?: boolean; createdAt: string; /** Phase 6 */ grants?: import('@memwise/defs').Grant[]; /** Phase 6: locked after failed signatures until then. */ lockedUntil?: string }
export interface Role { id: string; title: string; description?: string }

export interface PeopleService {
  list(): Promise<Person[]>;
  get(personId: string): Promise<Person | undefined>;
  byEmail(email: string): Promise<Person | undefined>;
  create(input: { name: string; email: string; roles?: string[]; password?: string }): Promise<Person>;
  setRoles(personId: string, roles: string[]): Promise<Person>;
  setPassword(personId: string, password: string): Promise<void>;
  /** Phase 6: whether they have a password yet (the desktop owner starts without one). */
  hasPassword(personId: string): Promise<boolean>;
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
  /**
   * Phase 3: a conversation step (`engine: open`) is answered by its chat, acting for `by`.
   * Its writes get provenance `judgement` with the rationale and the chat id, not `person`.
   * Person and external steps refuse it; conversation steps accept only it.
   */
  via?: { chatId: string; rationale?: string };
  /**
   * Phase 5 (23 §5): field -> suggestion id, for values taken from the step's extraction
   * (`extractForStep`). A value still equal to its suggestion keeps the tool's provenance.
   */
  sources?: Record<string, string>;
  /** Phase 6 (24 §9): a step with `sign:` needs the person to re-authenticate. */
  signature?: SignatureInput;
}

export interface SubmitResult {
  applied: boolean;
  /**
   * `forbidden`: the person lacks the role; `invalid`: values failed validation; `stale`: the step is no longer waiting.
   * Phase 6: `signature-required` (no signature given), `signature-failed` (wrong password), `locked` (too many failures),
   * `password-not-set` (the person has no password to sign with yet; they choose one, then sign).
   */
  status: 'applied' | 'forbidden' | 'invalid' | 'stale' | 'missing' | 'unknown-outcome' | 'signature-required' | 'signature-failed' | 'locked' | 'password-not-set';
  errors?: Record<string, string[]>;
  message?: string;
}

export type InboxItem =
  | { kind: 'input' | 'decision'; id: string; stepRunId: string; runId: string; caseId: string; workflowId: string;
      stepId: string; assignee?: string; since: string; dueAt?: string;
      /** Pages (26 §4): the step reviews an answer change ("Review an answer change"). */
      pageChange?: PageChangeRef;
      /** Phase 5: the step's form can read its documents (`extract:`, 23 §5): `kernel.external.extractForStep`. */
      extract?: { documentsField: string; fields: string[]; minConfidence: number };
      /** Phase 6: the workflow's domain, how the step is reviewed (24 §11) and the signature it needs. */
      domain?: string;
      review?: { kind: 'document'; entity: string; recordId?: string } | { kind: 'table'; items: string } | { kind: 'diff' } | { kind: 'form' };
      sign?: { meaning: string } }
  | { kind: 'approval'; id: string; approval: ApprovalRequest; runId: string; caseId: string; workflowId: string; stepId: string;
      since: string }
  | { kind: 'attention'; id: string; runId: string; caseId: string; workflowId: string; state: string; reason: string;
      events: string[]; since: string }
  | { kind: 'reminder'; id: string; runId: string; caseId: string; workflowId: string; stepId: string; stepRunId?: string;
      text: string; since: string }
  /** Phase 3: a conversation step (`engine: open`) waiting on its chat, for its assignee role. */
  | { kind: 'conversation'; id: string; stepRunId: string; runId: string; caseId: string; workflowId: string; stepId: string;
      assignee?: string; since: string }
  /** Phase 4: an uncertain identity match waiting for a person (22 §6). */
  | { kind: 'identity'; id: string; candidate: import('@memwise/defs').IdentityCandidate; since: string }
  /** Phase 6: a broken invariant on a record, for the domain owner (24 §4). */
  | { kind: 'flag'; id: string; flag: RecordFlag; domain: string; title: string; since: string }
  /** Phase 6: firings held by the storm guard, for the workflow's owner (24 §7). */
  | { kind: 'trigger-hold'; id: string; triggerId: string; workflowId: string; held: number; description: string; since: string };

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
  /** Phase 6: parent, called and started cases (24 §8). */
  links?: CaseLinkView[];
  /** Phase 6: the condition a `wait_until` state waits on, with its current values. */
  waiting?: WaitingCondition;
  /** Phase 6: the workflow's domain. */
  domain?: string;
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
  | { kind: 'definitions' }
  /** Phase 3: a draft changed (created, edited, checked, published, discarded). */
  | { kind: 'drafts'; draftId: string }
  /** Phase 4: a plugin was installed, or a binding or identity link changed. */
  | { kind: 'plugins' }
  /** Phase 5: a link or a delivery of a case changed (sent, opened, draft saved, used). */
  | { kind: 'external'; caseId?: string }
  /** Phase 6: a record changed (version written, transition, note, flag). */
  | { kind: 'records'; entity: string; recordId?: string }
  /** Phase 6: a trigger fired or firings were held or released. */
  | { kind: 'triggers' }
  /** Pages (26 §4): a page or a page change was written. */
  | { kind: 'pages'; project?: string; pageId?: string; changeId?: string };

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

// ================================================================ Phase 3 (docs/memwise/20-phase-3-interfaces.md)
// PHASE 3 CONTRACT. `@memwise/server-core` codes against these; change only additively.

import type {
  DiffHunk as _DiffHunk, Diagnostic as _Diagnostic, DraftDiff, DraftEdit, DraftMeta, DraftReport, ExampleCase, ExampleOutcome,
  WorkflowVersion,
} from '@memwise/defs';

/** The meta playbooks that build and change playbooks (11 §3); shipped in the project folder. */
export const CREATE_PLAYBOOK = 'create-playbook';
export const CHANGE_PLAYBOOK = 'change-playbook';

/**
 * Runs a project's example cases out of process (DBOS is process-wide, so the kernel can't host
 * a second one): `memwise test <projectDir> --workflow <id> --json [--examples-file f] [--database-url admin]`.
 */
export type TestRunner = (req: {
  projectDir: string;
  workflowId: string;
  /** Extra examples to run too (past cases replayed), not written into the project. */
  extraExamples?: ExampleCase[];
}) => Promise<ExampleOutcome[]>;

/** What a playbook may use, for the authoring chat and the editor (05 §10: only what's available). */
export interface Vocabulary {
  tools: { name: string; description?: string; effect?: import('@memwise/defs').EffectClass; plugin?: string; inputSchema?: Record<string, unknown> }[];
  entities: { name: string; fields: { name: string; type: string }[]; lifecycle?: string[] }[];
  roles: { id: string; title: string; description?: string }[];
  /** Model roles a step may name (`model:`). */
  modelRoles: string[];
  /** Value type names and the forms they take (`Identifier(<scheme>)`, `List<T>`...). */
  valueTypes: string[];
  playbooks: { id: string; title: string; version?: number; live: boolean }[];
}

export type PublishResult =
  | { status: 'published'; workflowId: string; version: number; hash: string }
  /** The draft changed after it was checked (`hash` differs), or the live files changed under it. */
  | { status: 'stale' | 'conflict' | 'failed'; message: string };

/**
 * Drafts and change control (05 §10, 08 §3), over the project folder (`@memwise/defs` drafts)
 * and the kernel. Every method acts for a person; who may do what:
 * - anyone signed in may create and edit drafts (they change nothing live);
 * - publishing happens only through a change run's publish step (the kernel's
 *   `playbooks.publish_draft` tool), after its review step was approved, or `memwise push`.
 */
export interface Authoring {
  readonly projectDir: string;
  vocabulary(): Promise<Vocabulary>;
  listDrafts(filter?: { workflowId?: string; status?: DraftMeta['status'] }): Promise<DraftMeta[]>;
  getDraft(draftId: string): Promise<{ meta: DraftMeta; edits: DraftEdit[]; report?: DraftReport; contentHash: string } | undefined>;
  /** A change draft copies the live playbook; a create draft starts empty (workflowId must be new). */
  createDraft(input: { workflowId: string; title: string; kind?: DraftMeta['kind']; runId?: string }, by: Actor): Promise<DraftMeta>;
  /** Files of the live project (no draftId) or of a draft: without `path` the list, with it the content. */
  read(input: { draftId?: string; workflowId?: string; path?: string }): Promise<{ files: string[] } | { path: string; content: string | null }>;
  /** Write (or delete, content null) whole files in a draft; records one edit; returns the checks after it. */
  write(input: {
    draftId: string; files: { path: string; content: string | null }[]; summary: string; via: DraftEdit['via']; chatId?: string;
  }, by: Actor): Promise<{ edit: DraftEdit; diagnostics: _Diagnostic[] }>;
  keepEdit(draftId: string, editId: string, by: Actor): Promise<{ applied: boolean; message?: string }>;
  /** Restores the files the edit changed, unless they changed again since (then refused, naming them). */
  discardEdit(draftId: string, editId: string, by: Actor): Promise<{ applied: boolean; message?: string; conflicts?: string[] }>;
  discardDraft(draftId: string, by: Actor): Promise<void>;
  diff(draftId: string): Promise<DraftDiff>;
  /** Structure and policy checks only (fast; run after every edit). */
  quickCheck(draftId: string): Promise<_Diagnostic[]>;
  /** Checks, example cases (TestRunner), past cases replayed, impact; writes report.json. */
  check(draftId: string, opts?: { pastCases?: number }): Promise<DraftReport>;
  /** Apply the draft to the project folder as the next version, if its content hash is still `hash`. */
  publish(draftId: string, opts: { hash: string; by?: string; runId?: string; source: 'app' | 'cli' }): Promise<PublishResult>;
  /** Start create-playbook (no workflowId) or change-playbook at its conversation step. */
  startBuild(input: { workflowId?: string; request?: string; title?: string }, by: Extract<Actor, { kind: 'person' }>): Promise<{ runId: string; caseId: string; stepRunId: string }>;
  /** Send an edited draft to review: change-playbook started at its check step with the draft. */
  submitDraft(draftId: string, by: Extract<Actor, { kind: 'person' }>): Promise<{ runId: string; caseId: string }>;
  /** Turn a recorded case into an example case in a draft (a correction becomes a test, 05 §12). */
  exampleFromCase(input: {
    caseId: string; name?: string; correction?: { step: string; outcome: string; note?: string }; draftId?: string;
  }, by: Actor): Promise<{ draftId: string; path: string; example: ExampleCase }>;
}

export interface KernelPhase3 {
  /** The version index, newest first (mw.workflow_versions). */
  versions(workflowId: string): Promise<WorkflowVersion[]>;
  /** Present when the kernel was given a project folder. */
  readonly authoring?: Authoring;
  /** A recorded case as an example case: inputs, recorded tool results and model turns, answers (a replay). */
  caseToExample(caseId: string, opts?: { name?: string; correction?: { step: string; outcome: string; note?: string } }): Promise<ExampleCase>;
}

export type { _DiffHunk as DiffHunk };

// ================================================================ Phase 4 (docs/memwise/22-phase-4-interfaces.md)
// PHASE 4 CONTRACT. `@memwise/server-core` codes against these; change only additively.

import type {
  BindingDef, BindingGap, BindingReport, EffectClass as _EffectClass, IdentityCandidate, IdentityLink, PluginManifest,
  PluginTrust,
} from '@memwise/defs';

/** The meta playbook that binds a plugin into the domain (22 §4). */
export const BIND_PLUGIN = 'bind-plugin';

export type PersonActor = Extract<Actor, { kind: 'person' }>;

/** Where a plugin stands in this domain. */
export type BindingState =
  | { status: 'unbound' }
  /** A bind-plugin case is open for it. */
  | { status: 'binding'; runId: string; caseId: string; draftId?: string }
  | { status: 'bound'; version: number; pluginVersion: string; frozenAt?: string; frozenBy?: string };

export interface PluginSummary {
  id: string;
  /** Newest installed version. */
  version: string;
  /** Every installed version, newest first. */
  versions: string[];
  title: string;
  description?: string;
  trust: PluginTrust;
  imported?: 'claude-plugin';
  tools: number;
  workflows: string[];
  provides: string[];
  requires: string[];
  binding: BindingState;
  /** Bound to an older version than the newest installed. */
  upgradeAvailable?: boolean;
}

export interface PluginDetail extends PluginSummary {
  manifest: PluginManifest;
  dir: string;
  hash: string;
  skills: { name: string; description?: string }[];
  /** Tools with their effective class in this domain (the binding's, else declared; none = irreversible). */
  toolClasses: { name: string; description: string; effect?: _EffectClass; from: 'declared' | 'annotations' | 'binding' | 'none'; off?: boolean }[];
  /** Install notes (ignored Claude plugin parts, discovery problems). */
  notes: string[];
}

/** A binding, live or a draft, with what the review screen shows. */
export interface BindingView {
  pluginId: string;
  draftId?: string;
  binding: BindingDef;
  /** The YAML as on disk (live or the draft's), for editing through drafts.write. */
  text: string;
  path: string;
  gaps: BindingGap[];
  report?: BindingReport;
  /** The plugin's default policy as YAML-ready data, beside the binding's tightening. */
  pluginPolicy?: import('@memwise/defs').PolicyDoc;
}

export interface EntityRecordView {
  entity: string;
  id: string;
  values: Record<string, unknown>;
  hidden: string[];
  createdAt: string;
  links: (IdentityLink & {
    /** The linked record's mapped values read live through the source's `get` tool; absent when it couldn't be read. */
    values?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    error?: string;
  })[];
  /** Field → the plugin it is read through (the entity's `ownership:` names that plugin's namespace or id). */
  readThrough: Record<string, { plugin: string; value: unknown }>;
}

export interface PluginsService {
  list(): Promise<PluginSummary[]>;
  get(id: string): Promise<PluginDetail | undefined>;
  /** Copy a MemWise or Claude plugin folder into `plugins/`; imported MCP tools are discovered now. */
  install(dir: string, by: Actor): Promise<PluginSummary>;
  /** Start bind-plugin for the plugin's newest installed version. */
  startBind(pluginId: string, by: PersonActor): Promise<{ runId: string; caseId: string }>;
  binding(pluginId: string, opts?: { draftId?: string }): Promise<BindingView | undefined>;
}

export interface IdentityService {
  resolve(input: { plugin: string; source?: string }): Promise<{ linked: number; candidates: number; unmatched: number; created: number }>;
  /**
   * Identity candidates, with the outside records' values. With `actor`, only for someone who may
   * decide identity matches (the bind-plugin owner role); anyone else gets none.
   */
  candidates(filter?: { status?: IdentityCandidate['status']; actor?: Actor }): Promise<IdentityCandidate[]>;
  decide(input: { candidateId: string; decision: 'confirm' | 'reject'; by: PersonActor }): Promise<{ applied: boolean; message?: string }>;
  links(entity: string, recordId: string): Promise<IdentityLink[]>;
}

export interface KernelPhase4 {
  readonly plugins: PluginsService;
  readonly identity: IdentityService;
  /** A domain record with its identity links and the fields read through them (22 §5). */
  entityRecord(entity: string, id: string, actor: Actor): Promise<EntityRecordView | undefined>;
}

// ================================================================ Phase 5 (docs/memwise/23-phase-5-interfaces.md)
// PHASE 5 CONTRACT. `@memwise/server-core` codes against these; change only additively.

import type {
  ChannelName, Delivery, ExternalFormAnswer, ExternalLinkSummary, ExternalParticipant, ExternalSubmitInput,
  ExternalSubmitResult, ExtractResult, InboundEvent, InboxLinkAnswer, InboxLinkDecision, InboxLinkResult, LinkRefusal,
  NotifySettings, WebhookSummary,
} from '@memwise/defs';

/** The kernel tool that issues and sends a link to an external step (23 §3). */
export const EXTERNAL_INVITE_TOOL = 'external.invite';

/** What the public handler knows about the request, for rate limits and the link's record. */
export interface PublicRequestInfo { ip?: string; userAgent?: string }

export interface PhaseFiveKernelOptions {
  /**
   * The public base URL links are made from (the relay's `publicUrl`, or a server's own
   * `MEMWISE_PUBLIC_URL`), read at each use; undefined means none, and `external.invite` fails
   * with "connect a public address".
   */
  publicUrl?: () => string | undefined;
  /** Shown to participants as who is asking; default `MEMWISE_BUSINESS_NAME`, else the owner's name. */
  businessName?: string | (() => string | undefined);
}

export interface ExternalService {
  /**
   * Issue a link to an external step of a run, for staff to send themselves ("Copy link", `via:
   * 'copy'`) or for `external.invite`. The token is returned once, with the URL when there is a
   * public address. The person must hold the step's assignee role or the workflow owner's.
   */
  issueLink(input: {
    runId: string; stepId: string; participant: ExternalParticipant; note?: string; expiresInMs?: number; by: PersonActor;
  }): Promise<{ link: ExternalLinkSummary; token: string; url?: string }>;
  links(filter: { caseId?: string; runId?: string; personId?: string }): Promise<ExternalLinkSummary[]>;
  revoke(linkId: string, by: PersonActor): Promise<{ applied: boolean; message?: string }>;
  /**
   * Send an open step link again by its channel (or `via`), after the person saw the preview:
   * recorded as their approval of that delivery.
   */
  resend(input: { linkId: string; via?: ChannelName; by: PersonActor }): Promise<{ applied: boolean; delivery?: Delivery; message?: string }>;
  /** The preview `resend` would send. */
  previewResend(input: { linkId: string; via?: ChannelName }): Promise<{ to: string; via: ChannelName; subject?: string; body: string } | { message: string }>;

  // ---- the public form (23 §4-5): every call takes the raw token and never throws for a bad one
  form(token: string, info?: PublicRequestInfo): Promise<ExternalFormAnswer>;
  saveDraft(token: string, values: Record<string, unknown>, info?: PublicRequestInfo): Promise<{ savedAt: string } | LinkRefusal>;
  upload(token: string, file: { name: string; mime: string; data: Uint8Array }, info?: PublicRequestInfo):
    Promise<{ document: import('@memwise/defs').ExternalDocument } | LinkRefusal | { status: 'invalid'; message: string }>;
  extract(token: string, input: { documents: string[] }, info?: PublicRequestInfo): Promise<ExtractResult | LinkRefusal>;
  submit(token: string, input: ExternalSubmitInput, info?: PublicRequestInfo): Promise<ExternalSubmitResult>;

  /** Staff filling a person or external step in the app: the same extraction, as that person (23 §5). */
  extractForStep(input: { stepRunId: string; documents: string[]; by: PersonActor }): Promise<ExtractResult>;

  // ---- inbox links (23 §6)
  inboxItem(token: string, info?: PublicRequestInfo): Promise<InboxLinkAnswer>;
  decideInboxItem(token: string, decision: InboxLinkDecision, info?: PublicRequestInfo): Promise<InboxLinkResult>;
}

export interface ChannelService {
  /** Channel tools bound now (`email.send`, `whatsapp.send`), by channel. */
  available(): Promise<Record<ChannelName, { tool: string; plugin?: string } | undefined>>;
  deliveries(filter: { caseId?: string; linkId?: string; personId?: string; limit?: number }): Promise<Delivery[]>;
  notifySettings(personId: string): Promise<NotifySettings>;
  setNotifySettings(personId: string, settings: NotifySettings, by: PersonActor): Promise<NotifySettings>;
  /** Webhooks (23 §7): the secret is returned once. */
  createWebhook(input: {
    purpose: string; plugin?: string; scheme: WebhookSummary['scheme']; verifyToken?: string;
    /** The signing secret to use (`meta`: the app's secret from Meta, default `WHATSAPP_APP_SECRET`); default a new random one. */
    secret?: string;
  }, by: Actor):
    Promise<{ hook: WebhookSummary; secret: string }>;
  webhooks(): Promise<WebhookSummary[]>;
  /** The public handler passes a webhook request here; answers what to send back. */
  receiveWebhook(hookId: string, req: { method: string; query: Record<string, string>; headers: Record<string, string>; body: Uint8Array }):
    Promise<{ status: number; body?: string; contentType?: string }>;
  inbound(filter: { hookId?: string; limit?: number }): Promise<InboundEvent[]>;
  onInbound(listener: (event: InboundEvent) => void): () => void;
}

export interface KernelPhase5 {
  readonly external: ExternalService;
  readonly channels: ChannelService;
}

// ================================================================ Phase 6 (docs/memwise/24-phase-6-interfaces.md)
// PHASE 6 CONTRACT. `@memwise/server-core` codes against these; change only additively.

import type {
  ChartKind, CheckResult, DashboardBlock, EntityEvent, FreePageDef, Grant, InboundMessageBody, PageLayoutDef, TriggerDef, ViewDef,
} from '@memwise/defs';

/** Where a field's value on a record page comes from (24 §6). */
export type RecordFieldSource =
  | { kind: 'domain' }
  | { kind: 'plugin'; plugin: string }
  | { kind: 'link'; domain: string; entity: string; recordId?: string }
  | { kind: 'calculated' }
  /** The version that last changed it was written by this step run, person or source. */
  | { kind: 'step'; stepRunId: string; workflowId?: string }
  | { kind: 'person'; personId: string; name?: string }
  | { kind: 'source'; source: string };

export interface RecordField {
  name: string;
  /** Type expression as written (`Ref<Study>`, `Percentage`); `Lifecycle` for status. */
  type: string;
  value: unknown;
  /** The viewer may not see it (value null). */
  hidden?: boolean;
  /** `Ref` values: the referenced record's title and entity key. */
  ref?: { entity: string; id: string; title: string };
  source: RecordFieldSource;
  /** The viewer may edit it in place (domain-owned, not calculated or followed, they have the right). */
  editable: boolean;
  calculated?: boolean;
  followed?: boolean;
  required?: boolean;
  description?: string;
  /** Regulated domain: a change needs a reason. */
  controlled?: boolean;
}

export interface RecordRef { entity: string; id: string; title: string; status?: string }

export interface RecordTransitionOption {
  name: string;
  to: string;
  /** The viewer may make it now (role, guard and signature all met). */
  allowed: boolean;
  /** Why not, in plain words. */
  reason?: string;
  guard?: { condition: string; holds: boolean };
  signed?: boolean;
  /** No person can ever make it: only a playbook step, a connector or MemWise itself (`by: [step]`). */
  automatic?: boolean;
  /** The button's words as the entity says them (`label:`). */
  label?: string;
  /** The page's main button (`primary: true`). */
  primary?: boolean;
}

export interface RecordFlag {
  id: string;
  entity: string;
  recordId: string;
  invariant: string;
  message: string;
  raisedAt: string;
  closedAt?: string;
}

export interface SignatureView {
  id: string;
  stepRunId: string;
  caseId: string;
  personId: string;
  name: string;
  meaning: string;
  at: string;
  entity: string;
  recordId: string;
  contentHash: string;
  /** The record's content now hashes differently: "changed since signed". */
  changedSince: boolean;
}

export interface RecordVersionSummary {
  version: number;
  at: string;
  by: string;
  /** A readable name for `by` (person's name, step title, source). */
  byLabel?: string;
  via?: string;
  reason?: string;
  changed: string[];
  hash: string;
}

export interface MentionView { sourceKind: 'note' | 'chat' | 'step' | 'comment' | 'page'; sourceId: string; label: string; at: string; caseId?: string }

/** Review mode of a record page (24 §11). */
export interface RecordReview {
  stepRunId: string;
  runId: string;
  caseId: string;
  workflowId: string;
  stepId: string;
  title: string;
  instructions?: string;
  /** The values the step writes, as proposed (from the case), with where each came from. */
  proposed: {
    field: string;
    type: string;
    value: unknown;
    provenance?: import('@memwise/defs').Provenance;
    confidence?: number;
    page?: number;
    quote?: string;
    document?: string;
    required?: boolean;
    /** A reference's record, by its title. */
    ref?: RecordRef;
  }[];
  /** The checks of the agent step(s) that prepared it, with evidence. */
  checks: (CheckResult & { stepRunId: string })[];
  outcomes: string[];
  /** The e-signature submitting needs (24 §9). */
  sign?: { meaning: string; as: { personId: string; name: string; roles: string[] } };
  returnedComments?: { by: string; comment: string; at: string }[];
}

export interface RecordPage {
  /** Entity key. */
  entity: string;
  domain: string;
  entityName: string;
  regulated: boolean;
  id: string;
  title: string;
  status?: string;
  layout: PageLayoutDef;
  /** Every field the viewer may see (and hidden ones marked), in definition order, then calculated, then followed. */
  fields: RecordField[];
  /** Breadcrumbs: the parent chain, root first. */
  parents: RecordRef[];
  /** `types`: each row value's declared type ("Date", "Enum[...]"), so the page formats it. */
  related: Record<string, { entity: string; total: number; rows: (RecordRef & { values: Record<string, unknown> })[]; types?: Record<string, string> }>;
  cases: { caseId: string; runId: string; workflowId: string; title: string; state: string; status: RunStatus; updatedAt: string; waitingOn?: string }[];
  /** `passed`: the states on the way from the first to the current one (a rejected Evidence never was reviewed). */
  lifecycle?: { states: string[]; current?: string; passed?: string[]; transitions: RecordTransitionOption[] };
  flags: RecordFlag[];
  signatures: SignatureView[];
  notes?: { body: string; version: number; by: string; at: string };
  mentions: MentionView[];
  /** Workflows that can start from this record. */
  start: { workflowId: string; title: string }[];
  /** `viewer` blocks: the document each one shows. */
  documents: Record<string, DocumentValue | null>;
  history: RecordVersionSummary[];
  review?: RecordReview;
  // ---- Literature (docs/memwise/25-literature-poc.md §4, §5); present when the layout has such blocks.
  /** `kpis` blocks: each field's tile, by field name. */
  kpis?: Record<string, RecordKpi>;
  /** `chart` blocks: the rows each draws, by block key (`pageBlockKey(area, index)`, e.g. `main:1`). */
  charts?: Record<string, ChartData>;
  /** `viewer` blocks on a Text field: the text and the quotes to light up, by field name. */
  texts?: Record<string, RecordTextView>;
}

// ---------------------------------------------------------------- Literature (docs/memwise/25-literature-poc.md)

/** The key of a page block's data: its area and its index in that area (`main:1`). */
export const pageBlockKey = (area: string, index: number): string => `${area}:${index}`;

/** A KPI tile on a record page (25 §5): a calculated or Number field's value. */
export interface RecordKpi { field: string; value: number | null; type: string; description?: string }

/** One row of a chart (the same shape as a chat ```chart block's `data`, 25 §5). */
export interface ChartDatum {
  /** bar/line/donut: the `by` value in words ("Not set" for none); interval: the row's label. */
  label: string;
  /** bar/line/donut: how many records; interval: the record's value. */
  value: number;
  /** interval: the interval's ends, when the record has them. */
  low?: number;
  high?: number;
  /** interval: the row's own unit, when it differs from the chart's. */
  unit?: string;
  /** bar/line/donut: the `by` value as stored (null: not set), for a filter. */
  key?: string | null;
  /** interval: the record the row is. */
  record?: RecordRef;
}

/** A chart's data: a record page's `chart` block or a free page's (25 §5). */
export interface ChartData {
  kind: ChartKind;
  title?: string;
  /** interval: the unit every row shares (absent when they differ: each row has its own). */
  unit?: string;
  data: ChartDatum[];
  /** bar/line/donut: records counted; interval: rows drawn. */
  total: number;
  /** interval: records left out because they have no value. */
  skipped?: number;
}

/** A quote lit up in a text viewer (25 §4). `start`/`end`: where it is in the text (UTF-16 offsets), when found. */
export interface RecordQuoteHighlight {
  quote: string;
  /** The field it is the quote for: the record's own field (`kind: value`), or the related record's quote field. */
  field: string;
  /** `value`: one of the record's values was read from these words; `related`: a related record quotes them. */
  kind: 'value' | 'related';
  /** value: the record's value read from the quote. */
  value?: unknown;
  /** related: the record quoting this text. */
  record?: RecordRef;
  found: boolean;
  start?: number;
  end?: number;
}

export interface RecordTextView { text: string | null; highlights: RecordQuoteHighlight[] }

/** `kernel.records.keep` (25 §6): rows kept from a chat, each created in the entity's initial state. */
export interface RecordKeepInput { entity: string; rows: Record<string, unknown>[]; chatId: string }
export interface RecordKeepResult {
  entity: string;
  rows: {
    /** The new record, when it was kept. */
    id?: string;
    /** With a `quote_of` field: whether the quote is in its source (false: kept, and flagged). */
    quoteFound?: boolean;
    /** Why the row wasn't kept. */
    error?: string;
    errors?: Record<string, string[]>;
  }[];
}

export interface RecordWriteResult {
  applied: boolean;
  status: 'applied' | 'forbidden' | 'invalid' | 'guard' | 'reason-required' | 'signature-required' | 'missing' | 'stale';
  message?: string;
  errors?: Record<string, string[]>;
  id?: string;
  version?: number;
}

export interface RecordQuery {
  /** Entity key, or bare within `domain`. */
  entity: string;
  domain?: string;
  filter?: string;
  sort?: { field: string; desc?: boolean }[];
  group?: string;
  columns?: string[];
  limit?: number;
  offset?: number;
}

export interface RecordQueryResult {
  entity: string;
  columns: { name: string; type: string; calculated?: boolean; followed?: boolean }[];
  /** `refs`: the records a row's Ref fields point at, by title (absent when none). */
  rows: (RecordRef & { values: Record<string, unknown>; hidden: string[]; refs?: Record<string, RecordRef> })[];
  total: number;
  /** With `group`: the groups in order, with counts (and the title, when grouped by a Ref). */
  groups?: { key: string | null; count: number; title?: string }[];
}

export type TreeNode =
  | { kind: 'record'; entity: string; id: string; title: string; status?: string; hasChildren: boolean }
  | { kind: 'group'; entity: string; parent?: { entity: string; id: string }; title: string; count: number; viewFilter?: string }
  | { kind: 'page'; pageId: string; title: string; params: Record<string, string> };

export interface DashboardData {
  pageId: string;
  title: string;
  description?: string;
  params: Record<string, string>;
  computedAt: string;
  blocks: (
    | { kind: 'kpi'; label: string; value: number | null; target?: number; format?: 'number' | 'percent'; detail?: string }
    | { kind: 'table' | 'list'; title?: string; result: RecordQueryResult }
    | { kind: 'heatmap'; title?: string; columns: string[]; rows: { record: RecordRef; values: (number | null)[] }[] }
    | { kind: 'text'; markdown: string }
    | { kind: 'chart'; chart: ChartData }
  )[];
}

export interface DomainSummary {
  id: string;
  name: string;
  description?: string;
  regulated: boolean;
  owner?: string;
  retentionMs?: number;
  entities: { key: string; entity: string; title?: string; count: number; parent?: string; lifecycle?: string[] }[];
  workflows: string[];
  pages: { id: string; title: string; under?: { entity: string } }[];
  views: { id: string; title: string; entity: string }[];
  /** Open flags and waiting items in this domain, for the sidebar. */
  flags: number;
  /** Pages (26 §4): the app's own "Refresh a page" playbook (left out of `workflows`). */
  pageRefresh?: string;
}

export interface DomainsService {
  list(actor: Actor): Promise<DomainSummary[]>;
  workspace(): Promise<{ name: string; stormLimit: number; regulated: boolean }>;
  grants(personId: string): Promise<Grant[]>;
  setGrants(personId: string, grants: Grant[], by: Actor): Promise<Grant[]>;
}

export interface RecordsService {
  page(entity: string, id: string, actor: Actor, opts?: { review?: { stepRunId: string } }): Promise<RecordPage | undefined>;
  /** Create a record as a person or the system (seeding, the app's "New"); steps use the entity tools. */
  create(input: { entity: string; values: Record<string, unknown>; status?: string; reason?: string; id?: string }, actor: Actor): Promise<RecordWriteResult>;
  update(input: { entity: string; id: string; values: Record<string, unknown>; reason?: string }, actor: Actor): Promise<RecordWriteResult>;
  transition(input: { entity: string; id: string; transition: string; reason?: string }, actor: Actor): Promise<RecordWriteResult>;
  query(query: RecordQuery, actor: Actor): Promise<RecordQueryResult>;
  tree(domain: string, actor: Actor, opts?: { parent?: { entity: string; id: string } }): Promise<TreeNode[]>;
  dashboard(domain: string, pageId: string, params: Record<string, string>, actor: Actor): Promise<DashboardData>;
  views(domain: string, actor: Actor, opts?: { entity?: string }): Promise<(ViewDef & { personal: boolean; domain: string })[]>;
  saveView(domain: string, view: ViewDef, actor: Actor): Promise<ViewDef>;
  saveNote(input: { entity: string; id: string; body: string; reason?: string }, actor: Actor): Promise<RecordWriteResult>;
  flags(filter: { domain?: string; entity?: string; recordId?: string; open?: boolean }): Promise<RecordFlag[]>;
  /** Entity events after `afterSeq` (tests, the dispatcher's view). */
  events(filter: { entity?: string; recordId?: string; afterSeq?: number; limit?: number }): Promise<EntityEvent[]>;
  /** Evaluate a condition on one record now (guards, wait_until, the app's "why"). */
  evaluate(entity: string, id: string, condition: string, actor: Actor): Promise<{ holds: boolean; values: Record<string, unknown> }>;
  /**
   * Literature (25 §6, D83): rows kept from a chat, as the person: each created in the entity's
   * initial state with the reason "kept from chat <chatId>", its quotes checked. Refused for an
   * entity without `keep_from_chat`.
   */
  keep(input: RecordKeepInput, actor: Actor): Promise<RecordKeepResult>;
}

export interface TriggerSummary {
  /** `<workflowId>#<index>` */
  id: string;
  workflowId: string;
  domain: string;
  def: TriggerDef;
  /** Plain words: "When a Site enters Activating", "30 days before a Person's CV expires". */
  description: string;
  lastFiredAt?: string;
  /** Schedules and date triggers: the next firing (date triggers: the earliest due record, with it). */
  nextDue?: { at: string; record?: RecordRef };
  firings: number;
  held: number;
}

export interface TriggerFiring {
  key: string;
  triggerId: string;
  workflowId: string;
  kind: TriggerDef['kind'];
  record?: string;
  runId?: string;
  caseId?: string;
  status: 'started' | 'held' | 'discarded' | 'failed';
  at: string;
  message?: string;
}

export interface TriggersService {
  list(): Promise<TriggerSummary[]>;
  firings(filter: { triggerId?: string; status?: TriggerFiring['status']; limit?: number }): Promise<TriggerFiring[]>;
  /** Start or discard the held firings of a trigger (storm guard). */
  release(triggerId: string, decision: 'start' | 'discard', by: PersonActor): Promise<{ applied: boolean; started: number; message?: string }>;
  /** An incoming message to a domain's intake address (the email inbound hook ends here). */
  receiveMessage(domain: string, body: InboundMessageBody): Promise<{ messageId: string; duplicate: boolean; firings: TriggerFiring[] }>;
  /** Fire whatever date and schedule triggers are due at `now` (default the clock); the kernel calls it every minute. */
  sweep(now?: Date): Promise<TriggerFiring[]>;
  /** Wait until the dispatcher has handled every entity event committed so far (tests). */
  settle(timeoutMs?: number): Promise<void>;
}

export interface AuditTrail {
  entity: string;
  id: string;
  title: string;
  domain: string;
  regulated: boolean;
  retentionMs?: number;
  values: Record<string, unknown>;
  versions: (RecordVersionSummary & { values: Record<string, unknown>; prevHash: string })[];
  chain: { ok: boolean; brokenAt?: number; message?: string };
  signatures: SignatureView[];
  cases: { caseId: string; workflowId: string; title: string; stepRuns: { stepRunId: string; stepId: string; performer: string; outcome?: string; decidedBy?: string; at: string }[] }[];
  flags: RecordFlag[];
  exportedAt: string;
}

export interface AuditService {
  trail(entity: string, id: string, actor: Actor): Promise<AuditTrail | undefined>;
  verifyChain(entity: string, id: string): Promise<{ ok: boolean; brokenAt?: number; message?: string }>;
  export(entity: string, id: string, format: 'json' | 'pdf', actor: Actor): Promise<{ name: string; mime: string; data: Uint8Array } | undefined>;
}

export interface KernelPhase6 {
  readonly domains: DomainsService;
  readonly records: RecordsService;
  readonly triggers: TriggersService;
  readonly audit: AuditService;
}

/** Phase 6 additions to existing shapes (24 §12), declared here so the pieces agree. */
export interface SignatureInput { password: string }

/** A hand-off link shown on a case (24 §8). */
export interface CaseLinkView {
  kind: 'started' | 'called' | 'started_by' | 'called_by';
  caseId: string;
  runId: string;
  workflowId: string;
  title: string;
  state: string;
  status: RunStatus;
}

/** A run waiting in a `wait_until` state, for the case view. */
export interface WaitingCondition { record: RecordRef; condition: string; holds: boolean; values: Record<string, unknown> }

export type { DashboardBlock as _DashboardBlock, FreePageDef as _FreePageDef };

// ================================================================ Projects and pages (docs/memwise/26-projects-and-pages.md §4)

export type PageStatus = 'draft' | 'kept' | 'archived';

/** A kept page's schedule: `every` is `daily`, `month` or a weekday (`mon` … `sun`). */
export interface PageRefreshInfo { every: string; until?: string; next?: string; last?: string; playbook?: string; summaryDue?: string }

/** What the waiting list needs about an answer change. */
export interface PageChangeRef {
  changeId: string;
  pageId: string;
  pageTitle: string;
  project: string;
  /** "1 new trial" */
  label?: string;
  /** What started the refresh that found it. */
  from?: { kind: 'schedule' | 'manual' | 'summary'; every?: string; by?: string };
  at: string;
}

/** A page in its project's tree (the sidebar's PAGES, Home's "Pages kept up to date"). */
export interface PageSummary {
  id: string;
  project: string;
  domain: string;
  parent?: string;
  title: string;
  status: PageStatus;
  question?: string;
  /** The first paragraph, in plain words: what the page says now. */
  headline: string;
  refresh?: PageRefreshInfo;
  /** Its `until` day has passed: it no longer refreshes (it stays kept). */
  refreshEnded?: boolean;
  /** Phase 6 written pages hang in the record tree: under an entity type, or one record. */
  under?: { entity: string; id?: string };
  pinned: boolean;
  sumsChildren: boolean;
  version: number;
  owner?: string;
  createdBy?: string;
  updatedAt: string;
  /** The answer change waiting for review, if any. */
  pendingChange?: { id: string; label?: string };
  /** The last refresh: when, and whether it changed anything. */
  lastRefresh?: { at: string; status: 'accepted' | 'sent_back' | 'nothing_new' | 'pending'; title?: string };
}

/** One line of a page's history ("1 June, ATTAIN-MAINTAIN added, accepted by Leah"). */
export interface PageHistoryEntry {
  at: string;
  kind: 'made' | 'asked' | 'chat' | 'person' | 'undo' | 'accepted' | 'sent_back' | 'nothing_new' | 'refresh';
  version?: number;
  /** Who: the person's name (`by`), or the chat or run it came through. */
  by?: string;
  byName?: string;
  /** What changed, in a few words (an accepted change's title, a version's reason). */
  text?: string;
  changeId?: string;
}

/** A sub-page as its parent shows it. */
export interface PageChild extends PageSummary {
  /** Whether the parent's summary includes it: kept sub-pages only (drafts are left out). */
  inSummary: boolean;
}

/** A page as it opens: its body with live blocks computed, sub-pages, history and what chat changed. */
export interface PageView extends PageSummary {
  /** The body with live blocks (`records`, `subpages`) computed now. */
  body: string;
  /** The body as written (live blocks as their queries). */
  written: string;
  chatId?: string;
  regulated: boolean;
  breadcrumb: { id: string; title: string }[];
  children: PageChild[];
  history: PageHistoryEntry[];
  /** The last version came from a chat: the sections it changed (`''`: the text before the first heading), with Undo. */
  changedFromChat?: { version: number; chatId?: string; sections: string[] };
  /** Undo goes back one version (there is one to go back to). */
  canUndo: boolean;
  /** Sub-pages that changed in the last week (a parent's "What changed this week"). */
  changes: { pageId: string; title: string; kind: 'accepted' | 'nothing_new' | 'made' | 'chat'; text?: string; byName?: string; at: string }[];
}

/** "Review an answer change" (mock LChange). */
export interface PageChangeView {
  id: string;
  pageId: string;
  pageTitle: string;
  project: string;
  status: 'pending' | 'accepted' | 'sent_back' | 'nothing_new';
  fromVersion: number;
  toVersion?: number;
  summary: import('@memwise/db').PageChangeSummary;
  /** The page now and as the refresh rewrote it. */
  before: string;
  after: string;
  runId?: string;
  caseId?: string;
  /** The waiting "Review an answer change" step, while it waits. */
  stepRunId?: string;
  reviewedBy?: string;
  reviewedByName?: string;
  comment?: string;
  at: string;
  /** Whether this person may accept or send it back. */
  mayDecide: boolean;
  /** The page changed since the refresh read it (a chat edit, an Undo): it can only be sent back. */
  stale?: boolean;
}

export interface PageWriteResult { applied: boolean; page?: PageView; message?: string; status?: 'applied' | 'forbidden' | 'invalid' | 'stale' | 'missing' | 'regulated' }

export interface PagesService {
  /** A project's pages (not archived), parents before children. */
  list(project: string, actor: Actor): Promise<PageSummary[]>;
  get(id: string, actor: Actor): Promise<PageView | undefined>;
  versions(id: string, actor: Actor): Promise<import('@memwise/db').WrittenPageVersion[]>;
  /** A new page (a draft, unless `status` says otherwise). `via`: `chat:<id>` or `person:<id>`. */
  create(input: { project: string; title: string; body?: string; question?: string; parent?: string; status?: PageStatus; chatId?: string;
    sumsChildren?: boolean; via?: string; reason?: string }, actor: Actor): Promise<PageWriteResult>;
  /**
   * A new version. A draft changes freely; a kept page too, with Undo, except in a regulated
   * domain (refused: there a change goes through a change request). An archived page is read only.
   */
  update(id: string, input: { title?: string; body?: string; parent?: string | null; expectedVersion?: number; via?: string; reason?: string;
    sumsChildren?: boolean }, actor: Actor): Promise<PageWriteResult>;
  /** Back one version: a new version with the body before the last one. */
  undo(id: string, actor: Actor, opts?: { version?: number }): Promise<PageWriteResult>;
  /** Kept, refreshed on a schedule (`every`: `mon` … `sun`, `daily`, `month`), optionally under a parent. */
  keep(id: string, input: { every?: string; until?: string; parent?: string | null }, actor: Actor): Promise<PageWriteResult>;
  archive(id: string, actor: Actor): Promise<PageWriteResult>;
  /** Start its refresh now. */
  refreshNow(id: string, actor: Actor): Promise<{ started: boolean; runId?: string; caseId?: string; message?: string }>;
  getChange(id: string, actor: Actor): Promise<PageChangeView | undefined>;
  /** Accept or send back an answer change: answers its "Review an answer change" step. */
  decideChange(id: string, input: { decision: 'accept' | 'send_back'; comment?: string }, actor: Actor): Promise<{ applied: boolean; message?: string; status?: string }>;
  /** Change the waiting change's page (the reviewer's chat): "Changed the update · Undo". */
  reviseChange(id: string, input: { body: string; via?: string; note?: string }, actor: Actor): Promise<{ applied: boolean; change?: PageChangeView; message?: string }>;
  /** Start the refreshes that are due at `now` (the minute sweep calls it). */
  sweep(now?: Date): Promise<{ pageId: string; runId: string; caseId?: string }[]>;
  /** The playbook that refreshes a page in this project (the app's own, else the built-in). */
  refreshPlaybook(project: string): string;
}

export interface KernelPages {
  readonly pages: PagesService;
}
