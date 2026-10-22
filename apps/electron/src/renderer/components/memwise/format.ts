/**
 * Pure display helpers for the MemWise screens: provenance badges, values, times, labels.
 * No React, no window access, so they run in bun tests as they are.
 */

import type { TFunction } from 'i18next'
import type {
  MwCaseSummary,
  MwCaseValue,
  MwDocument,
  MwInboxItem,
  MwPerson,
  MwRole,
  MwRunStatus,
  MwStepRunSummary,
  MwSubmitResult,
} from '@memwise/shared/protocol'

// ---------------------------------------------------------------- words

const ACRONYMS = new Set(['gst', 'gstin', 'pan', 'crm', 'id', 'ifsc', 'vat', 'tds', 'kyc', 'pdf', 'url', 'api', 'qc', 'cv', 'tmf', 'cra', 'irb', 'edc', 'brsr', 'sso', 'mfa', 'pmid', 'pmc', 'doi', 'ci', 'ai'])

/** `client_name` → "Client name", `gst.validate_gstin` → "GST validate GSTIN". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()))
  if (words.length === 0) return name
  const first = words[0]!
  words[0] = first === first.toUpperCase() ? first : first.charAt(0).toUpperCase() + first.slice(1)
  return words.join(' ')
}

/** A tool name in plain words: the last part names the action (`intake.extract_fields` → "Extract fields"). */
export function toolLabel(tool: string): string {
  const parts = tool.split('.')
  const last = parts[parts.length - 1] ?? tool
  // Record tools name the record too: `domain.customer.create` → "Create customer".
  if (parts.length === 3 && parts[0] === 'domain') return humanize(`${last} ${parts[1]}`)
  // A bare verb says little alone: `email.send` → "Send email".
  if (parts.length === 2 && !/[_-]/.test(last)) return humanize(`${last} ${parts[0]}`)
  return humanize(last)
}

/**
 * A step's automatic check in plain words. The engine names them for developers
 * (`writes.gstin_ok: from tool gst.validate_gstin (valid)`); rules a playbook author wrote
 * are shown as written.
 */
export function checkLabel(rule: string, t: TFunction): string {
  if (rule === 'outcome is declared') return t('memwise.step.check.outcome')
  if (rule === 'required tools called') return t('memwise.step.check.requiredTools')
  const m = /^writes\.([\w-]+): (.+)$/.exec(rule)
  if (!m) return rule
  const field = humanize(m[1]!)
  const rest = m[2]!
  if (rest === 'declared') return t('memwise.step.check.writeDeclared', { field })
  if (rest === 'required') return t('memwise.step.check.writeRequired', { field })
  const tool = /^from tool (\S+)/.exec(rest)
  if (tool) return t('memwise.step.check.writeFromTool', { field, tool: toolLabel(tool[1]!) })
  return t('memwise.step.check.writeType', { field })
}

/** Outcomes with a fixed wording; others are humanized. */
const OUTCOME_KEYS: Record<string, string> = {
  submitted: 'memwise.form.outcome.submit',
  submit: 'memwise.form.outcome.submit',
  approved: 'memwise.form.outcome.approve',
  approve: 'memwise.form.outcome.approve',
  sent_back: 'memwise.form.outcome.sendBack',
  send_back: 'memwise.form.outcome.sendBack',
  rejected: 'memwise.form.outcome.reject',
  reject: 'memwise.form.outcome.reject',
  resolved: 'memwise.form.outcome.resolved',
  done: 'memwise.form.outcome.done',
  changes_requested: 'memwise.form.outcome.askForChanges',
}

export function outcomeLabel(outcome: string, t: TFunction): string {
  const key = OUTCOME_KEYS[outcome]
  return key ? t(key) : humanize(outcome)
}

/** An outcome that already happened, for records: "Submitted", "Sent back" (not the button's "Submit"). */
export function recordedOutcomeLabel(outcome: string): string {
  return humanize(outcome)
}

/** Outcomes that return work to someone need a comment saying what to change. */
export function outcomeNeedsComment(outcome: string): boolean {
  return /(^|_)(back|reject|rejected|decline|declined|return|returned|needs_info|changes)(_|$)/.test(outcome)
}

/** The outcome that moves the case forward is drawn as the primary button. */
export function isNegativeOutcome(outcome: string): boolean {
  return outcomeNeedsComment(outcome) || /(^|_)(fail|failed|cancel|cancelled)(_|$)/.test(outcome)
}

