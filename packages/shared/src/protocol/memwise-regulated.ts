/**
 * MemWise app API, Stage 5 of "Projects and pages": regulated projects
 * (docs/memwise/26-projects-and-pages.md §7, §8; D115–D119): change requests, the project audit
 * log, inspector access and the TMF index.
 *
 * STAGE 5 CONTRACT. `@memwise/server-core` (handlers/rpc/memwise-regulated.ts) builds these from
 * the kernel; the renderer only ever sees these shapes. Plain JSON only. Change only additively.
 * A project is a domain for now: every `project` / `projectId` is a domain id (`etmf`).
 *
 * Channels (RPC_CHANNELS.memwise):
 * memwise:changes:list        (ws, { project?, workflowId?, status? })           → MwChangeRequestSummary[]
 * memwise:changes:get         (ws, { crId, project? })                            → MwChangeRequest | null   (crId: id or `CR-014`)
 * memwise:changes:open        (ws, MwOpenChangeInput)                             → MwOpenChangeResult
 * memwise:changes:update      (ws, { crId, project?, title?, reason?, validationSet? }) → MwChangeRequest
 * memwise:changes:validate    (ws, { crId, project?, set? })                      → MwChangeValidation
 * memwise:changes:sign        (ws, { crId, project?, password })                  → MwChangeSignResult
 * memwise:changes:withdraw    (ws, { crId, project?, reason? })                   → MwChangeRequest
 * memwise:changes:chat        (ws, { crId, project? })                            → { sessionId: string }
 *   The calls that change a request (update, validate, sign, withdraw, chat) take its id (`cr_…`),
 *   or its label with its `project`: numbers are per project, so a bare `CR-014` is refused.
 * memwise:audit:log           (ws, MwAuditQuery)                                  → MwAuditLog
 * memwise:audit:logExport     (ws, MwAuditQuery)                                  → MwAuditExport (JSON, signed)
 * memwise:audit:verify        (ws, { project } | { exportJson })                  → MwAuditVerifyResult
 * memwise:inspectors:list     (ws, { project })                                   → MwInspectorLink[]
 * memwise:inspectors:create   (ws, MwInspectorLinkInput)                          → MwInspectorLinkCreated
 * memwise:inspectors:revoke   (ws, { linkId })                                    → MwInspectorLink
 * memwise:inspectors:extend   (ws, { linkId, expiresAt })                         → MwInspectorLink
 * memwise:inspectors:questions(ws, { project?, linkId?, open? })                  → MwInspectorQuestion[]
 * memwise:inspectors:answer   (ws, { questionId, answer })                        → MwInspectorQuestion
 * memwise:tmf:index           (ws, { project, study?, zone? })                    → MwTmfIndex
 *
 * The inbox gains kinds `change-request` (a sign-off waiting) and `inspector-question`.
 * The inspector's own pages are served at `/v/<token>` (public routes, like the form app's `/f/`).
 */

// ---------------------------------------------------------------- change requests

export type MwChangeRequestStatus = 'open' | 'in_review' | 'published' | 'withdrawn'

/** The past cases a change request is tried on (default: the playbook's last 50 finished cases). */
export interface MwValidationSet {
  /** What the person called it ("42 CVs filed in September"). */
  label?: string
  caseIds?: string[]
  since?: string
  until?: string
  /** Case values that must match (`{ artifact: 'Investigator CV' }`). */
  where?: Record<string, string | number | boolean>
  limit?: number
}

export interface MwDiffSegment { kind: 'same' | 'added' | 'removed'; text: string }

export interface MwChangeWho { performer: string; role?: string; roleTitle?: string }

/** One step of the playbook as the change leaves it ("What changes", with strikeouts). */
export interface MwChangeStepRow {
  n: number
  stepId: string
  change: 'same' | 'added' | 'removed' | 'changed'
  title: MwDiffSegment[]
  who: MwChangeWho
  whoBefore?: MwChangeWho
  /** The AI checks (checkpoint rules), each kept, added or removed. */
  rules: MwDiffSegment[]
  instructionsChanged: boolean
  outcomesChanged: boolean
}

