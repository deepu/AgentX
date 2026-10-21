/**
 * Pure display helpers for the regulated-project screens (Stage 5, docs/memwise/26-projects-and-pages.md
 * §7, §8): an audit entry as "who" and "what", a change request's state and sign-offs in words, the
 * TMF zones' names. No React, no window, so they run in bun tests as they are.
 */

import type { TFunction } from 'i18next'
import type {
  MwAuditEntry, MwAuditVerifyResult, MwChangeRequest, MwChangeRequestStatus, MwChangeSignResult, MwChangeSignoff, MwChangeStepRow,
  MwChangeValidation, MwDiffSegment, MwInspectorLink, MwSubmitResult, MwTmfZoneRow,
} from '@memwise/shared/protocol'
import { humanize } from '../format'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// ---------------------------------------------------------------- change requests

export function changeStatusLabel(status: MwChangeRequestStatus, t: TFunction): string {
  switch (status) {
    case 'open': return t('memwise.regulated.change.status.open')
    case 'in_review': return t('memwise.regulated.change.status.inReview')
    case 'published': return t('memwise.regulated.change.status.published')
    case 'withdrawn': return t('memwise.regulated.change.status.withdrawn')
  }
}

export function changeStatusColor(status: MwChangeRequestStatus): 'default' | 'warning' | 'success' | 'muted' {
  return status === 'in_review' ? 'warning' : status === 'published' ? 'success' : status === 'withdrawn' ? 'muted' : 'default'
}

/** The plain text of diff segments (what the step says after the change, or before). */
export function segmentsText(segments: MwDiffSegment[], side: 'after' | 'before' = 'after'): string {
  return segments.filter(s => s.kind === 'same' || s.kind === (side === 'after' ? 'added' : 'removed')).map(s => s.text).join('').trim()
}

/** The title of a step of the change, as it will read (or, `before`, as it reads now). */
export function stepTitle(cr: Pick<MwChangeRequest, 'steps'>, stepId: string, side: 'after' | 'before' = 'after'): string {
  const row = cr.steps.find(s => s.stepId === stepId)
  return (row && (segmentsText(row.title, side) || segmentsText(row.title))) || humanize(stepId)
}

/** Who does a step: "Agent", or the role's title. */
export function whoLabel(who: MwChangeStepRow['who'], t: TFunction): string {
  if (who.performer === 'agent') return t('memwise.regulated.change.who.agent')
  if (who.performer === 'system') return t('memwise.regulated.change.who.system')
  if (who.performer === 'external') return t('memwise.regulated.change.who.external')
  return who.roleTitle ?? (who.role ? humanize(who.role) : t('memwise.regulated.change.who.person'))
}

/** "41 of 42 match QC". */
export function validationResult(v: Pick<MwChangeValidation, 'passed' | 'total' | 'checkErrors' | 'results'>, cr: Pick<MwChangeRequest, 'steps'>, t: TFunction): string {
  if (v.checkErrors > 0) return t('memwise.regulated.change.validation.checkErrors', { count: v.checkErrors })
  if (v.total === 0) return t('memwise.regulated.change.validation.noCases')
  const step = v.results[0]?.decided.stepId
  return step
    // The cases were decided at the step as it reads now ("41 of 42 match QC by the TMF lead").
    ? t('memwise.regulated.change.validation.match', { passed: v.passed, total: v.total, step: stepTitle(cr, step, 'before') })
    : t('memwise.regulated.change.validation.matchPlain', { passed: v.passed, total: v.total })
}

/** The row label of the nth validation run: "First run", "Second run, …". */
export function validationRunLabel(n: number, t: TFunction): string {
  if (n === 1) return t('memwise.regulated.change.validation.firstRun')
  if (n === 2) return t('memwise.regulated.change.validation.secondRun')
  if (n === 3) return t('memwise.regulated.change.validation.thirdRun')
  return t('memwise.regulated.change.validation.nthRun', { n })
}

export function signoffRoleLabel(s: MwChangeSignoff, t: TFunction): string {
  // The person who raised it is named by their role's title, if any ("study manager").
  if (s.role === 'raiser') return s.roleTitle ?? ''
  return s.roleTitle ?? t('memwise.regulated.change.signoff.qa')
}