// ---------------------------------------------------------------- people

export type PeopleById = Record<string, MwPerson>

export function peopleById(people: MwPerson[] | null | undefined): PeopleById {
  const out: PeopleById = {}
  for (const p of people ?? []) out[p.id] = p
  return out
}

export function personName(id: string | undefined, people: PeopleById): string | undefined {
  if (!id) return undefined
  return people[id]?.name ?? id
}

export function roleTitle(role: string | undefined, roles?: MwRole[] | null): string | undefined {
  if (!role) return undefined
  return roles?.find(r => r.id === role)?.title ?? humanize(role)
}

// ---------------------------------------------------------------- provenance

export type ProvenanceTone = 'person' | 'tool' | 'judgement' | 'input' | 'system' | 'tainted' | 'hidden' | 'external'

export interface ProvenanceBadgeInfo {
  tone: ProvenanceTone
  text: string
  /** Longer explanation for a tooltip. */
  detail?: string
}

/** What a case value's badge says: who or what set it, in plain words. */
export function provenanceBadge(value: MwCaseValue, t: TFunction, people: PeopleById = {}): ProvenanceBadgeInfo {
  if (value.hidden) {
    return { tone: 'hidden', text: t('memwise.case.provenance.hidden'), detail: t('memwise.case.provenance.hiddenDetail') }
  }
  const p = value.provenance
  // Phase 5: typed by the client through a link (untrusted, so it says who rather than "a document")
  if (p.kind === 'external') {
    return { tone: 'external', text: t('memwise.case.provenance.external'), detail: t('memwise.case.provenance.externalDetail', { name: p.by }) }
  }
  // Phase 5: read from a document in a form and kept: which document, and how sure the reader was
  if (p.kind === 'tool' && p.document) {
    const confidence = typeof p.confidence === 'number' ? Math.round(p.confidence * 100) : undefined
    const kept = keptBy(p.confirmedBy, t, people)
    return {
      tone: 'tainted',
      text: confidence === undefined
        ? t('memwise.case.provenance.toolDocument', { document: p.document })
        : t('memwise.case.provenance.toolDocumentConfidence', { document: p.document, confidence }),
      detail: [
        t('memwise.case.provenance.toolDocumentDetail', { tool: toolLabel(p.tool), document: p.document }),
        kept ? t('memwise.case.provenance.keptBy', { name: kept }) : undefined,
      ].filter(Boolean).join(' '),
    }
  }
  if (value.tainted) {
    return {
      tone: 'tainted',
      text: t('memwise.case.provenance.tainted'),
      detail: t('memwise.case.provenance.taintedDetail'),
    }
  }
  switch (p.kind) {
    case 'person':
      return { tone: 'person', text: t('memwise.case.provenance.person', { name: personName(p.by, people) }) }
    case 'tool':
      return { tone: 'tool', text: t('memwise.case.provenance.tool', { tool: toolLabel(p.tool) }), detail: p.tool }
    case 'judgement':
      return { tone: 'judgement', text: t('memwise.case.provenance.judgement'), detail: p.rationale }
    case 'input':
      return {
        tone: 'input',
        text: t('memwise.case.provenance.input'),
        detail: p.by ? t('memwise.case.provenance.inputBy', { name: personName(p.by, people) }) : undefined,
      }
    case 'system':
      return { tone: 'system', text: t('memwise.case.provenance.system'), detail: p.note }
  }
}

/** Who kept a value read from a document: the client (`external:<linkId>`) or a person. */
function keptBy(confirmedBy: string | undefined, t: TFunction, people: PeopleById): string | undefined {
  if (!confirmedBy) return undefined
  if (confirmedBy.startsWith('external:')) return t('memwise.case.provenance.theClient')
  return personName(confirmedBy, people)
}

// ---------------------------------------------------------------- values

export function isMoney(v: unknown): v is { amount: number; currency: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as { amount?: unknown }).amount === 'number'
    && typeof (v as { currency?: unknown }).currency === 'string'
}

export function isDocumentValue(v: unknown): v is Pick<MwDocument, 'name'> & Partial<MwDocument> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as { name?: unknown }).name === 'string'
    && ('mime' in v || 'sha256' in v || 'kind' in v || Object.keys(v).length === 1)
}

