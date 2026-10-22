// Stage 5 of "Projects and pages" (docs/memwise/26-projects-and-pages.md §7, §8; D115–D119):
// regulated projects. STAGE 5 CONTRACT: `@memwise/server-core` codes against these; change only
// additively. A project is a domain for now: every `project` here is a domain id.
import type { AuditActorKind, ChangeRequestStatus, InspectorPerson } from '@memwise/db';
import type { Actor, PersonActor, SubmitResult } from '../types.ts';

export type { AuditActorKind, ChangeRequestStatus, InspectorPerson };

// ---------------------------------------------------------------- change requests (26 §8)

/**
 * The past cases a change request is tried on: these cases, or the playbook's finished cases
 * (newest first, at most `limit`, default 50) in a date range and with these case values.
 */
export interface ValidationSet {
  /** What the person called it ("42 CVs filed in September"); else the app words it from the filter. */
  label?: string;
  caseIds?: string[];
  since?: string;
  until?: string;
  /** Case values that must match (`{ artifact: 'Investigator CV' }`). */
  where?: Record<string, string | number | boolean>;
  limit?: number;
}

/** A run of text in a readable diff: kept, added (underlined) or removed (struck out). */
export interface DiffSegment { kind: 'same' | 'added' | 'removed'; text: string }

/** One step of the playbook as the change leaves it (26 §8 "what changes, with strikeouts"). */
export interface ChangeStepRow {
  /** 1-based, in the playbook's order (the draft's; a removed step keeps the live position). */
  n: number;
  stepId: string;
  change: 'same' | 'added' | 'removed' | 'changed';
  /** The step's title, with what changed marked. */
  title: DiffSegment[];
  /** Who does it, before and after: agent | person | system | external, and the assignee role. */
  who: { performer: string; role?: string; roleTitle?: string };
  whoBefore?: { performer: string; role?: string; roleTitle?: string };
  /** The checkpoint rules (the AI checks), each kept, added or removed. */
  rules: DiffSegment[];
  /** The step's instructions, outcomes or transitions changed (the file diff shows how). */
  instructionsChanged: boolean;
  outcomesChanged: boolean;
}

/** A changed file of the draft, with its changed lines only (rules, record types, step files). */
export interface ChangeFileDiff {
  path: string;
  kind: 'playbook' | 'step' | 'rules' | 'record-type' | 'example' | 'other';
  status: 'added' | 'removed' | 'modified';
  lines: { kind: 'added' | 'removed' | 'context'; text: string }[];
}

/** How one past case came out on the draft: would the AI checks alone have done what QC did? */
export interface ValidationCaseResult {
  caseId: string;
  /** A few words for the case (the document's name, or its first values). */
  title: string;
  finishedAt?: string;
  /** What the person at the person step decided (`approved`, `sent_back`), and who. */
  decided: { stepId: string; outcome: string; by?: string; comment?: string };
  /** Whether that decision accepted the agent's work (the step's first outcome). */
  accepted: boolean;
  /** The draft's AI checks on the case's recorded result and evidence. */
  ai: 'pass' | 'fail' | 'error';
  /** The AI checks agree with the person's decision. */
  matches: boolean;
  failedRules?: { rule: string; reason?: string }[];
  error?: string;
}

export interface ChangeValidation {
  id: string;
  draftHash: string;
  /** The draft is still the one this ran on. */
  current: boolean;
  setLabel: string;
  total: number;
  passed: number;
  checkErrors: number;
  status: 'passed' | 'failed';
  results: ValidationCaseResult[];
  by?: string;
  byName?: string;
  at: string;
}

export interface ChangeSignoff {
  role: 'raiser' | 'qa';
  /** The workspace role that signs it (QA: the domain's `qa:`, else its owner). */
  roleId?: string;
  roleTitle?: string;
  /** Who signed, or for the raiser who will. */
  person?: { id: string; name: string };
  status: 'signed' | 'waiting' | 'not-yet';
  signedAt?: string;
  meaning: string;
  signatureId?: string;
}

export interface ChangeRequestSummary {
  id: string;
  number: number;
  /** `CR-014`. */
  label: string;
  project: string;
  workflowId: string;
  playbookTitle: string;
  title: string;
  status: ChangeRequestStatus;
  raisedBy: { id: string; name: string };
  raisedAt: string;
  updatedAt: string;
  /** The latest validation: passed of total, and whether it is of the current draft. */
  validation?: { passed: number; total: number; status: 'passed' | 'failed'; current: boolean };
}

export interface ChangeRequestView extends ChangeRequestSummary {
  draftId: string;
  draftHash: string;
  reason: string;
  regulated: boolean;
  /** The version live now, and the one this becomes when QA signs (or became). */
  liveVersion?: number;
  nextVersion?: number;
  toVersion?: number;
  /** Cases still running on the live version: they finish on it. */
  openCasesOnLive: number;
  steps: ChangeStepRow[];
  files: ChangeFileDiff[];
  checks: { errors: number; warnings: number; messages: string[] };
  validationSet: ValidationSet;
  validations: ChangeValidation[];
  signoffs: ChangeSignoff[];
  chatId?: string;
  closedAt?: string;
  closedBy?: { id: string; name: string };
  /** What the asking person may do now. */
  can: { edit: boolean; validate: boolean; send: boolean; approve: boolean; withdraw: boolean };
}

