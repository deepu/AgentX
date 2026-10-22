/**
 * The words of an inspector's view (Stage 5, docs/memwise/26-projects-and-pages.md §8): an audit
 * trail entry as "who" and "what", dates, sizes. Pure, so it is tested without a page.
 */

import type { InspectorPageDocument, InspectorTrailEntry } from '@memwise/defs/external'
import { S } from './strings'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** `6 Oct 2026, 10:42` in the reader's own time zone. */
export function formatWhen(iso: string, opts: { time?: boolean; year?: boolean } = {}): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', ...(opts.year === false ? {} : { year: 'numeric' }),
    ...(opts.time === false ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Who made a trail entry: a person's name, "AI check · <model>", the system. */
export function trailWho(e: InspectorTrailEntry): { text: string; ai: boolean } {
  if (e.actorKind === 'ai') return { text: S.inspAiCheck(str(e.data.model)), ai: true }
  if (e.actorKind === 'system') return { text: S.inspSystem, ai: false }
  return { text: e.actorLabel ?? e.actor, ai: false }
}

const words = (id: string) => id.replace(/[_-]+/g, ' ')

/** What a trail entry says happened, in a line; AI entries quote the words they relied on. */
export function trailWhat(e: InspectorTrailEntry): string {
  const d = e.data
  const version = num(d.version) ?? 0
  switch (e.action) {
    case 'record.created': {
      const reason = str(d.reason)
      return [S.inspCreated(version), reason ? S.inspReason(reason) : ''].filter(Boolean).join(' · ')
    }
    case 'record.changed': {
      const changed = Array.isArray(d.changed) ? d.changed.filter((x): x is string => typeof x === 'string').map(words).join(', ') : ''
      const reason = str(d.reason)
      return [S.inspChanged(version, changed), reason ? S.inspReason(reason) : ''].filter(Boolean).join(' · ')
    }
    case 'signature.signed':
      return S.inspSigned(str(d.meaning) ?? '')
    case 'step.completed':
    case 'step.needs_person':
    case 'step.failed': {
      const step = e.stepTitle ?? (str(d.step) ? words(str(d.step)!) : '')
      const outcome = str(d.outcome)
      const head = e.action === 'step.needs_person' ? S.inspStepPerson(step)
        : e.action === 'step.failed' ? S.inspStepFailed(step)
          : S.inspStep(step, outcome ? words(outcome) : '')
      const quote = str(d.quote)
      return quote ? `${head} · ${S.inspQuoted(quote)}` : head
    }
    default:
      return words(e.action.replace('.', ' '))
  }
}

/** The document's most recent signature, for its list row and its signature block. */
export function lastSignature(doc: InspectorPageDocument): InspectorPageDocument['signatures'][number] | undefined {
  return [...doc.signatures].sort((a, b) => b.at.localeCompare(a.at))[0]
}

/** The list row's second line: `Site 101 · v2 · signed 6 Oct`. */
export function documentLine(doc: InspectorPageDocument): string {
  const sig = lastSignature(doc)
  return [
    doc.site ? S.inspSite(doc.site.label) : undefined,
    S.inspVersion(doc.version),
    sig ? S.inspSignedOn(formatWhen(sig.at, { time: false, year: false })) : undefined,
  ].filter(Boolean).join(' · ')
}
