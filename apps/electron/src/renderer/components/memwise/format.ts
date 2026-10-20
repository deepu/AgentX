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
} from '@memwise/shared/protocol'

// ---------------------------------------------------------------- words

const ACRONYMS = new Set(['gst', 'gstin', 'pan', 'crm', 'id', 'ifsc', 'vat', 'tds', 'kyc', 'pdf', 'url', 'api'])

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
  return humanize(last)
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
}

export function outcomeLabel(outcome: string, t: TFunction): string {
  const key = OUTCOME_KEYS[outcome]
  return key ? t(key) : humanize(outcome)
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

export type ProvenanceTone = 'person' | 'tool' | 'judgement' | 'input' | 'system' | 'tainted' | 'hidden'

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
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: v.currency, maximumFractionDigits: 2 }).format(v.amount)
  } catch {
    return `${v.amount} ${v.currency}`
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
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

/** The step (or state) an inbox item is about, for its row. */
export function inboxItemStepTitle(item: MwInboxItem): string {
  return item.kind === 'attention' ? humanize(item.state) : item.stepTitle
}

export function inboxKindLabel(kind: MwInboxItem['kind'], t: TFunction): string {
  switch (kind) {
    case 'input': return t('memwise.inbox.kind.input')
    case 'decision': return t('memwise.inbox.kind.decision')
    case 'approval': return t('memwise.inbox.kind.approval')
    case 'attention': return t('memwise.inbox.kind.attention')
    case 'reminder': return t('memwise.inbox.kind.reminder')
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