export interface ChangeSignResult extends Pick<SubmitResult, 'applied' | 'message'> {
  status: SubmitResult['status'] | 'not-validated' | 'stale' | 'no-reason' | 'not-your-turn' | 'conflict' | 'failed';
  view?: ChangeRequestView;
  /** QA's signature published it: the playbook's new version. */
  published?: { workflowId: string; version: number; hash: string };
}

export interface ChangesService {
  list(filter: { project?: string; workflowId?: string; status?: ChangeRequestStatus[] }, actor: Actor): Promise<ChangeRequestSummary[]>;
  /** By id or by number (`CR-014`, with `project`). */
  get(idOrNumber: string, actor: Actor, project?: string): Promise<ChangeRequestView | undefined>;
  /** The change request of a draft, if it has one. */
  forDraft(draftId: string): Promise<ChangeRequestSummary | undefined>;
  /**
   * Opens a change request on a regulated domain's playbook: a new draft of it (or `draftId`, an
   * open change draft of it that has no request yet). Refused for a playbook outside a regulated domain.
   */
  open(input: { workflowId: string; title?: string; reason?: string; draftId?: string; validationSet?: ValidationSet }, by: PersonActor): Promise<ChangeRequestView>;
  /** Title, reason, the validation set; only while it is open. */
  update(id: string, patch: { title?: string; reason?: string; validationSet?: ValidationSet }, by: PersonActor): Promise<ChangeRequestView>;
  /** Remembers the chat that edits it. */
  setChat(id: string, chatId: string): Promise<void>;
  /** Runs the checks and the AI checks of the draft on the validation set (26 §8: "41 of 42 match QC"). */
  validate(id: string, by: PersonActor, opts?: { set?: ValidationSet }): Promise<ChangeValidation>;
  /**
   * Signs the request with the person's password (Part 11): the raiser's signature sends it to
   * QA; QA's signature publishes the draft as the playbook's next version.
   */
  sign(id: string, input: { password: string }, by: PersonActor): Promise<ChangeSignResult>;
  withdraw(id: string, by: PersonActor, reason?: string): Promise<ChangeRequestView>;
  /** The number the next request of a project gets (a project moving off a paper log). */
  setNextNumber(project: string, next: number): Promise<void>;
}

// ---------------------------------------------------------------- the audit log (26 §8, D77)

export interface AuditEntry {
  seq: number;
  id: string;
  project: string;
  at: string;
  actorKind: AuditActorKind;
  actor: string;
  actorLabel: string | null;
  action: string;
  entity: string | null;
  recordId: string | null;
  caseId: string | null;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/** Entries made readable: the record's title, the step's and playbook's titles. */
export interface AuditEntryView extends AuditEntry {
  recordTitle?: string;
  stepTitle?: string;
  playbookTitle?: string;
}

export interface AuditQuery {
  project: string;
  entity?: string;
  recordId?: string;
  caseId?: string;
  actorKinds?: AuditActorKind[];
  actions?: string[];
  afterSeq?: number;
  limit?: number;
}

/** The signed export (26 §8): the entries, and an Ed25519 signature over them. */
export interface AuditExport {
  format: 'memwise-audit/1';
  project: string;
  filter: Omit<AuditQuery, 'project' | 'limit' | 'afterSeq'>;
  /** The whole log from its first entry (so the first entry must start the chain). */
  complete: boolean;
  exportedAt: string;
  exportedBy: string;
  entries: AuditEntry[];
  /** The kernel's public key (SPKI, base64) and its signature over the canonical JSON of everything above. */
  publicKey: string;
  signature: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  /** The chain: every hash recomputes and every entry follows the one before. */
  chain: { ok: boolean; brokenAt?: { seq: number; id: string; reason: 'hash' | 'link' }; message?: string };
  /** The export's signature (absent when checking the database). */
  signature?: { ok: boolean; publicKey: string; trusted?: boolean };
  message: string;
}

export interface AuditLogService {
  /** Entries in order (oldest first), readable. A record's trail includes the cases that touched it. */
  list(query: AuditQuery, actor: Actor): Promise<{ entries: AuditEntryView[]; chain: { ok: boolean; message?: string } }>;
  /** Exports entries signed; the export itself is logged (`audit.exported`). */
  export(query: AuditQuery, actor: Actor): Promise<AuditExport>;
  /** Checks an export (its chain and signature), or the project's whole log in the database. */
  verify(input: { export: unknown } | { project: string }): Promise<AuditVerifyResult>;
  /** Appends an entry of the kernel's own (views, downloads, exports, change requests). */
  append(entry: import('@memwise/db').NewAuditEntry): Promise<string>;
}

// ---------------------------------------------------------------- inspectors (26 §8)

export interface InspectorLinkView {
  id: string;
  project: string;
  name: string;
  inspectors: InspectorPerson[];
  expiresAt: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  revokedAt?: string;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
  status: 'active' | 'expired' | 'revoked';
  views: number;
  downloads: number;
  questions: { open: number; answered: number };
}

export interface InspectorQuestionView {
  id: string;
  linkId: string;
  linkName: string;
  project: string;
  askedBy?: string;
  record?: { entity: string; id: string; title: string };
  question: string;
  askedAt: string;
  answer?: string;
  answeredBy?: { id: string; name: string };
  answeredAt?: string;
}

/** What an inspector's link is and lets them see. */
export interface InspectorSession {
  linkId: string;
  project: string;
  projectName: string;
  name: string;
  inspector: string;
  expiresAt: string;
}

/** A filed document as an inspector sees it: its index, versions, signatures. */
export interface InspectorDocument {
  entity: string;
  id: string;
  title: string;
  zone?: string;
  site?: { id: string; label: string };
  artifact?: string;
  status: string;
  version: number;
  filedAt?: string;
  signatures: { name: string; meaning: string; at: string; changedSince: boolean }[];
  file?: { id: string; name: string; mime: string; size: number; sha256: string };
  /** The record's index values (no notes, no review proposals). */
  values: { field: string; label: string; value: string }[];
}

export interface InspectorIndex {
  session: InspectorSession;
  zones: { id: string; number: string; name: string; filed: number }[];
  sites: { id: string; label: string }[];
}

export type InspectorRefusal = { refused: 'unknown' | 'expired' | 'revoked' };

export interface InspectorService {
  create(input: { project: string; name: string; inspectors: InspectorPerson[]; expiresAt: string }, by: PersonActor): Promise<{ link: InspectorLinkView; token: string; url?: string }>;
  list(project: string, actor: Actor): Promise<InspectorLinkView[]>;
  revoke(id: string, by: PersonActor): Promise<InspectorLinkView>;
  extend(id: string, expiresAt: string, by: PersonActor): Promise<InspectorLinkView>;
  questions(filter: { project?: string; linkId?: string; open?: boolean }, actor: Actor): Promise<InspectorQuestionView[]>;
  answer(questionId: string, answer: string, by: PersonActor): Promise<InspectorQuestionView>;