/**
 * A change request's sign result as the signing form reads results: `submit.<code>` for the codes
 * it knows (a wrong password, a lock, no password yet), the change's own codes otherwise.
 */
export function signResultForForm(r: MwChangeSignResult): MwSubmitResult {
  const known = ['signature-failed', 'locked', 'password-not-set', 'signature-required']
  return {
    applied: r.applied,
    ...(r.applied ? {} : { code: known.includes(r.status) ? `submit.${r.status}` : `change.${r.status}` }),
    ...(r.message ? { message: r.message } : {}),
    ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}),
  }
}

// ---------------------------------------------------------------- the audit trail

/** Who made an entry: a person's name, "AI check · <model>", the system, an inspector. */
export function auditWho(e: MwAuditEntry, t: TFunction): { text: string; ai: boolean } {
  if (e.actorKind === 'ai') {
    const model = str(e.data.model)
    return { text: model ? t('memwise.regulated.audit.aiCheckModel', { model }) : t('memwise.regulated.audit.aiCheck'), ai: true }
  }
  if (e.actorKind === 'system') return { text: t('memwise.regulated.audit.system'), ai: false }
  if (e.actorKind === 'inspector') return { text: e.actorLabel ?? t('memwise.regulated.audit.inspector'), ai: false }
  return { text: e.actorLabel ?? e.actor, ai: false }
}

const fieldList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(f => humanize(f).toLowerCase()).join(', ') : '')

/**
 * What an entry says happened, in a line. AI entries quote the sentence they relied on; a
 * person's step names its outcome and reason.
 */
export function auditWhat(e: MwAuditEntry, t: TFunction): string {
  const d = e.data
  const version = num(d.version)
  const reason = str(d.reason) ?? str(d.rationale)
  const withReason = (s: string) => (reason ? t('memwise.regulated.audit.withReason', { text: s, reason }) : s)
  const step = e.stepTitle ?? (str(d.step) ? humanize(str(d.step)!) : '')
  const quote = str(d.quote)
  const withQuote = (s: string) => (quote ? t('memwise.regulated.audit.withQuote', { text: s, quote }) : s)
  switch (e.action) {
    case 'record.created':
      return withReason(t('memwise.regulated.audit.action.created', { version: version ?? 1 }))
    case 'record.changed': {
      const fields = fieldList(d.changed)
      return withReason(fields
        ? t('memwise.regulated.audit.action.changedFields', { fields, version: version ?? '' })
        : t('memwise.regulated.audit.action.changed', { version: version ?? '' }))
    }
    case 'signature.signed':
      return t('memwise.regulated.audit.action.signed', { meaning: str(d.meaning) ?? '' })
    case 'step.completed': {
      const outcome = str(d.outcome) ? humanize(str(d.outcome)!).toLowerCase() : ''
      const failed = (d.checkpoint as { failed?: unknown } | undefined)?.failed
      if (e.actorKind === 'ai' && Array.isArray(failed) && failed.length) {
        return withQuote(t('memwise.regulated.audit.action.flagged', { step, rules: failed.filter(x => typeof x === 'string').join('; ') }))
      }
      if (e.actorKind === 'ai') return withQuote(t('memwise.regulated.audit.action.step', { step, outcome }))
      return withReason(t('memwise.regulated.audit.action.step', { step, outcome }))
    }
    case 'step.needs_person': return withQuote(t('memwise.regulated.audit.action.needsPerson', { step }))
    case 'step.failed': return t('memwise.regulated.audit.action.stepFailed', { step })
    case 'change.opened': return t('memwise.regulated.audit.action.changeOpened', { label: str(d.label) ?? '', title: str(d.title) ?? '' })
    case 'change.validated':
      return t('memwise.regulated.audit.action.changeValidated', { label: str(d.label) ?? '', passed: num(d.passed) ?? 0, total: num(d.total) ?? 0 })
    case 'change.published': return t('memwise.regulated.audit.action.changePublished', { label: str(d.label) ?? '', version: num(d.version) ?? '' })
    case 'change.withdrawn': return withReason(t('memwise.regulated.audit.action.changeWithdrawn', { label: str(d.label) ?? '' }))
    case 'inspector.link_created': return t('memwise.regulated.audit.action.linkCreated', { name: str(d.name) ?? '' })
    case 'inspector.link_revoked': return t('memwise.regulated.audit.action.linkRevoked', { name: str(d.name) ?? '' })
    case 'inspector.link_extended': return t('memwise.regulated.audit.action.linkExtended')
    case 'inspector.opened': return t('memwise.regulated.audit.action.inspectorOpened')
    case 'inspector.listed': return t('memwise.regulated.audit.action.inspectorListed')
    case 'inspector.viewed':
      return d.view === 'trail'
        ? t('memwise.regulated.audit.action.inspectorViewedTrail')
        : t('memwise.regulated.audit.action.inspectorViewed', { version: version ?? '' })
    case 'inspector.downloaded': return t('memwise.regulated.audit.action.inspectorDownloaded', { version: version ?? '' })
    case 'inspector.asked': return t('memwise.regulated.audit.action.inspectorAsked')
    case 'inspector.answered': return t('memwise.regulated.audit.action.inspectorAnswered')
    case 'audit.exported': return t('memwise.regulated.audit.action.exported', { count: num(d.entries) ?? 0 })
    default: return humanize(e.action)
  }
}