export function formatMoney(v: { amount: number; currency: string }, locale?: string): string {
  // Rupees read in lakhs and crores (₹4,20,00,000) for English readers; whole amounts without paise.
  const loc = v.currency === 'INR' && (!locale || /^en(-|$)/.test(locale)) ? 'en-IN' : locale
  try {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: v.currency, minimumFractionDigits: Number.isInteger(v.amount) ? 0 : 2, maximumFractionDigits: 2 }).format(v.amount)
  } catch {
    return `${v.amount} ${v.currency}`
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** A field that holds a calendar year (`year`, `publication_year`): shown as 2025, never 2,025. */
export function isYearField(name: string | undefined): boolean {
  return !!name && /(^|_)year$/i.test(name)
}

/** A table cell: like formatValueInline, but a year column reads as a year. */
export function formatCell(column: string, v: unknown, t: TFunction, locale?: string): string {
  if (typeof v === 'number' && Number.isInteger(v) && isYearField(column)) return String(v)
  return formatValueInline(v, t, locale)
}

/** A one-line rendering of any case value (lists and records are summarised). */
export function formatValueInline(v: unknown, t: TFunction, locale?: string): string {
  if (v === null || v === undefined || v === '') return t('memwise.case.noValue')
  if (typeof v === 'boolean') return v ? t('memwise.form.yes') : t('memwise.form.no')
  if (typeof v === 'number') return new Intl.NumberFormat(locale).format(v)
  if (typeof v === 'string') return v
  if (isMoney(v)) return formatMoney(v, locale)
  if (isDocumentValue(v)) return v.name
  if (Array.isArray(v)) {
    if (v.length === 0) return t('memwise.case.noValue')
    if (v.every(x => typeof x !== 'object' || x === null || isDocumentValue(x) || isMoney(x))) {
      return v.map(x => formatValueInline(x, t, locale)).join(', ')
    }
    return t('memwise.case.itemCount', { count: v.length })
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${humanize(k)}: ${formatValueInline(x, t, locale)}`)
      .join(' · ')
  }
  return String(v)
}

// ---------------------------------------------------------------- time

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
]

/** "3 days ago", "in 2 hours", "now", localized by Intl. */
export function relativeTime(iso: string | undefined, now: number = Date.now(), locale?: string): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = at - now
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(0, 'minute')
}

export function absoluteTime(iso: string | undefined, locale?: string): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

/** A calendar date ("Oct 21, 2026"), for times that were set in a file rather than just now. */
export function absoluteDate(iso: string | undefined, locale?: string): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)
}

/**
 * A content hash, short: the first 16 hex characters and an ellipsis, so a prefix that happens to
 * be all digits still reads as part of a hash, not as a number.
 */
export function shortHash(hash: string | undefined): string {
  if (!hash) return ''
  const hex = hash.replace(/^sha256:/i, '').toLowerCase()
  return hex.length > 16 ? `${hex.slice(0, 16)}…` : hex
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s % 60)} s`
}

// ---------------------------------------------------------------- inbox

/** Newest first; ties keep a stable order by id. */
export function sortInbox(items: MwInboxItem[]): MwInboxItem[] {
  return [...items].sort((a, b) => {
    const d = Date.parse(b.since) - Date.parse(a.since)
    if (d !== 0 && !Number.isNaN(d)) return d
    return a.id.localeCompare(b.id)
  })
}

/**
 * A state's name for people: the built-in end and "needs a person" states in the reader's
 * language, any other by the title the server sent (its step's title), else its id in words.
 */
export function stateLabel(stateId: string, t?: TFunction, title?: string): string {
  if (t && stateId === 'end') return t('memwise.playbook.endTitle')
  if (t && stateId === 'needs_person') return t('memwise.playbook.needsPerson')
  return title ?? humanize(stateId)
}

/** The step (or state) an inbox item is about, for its row. */
export function inboxItemStepTitle(item: MwInboxItem, t?: TFunction): string {
  if (item.kind === 'attention') return stateLabel(item.state, t)
  if (item.kind === 'conversation' && t) return conversationTitle(item, t)
  if (item.kind === 'identity' && t) return t('memwise.inbox.identity.stepTitle', { entity: humanize(item.entity).toLowerCase() })
  // Stage 5: a sign-off reads as what to do; a question as where it came from.
  if (item.kind === 'change-request' && t) {
    return item.signoff === 'qa'
      ? t('memwise.regulated.inbox.title.qa', { label: item.changeRequest.label })
      : t('memwise.regulated.inbox.title.raiser', { label: item.changeRequest.label })
  }
  if (item.kind === 'inspector-question' && t) return t('memwise.regulated.inbox.title.question', { name: item.stepTitle })
  return item.stepTitle
}

/** A conversation item reads as what the chat is for: building or changing a playbook. */
export function conversationTitle(item: Pick<Extract<MwInboxItem, { kind: 'conversation' }>, 'workflowId' | 'stepTitle'>, t: TFunction): string {
  if (item.workflowId === 'create-playbook') return t('memwise.inbox.conversation.build')
  if (item.workflowId === 'change-playbook') return t('memwise.inbox.conversation.change')
  return item.stepTitle
}

export function inboxKindLabel(kind: MwInboxItem['kind'], t: TFunction): string {
  switch (kind) {
    case 'input': return t('memwise.inbox.kind.input')
    case 'decision': return t('memwise.inbox.kind.decision')
    case 'approval': return t('memwise.inbox.kind.approval')
    case 'attention': return t('memwise.inbox.kind.attention')
    case 'reminder': return t('memwise.inbox.kind.reminder')
    case 'conversation': return t('memwise.inbox.kind.conversation')
    case 'identity': return t('memwise.inbox.kind.identity')
    case 'flag': return t('memwise.inbox.kind.flag')
    case 'trigger-hold': return t('memwise.inbox.kind.triggerHold')
    case 'change-request': return t('memwise.inbox.kind.changeRequest')
    case 'inspector-question': return t('memwise.inbox.kind.inspectorQuestion')
  }
}

// ---------------------------------------------------------------- cases

export function caseStatusLabel(status: MwRunStatus, t: TFunction): string {
  switch (status) {
    case 'active': return t('memwise.cases.status.active')
    case 'done': return t('memwise.cases.status.done')
    case 'stopped': return t('memwise.cases.status.stopped')
  }
}

export function waitingOnLabel(c: Pick<MwCaseSummary, 'waitingOn' | 'status'>, t: TFunction, roles?: MwRole[] | null): string | undefined {
  if (c.status !== 'active' || !c.waitingOn) return undefined
  switch (c.waitingOn.kind) {
    case 'role': return t('memwise.cases.waitingOnRole', { role: roleTitle(c.waitingOn.role, roles) ?? '' })
    case 'agent': return t('memwise.cases.waitingOnAgent')
    case 'system': return t('memwise.cases.waitingOnSystem')
    case 'condition': return t('memwise.cases.waitingOnCondition')
  }
}

export function stepStatusLabel(status: MwStepRunSummary['status'], t: TFunction): string {
  switch (status) {
    case 'running': return t('memwise.step.status.running')
    case 'waiting': return t('memwise.step.status.waiting')
    case 'completed': return t('memwise.step.status.completed')
    case 'needs_person': return t('memwise.step.status.needsPerson')
    case 'failed': return t('memwise.step.status.failed')
  }
}

export interface CaseFilter {
  workflowId?: string
  status?: MwRunStatus
}

export function filterCases(cases: MwCaseSummary[], filter: CaseFilter): MwCaseSummary[] {
  return cases
    .filter(c => (!filter.workflowId || c.workflowId === filter.workflowId) && (!filter.status || c.status === filter.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/** A refusal in the reader's language when its code is known; the server's English otherwise. */
export function resultMessage(result: Pick<MwSubmitResult, 'code' | 'message'>, t: TFunction): string | undefined {
  if (result.code) return t(`memwise.result.${result.code}`, { defaultValue: result.message ?? '' }) || result.message
  return result.message
}

/** Why a case needs someone, worded here when the server says which kind of reason it is. */
export function attentionReason(item: Extract<MwInboxItem, { kind: 'attention' }>, t: TFunction): string {
  if (item.reasonCode === 'stopped') {
    return item.stopReason ? t('memwise.inbox.attention.stoppedBecause', { reason: item.stopReason }) : t('memwise.inbox.attention.stopped')
  }
  if (item.reasonCode === 'waiting') return t('memwise.inbox.attention.waiting', { state: stateLabel(item.state, t) })
  return item.reason
}