  // The inspector's side, by token (public routes). Every call checks the link; views and downloads are logged.
  open(token: string, req?: import('../types.ts').PublicRequestInfo): Promise<InspectorIndex | InspectorRefusal>;
  documents(token: string, filter: { zone?: string; site?: string; q?: string }): Promise<{ documents: InspectorDocument[]; total: number } | InspectorRefusal>;
  document(token: string, entity: string, id: string): Promise<InspectorDocument | InspectorRefusal | undefined>;
  trail(token: string, entity: string, id: string): Promise<{ entries: AuditEntryView[]; chain: { ok: boolean } } | InspectorRefusal | undefined>;
  download(token: string, entity: string, id: string): Promise<{ name: string; mime: string; data: Uint8Array } | InspectorRefusal | undefined>;
  ask(token: string, input: { question: string; entity?: string; recordId?: string }): Promise<InspectorQuestionView | InspectorRefusal>;
  requests(token: string): Promise<InspectorQuestionView[] | InspectorRefusal>;
}

// ---------------------------------------------------------------- the TMF index (26 §7)

export interface TmfZoneRow {
  /** `05`. */
  number: string;
  id: string;
  /** The Reference Model's name (the app translates it). */
  name: string;
  expected: number;
  filed: number;
  missing: number;
  inQc: number;
  filedLate: number;
}

export interface TmfSiteRow { siteId: string; label: string; expected: number; filed: number; missing: number; inQc: number }

export interface TmfIndex {
  project: string;
  /** The study it reads (the study plan's expected documents), when there is more than one. */
  study?: { id: string; label: string };
  kpis: { expected: number; filed: number; missing: number; inQc: number; oldestInQcDays: number | null; filedLate: number; lateAfterDays: number };
  zones: TmfZoneRow[];
  /** With `zone`: that zone's sites and its documents. */
  zone?: {
    row: TmfZoneRow;
    sites: TmfSiteRow[];
    documents: { entity: string; id: string; title: string; artifact?: string; site?: string; status: string; filedLate: boolean; inQcDays?: number }[];
    missing: { id: string; artifact: string; site?: string; dueDate?: string }[];
  };
  /** Artifacts the zone model doesn't place: listed, and counted in no zone. */
  unplaced: string[];
}

export interface TmfService {
  /**
   * `project`: the regulated app (`etmf`). `projects` (Stage 3): only records of these projects of
   * it, a study's (records every project shares are kept); with one study among them, it names it.
   */
  index(input: { project: string; projects?: string[]; study?: string; zone?: string }, actor: Actor): Promise<TmfIndex>;
}

export interface KernelRegulated {
  readonly changes: ChangesService;
  readonly auditLog: AuditLogService;
  readonly inspectors: InspectorService;
  readonly tmf: TmfService;
}