/** The verify result in a line. */
export function verifyMessage(r: MwAuditVerifyResult, t: TFunction): string {
  if (r.ok) return t('memwise.regulated.audit.verify.ok', { count: r.entries })
  if (r.chain.brokenAt) {
    return r.chain.brokenAt.reason === 'hash'
      ? t('memwise.regulated.audit.verify.changed', { seq: r.chain.brokenAt.seq })
      : t('memwise.regulated.audit.verify.missing', { seq: r.chain.brokenAt.seq })
  }
  if (r.signature && !r.signature.ok) return t('memwise.regulated.audit.verify.badSignature')
  return t('memwise.regulated.audit.verify.failed')
}

// ---------------------------------------------------------------- inspectors

export function inspectorStatusLabel(s: MwInspectorLink['status'], t: TFunction): string {
  switch (s) {
    case 'active': return t('memwise.regulated.inspectors.status.active')
    case 'expired': return t('memwise.regulated.inspectors.status.expired')
    case 'revoked': return t('memwise.regulated.inspectors.status.revoked')
  }
}

/** "Inspector, MHRA; Jane Doe" for the list row. */
export function inspectorNames(l: Pick<MwInspectorLink, 'inspectors'>): string {
  return l.inspectors.map(p => (p.organisation ? `${p.name}, ${p.organisation}` : p.name)).join('; ')
}

/** The end date the setup offers by default: two weeks from now, at 18:00 local time. */
export function defaultInspectorEnd(now: number = Date.now()): string {
  const d = new Date(now + 14 * 86_400_000)
  d.setHours(18, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------- the TMF index

/** A zone's name in the reader's language (the Reference Model's English name otherwise). */
export function zoneName(zone: Pick<MwTmfZoneRow, 'id' | 'name'>, t: TFunction): string {
  return t(`memwise.regulated.tmf.zone.${zone.id}`, { defaultValue: zone.name })
}

// ---------------------------------------------------------------- times

/** "29 Sep 11:02": a trail row's time, short, in the reader's locale. */
export function trailWhen(iso: string | undefined, locale?: string): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
}

/** The whole days between now and an ISO time (negative once it has passed). */
export function daysUntil(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : Math.ceil((at - now) / 86_400_000)
}

/** A `yyyy-mm-dd` end date as the ISO time the link ends: the end of that day, local time. */
export function endOfDayIso(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * The inspectors a person typed, one per line: "Name, Organisation" (the organisation optional, an
 * email anywhere on the line kept as the email).
 */
export function parseInspectors(text: string): { name: string; email?: string; organisation?: string }[] {
  const out: { name: string; email?: string; organisation?: string }[] = []
  for (const raw of text.split(/\n/)) {
    const line = raw.trim()
    if (!line) continue
    const email = /[^\s<>,;]+@[^\s<>,;]+\.[^\s<>,;]+/.exec(line)?.[0]
    const rest = (email ? line.replace(email, '') : line).replace(/[<>()]/g, ' ').split(',').map(s => s.trim()).filter(Boolean)
    const name = rest[0] ?? email
    if (!name) continue
    out.push({ name, ...(email ? { email } : {}), ...(rest[1] ? { organisation: rest.slice(1).join(', ') } : {}) })
  }
  return out
}