export interface MwChangeFileDiff {
  path: string
  kind: 'playbook' | 'step' | 'rules' | 'record-type' | 'example' | 'other'
  status: 'added' | 'removed' | 'modified'
  lines: { kind: 'added' | 'removed' | 'context'; text: string }[]
}

/** One past case on the draft: would the AI checks alone have done what the person did? */
export interface MwValidationCaseResult {
  caseId: string
  title: string
  finishedAt?: string
  decided: { stepId: string; outcome: string; by?: string; comment?: string }
  accepted: boolean
  ai: 'pass' | 'fail' | 'error'
  matches: boolean
  failedRules?: { rule: string; reason?: string }[]
  error?: string
}

export interface MwChangeValidation {
  id: string
  draftHash: string
  /** It ran on the draft as it is now. */
  current: boolean
  setLabel: string
  total: number
  passed: number
  checkErrors: number
  status: 'passed' | 'failed'
  results: MwValidationCaseResult[]
  by?: string
  byName?: string
  at: string
}

export interface MwChangeSignoff {
  role: 'raiser' | 'qa'
  roleId?: string
  roleTitle?: string
  person?: { id: string; name: string }
  status: 'signed' | 'waiting' | 'not-yet'
  signedAt?: string
  /** The signature's meaning (English, stored with it). */
  meaning: string
  signatureId?: string
}

export interface MwChangeRequestSummary {
  id: string
  number: number
  /** `CR-014`. */
  label: string
  project: string
  workflowId: string
  playbookTitle: string
  title: string
  status: MwChangeRequestStatus
  raisedBy: { id: string; name: string }
  raisedAt: string
  updatedAt: string
  validation?: { passed: number; total: number; status: 'passed' | 'failed'; current: boolean }
}

export interface MwChangeRequest extends MwChangeRequestSummary {
  draftId: string
  draftHash: string
  reason: string
  regulated: boolean
  liveVersion?: number
  nextVersion?: number
  toVersion?: number
  /** Cases still running on the live version (they finish on it). */
  openCasesOnLive: number
  steps: MwChangeStepRow[]
  files: MwChangeFileDiff[]
  checks: { errors: number; warnings: number; messages: string[] }
  validationSet: MwValidationSet
  validations: MwChangeValidation[]
  signoffs: MwChangeSignoff[]
  /** The chat that edits it (memwise:changes:chat opens one). */
  sessionId?: string
  closedAt?: string
  closedBy?: { id: string; name: string }
  can: { edit: boolean; validate: boolean; send: boolean; approve: boolean; withdraw: boolean }
}

export interface MwOpenChangeInput {
  workflowId: string
  title?: string
  reason?: string
  /** An open change draft of the playbook to make the request of. */
  draftId?: string
  /** What the person asked for in chat: the request's chat starts with it. */
  request?: string
  /**
   * The request's number when the project's change log continues a paper one ("the paper log
   * ended at CR-013": 14). Used only when it is above every number the project has used.
   */
  number?: number
  validationSet?: MwValidationSet
}

export interface MwOpenChangeResult { changeRequest: MwChangeRequest; sessionId?: string }

export interface MwChangeSignResult {
  applied: boolean
  /** `applied`, or why not: `signature-failed`, `locked`, `password-not-set`, `not-validated`, `stale`, `no-reason`, `not-your-turn`, `forbidden`, `conflict`, `failed`. */
  status: string
  message?: string
  /** `locked`: when signing opens again (ISO). */
  retryAfter?: string
  changeRequest?: MwChangeRequest
  published?: { workflowId: string; version: number; hash: string }
}

// ---------------------------------------------------------------- the audit log

export type MwAuditActorKind = 'person' | 'ai' | 'system' | 'external' | 'inspector' | 'source'

/**
 * One entry of a project's trail. `action`: record.created | record.changed | signature.signed |
 * step.completed | step.needs_person | step.failed | change.opened | change.validated |
 * change.published | change.withdrawn | inspector.link_created | inspector.opened | inspector.listed |
 * inspector.viewed | inspector.downloaded | inspector.asked | inspector.answered | audit.exported …
 * `data` holds the facts the screens word (version, changed fields, reason, meaning, step,
 * outcome, model, quote, rationale …).
 */
export interface MwAuditEntry {
  seq: number
  id: string
  project: string
  at: string
  actorKind: MwAuditActorKind
  actor: string
  actorLabel: string | null
  action: string
  entity: string | null
  recordId: string | null
  caseId: string | null
  data: Record<string, unknown>
  prevHash: string
  hash: string
  recordTitle?: string
  stepTitle?: string
  playbookTitle?: string
}

export interface MwAuditQuery {
  project: string
  entity?: string
  recordId?: string
  caseId?: string
  actorKinds?: MwAuditActorKind[]
  actions?: string[]
  afterSeq?: number
  limit?: number
}

export interface MwAuditLog { entries: MwAuditEntry[]; chain: { ok: boolean; message?: string } }

export interface MwAuditVerifyResult {
  ok: boolean
  entries: number
  chain: { ok: boolean; brokenAt?: { seq: number; id: string; reason: 'hash' | 'link' }; message?: string }
  signature?: { ok: boolean; publicKey: string; trusted?: boolean }
  /** In English; the screens word `ok`, `chain` and `signature` themselves. */
  message: string
}

// ---------------------------------------------------------------- inspectors

export interface MwInspectorPerson { name: string; email?: string; organisation?: string }

export interface MwInspectorLink {
  id: string
  project: string
  name: string
  inspectors: MwInspectorPerson[]
  expiresAt: string
  createdBy: { id: string; name: string }
  createdAt: string
  revokedAt?: string
  firstOpenedAt?: string
  lastOpenedAt?: string
  status: 'active' | 'expired' | 'revoked'
  views: number
  downloads: number
  questions: { open: number; answered: number }
}

export interface MwInspectorLinkInput { project: string; name: string; inspectors: MwInspectorPerson[]; expiresAt: string }

/** The token is shown once; `url` when the workspace has a public address. */
export interface MwInspectorLinkCreated { link: MwInspectorLink; token: string; url?: string }

export interface MwInspectorQuestion {
  id: string
  linkId: string
  linkName: string
  project: string
  askedBy?: string
  record?: { entity: string; id: string; title: string }
  question: string
  askedAt: string
  answer?: string
  answeredBy?: { id: string; name: string }
  answeredAt?: string
}

// ---------------------------------------------------------------- the TMF index

export interface MwTmfZoneRow {
  /** `05`. */
  number: string
  /** `site-management`: the screens translate the zone's name by id. */
  id: string
  /** The Reference Model's English name. */
  name: string
  expected: number
  filed: number
  missing: number
  inQc: number
  filedLate: number
}

export interface MwTmfSiteRow { siteId: string; label: string; expected: number; filed: number; missing: number; inQc: number }

export interface MwTmfIndex {
  project: string
  study?: { id: string; label: string }
  kpis: { expected: number; filed: number; missing: number; inQc: number; oldestInQcDays: number | null; filedLate: number; lateAfterDays: number }
  zones: MwTmfZoneRow[]
  zone?: {
    row: MwTmfZoneRow
    sites: MwTmfSiteRow[]
    documents: { entity: string; id: string; title: string; artifact?: string; site?: string; status: string; filedLate: boolean; inQcDays?: number }[]
    missing: { id: string; artifact: string; site?: string; dueDate?: string }[]
  }
  unplaced: string[]
}

// ---------------------------------------------------------------- the inspector's pages (public, /v/<token>/api/…)

export interface MwInspectorSession { linkId: string; project: string; projectName: string; name: string; inspector: string; expiresAt: string }

export interface MwInspectorDocument {
  entity: string
  id: string
  title: string
  zone?: string
  site?: { id: string; label: string }
  artifact?: string
  status: string
  version: number
  filedAt?: string
  signatures: { name: string; meaning: string; at: string; changedSince: boolean }[]
  file?: { id: string; name: string; mime: string; size: number; sha256: string }
  values: { field: string; label: string; value: string }[]
}

export interface MwInspectorIndex {
  session: MwInspectorSession
  zones: { id: string; number: string; name: string; filed: number }[]
  sites: { id: string; label: string }[]
}

/** Why an inspector link opens nothing. */
export interface MwInspectorRefusal { refused: 'unknown' | 'expired' | 'revoked' }
