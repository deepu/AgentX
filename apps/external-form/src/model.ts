/**
 * The form's working values and the pure rules around them: what each field starts with, how
 * typed text becomes the value the core accepts (`ExternalFormField.value` shapes), the checks
 * worth doing before a round trip (the core checks again), and how reading the documents turns
 * into pre-filled answers and offers. No React, no window: tested with `bun test`.
 */

import type { ExternalDocument, ExternalFormField, ExtractSuggestion } from '@memwise/defs/external'
import { S } from './strings'

export interface MoneyDraft { amount: string; currency: string }

/** What a field holds while it is being filled in. */
export type Draft = string | boolean | null | MoneyDraft | ExternalDocument[]

export type Drafts = Record<string, Draft>

export const DEFAULT_CURRENCY = 'INR'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const isDocument = (v: unknown): v is ExternalDocument =>
  isObject(v) && typeof v.id === 'string' && typeof v.name === 'string'

export const isFileField = (f: Pick<ExternalFormField, 'kind'>) => f.kind === 'document' || f.kind === 'documents'

// ---------------------------------------------------------------- numbers and money

/** The amount without a currency in front ("₹", "Rs.") and without group separators. */
function cleanAmount(text: string): string {
  return text.trim().replace(/^[^\d+-]*?(?=[+-]?\.?\d)/, '').replace(/[\s,  ']/g, '')
}

/**
 * A typed amount as a number: "4,20,000.50", "₹ 1 200", "1200" → 420000.5, 1200, 1200. Null when
 * it isn't one plain number (two dots, letters, empty).
 */
export function parseAmount(text: string): number | null {
  const s = cleanAmount(text)
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * An amount as people read it: digits grouped (lakhs and crores for rupees, thousands
 * otherwise), decimals kept as typed. Text that isn't a number is left alone.
 */
export function groupAmount(text: string, currency?: string): string {
  const n = parseAmount(text)
  if (n === null) return text
  const [, frac] = cleanAmount(text).split('.')
  const whole = Math.trunc(Math.abs(n))
  const grouped = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: 0 }).format(whole)
  const sign = n < 0 ? '-' : ''
  return frac !== undefined ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}

/** The currency sign shown before the amount box ("₹"), else the code. */
export function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en-IN', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find(p => p.type === 'currency')
    return part?.value ?? currency
  } catch {
    return currency
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / 1024 / 1024
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/** Identifiers as the core keeps them: no spaces, upper-cased when the field says so. */
export function normalizeIdentifier(text: string, upperCase = true): string {
  const s = text.replace(/\s+/g, '')
  return upperCase ? s.toUpperCase() : s
}

/** "10:42" in the reader's clock. */
export function clockTime(iso: string, locale?: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
}

export function longDate(iso: string, locale?: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(at)
}

/** A value read from a document, for one line ("AAACA1234A", "₹4,20,00,000", "Yes"). */
export function formatValue(value: unknown, field?: Pick<ExternalFormField, 'kind' | 'currency' | 'options'>): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? S.yes : S.no
  if (typeof value === 'number') {
    if (field?.kind === 'money') return formatMoney(value, field.currency ?? DEFAULT_CURRENCY)
    return new Intl.NumberFormat('en-IN').format(value)
  }
  if (typeof value === 'string') {
    const option = field?.options?.find(o => o.value === value)
    return option ? option.label : value
  }
  if (isObject(value) && typeof value.amount === 'number' && typeof value.currency === 'string') return formatMoney(value.amount, value.currency)
  if (isDocument(value)) return value.name
  if (Array.isArray(value)) return value.map(v => formatValue(v, field)).join(', ')
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------- starting values

/** A field's working value from a value in the core's shape (the case, a draft, a suggestion). */
export function toDraft(field: ExternalFormField, value: unknown): Draft {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null
    case 'money': {
      const currency = field.currency ?? (isObject(value) && typeof value.currency === 'string' ? value.currency : DEFAULT_CURRENCY)
      if (typeof value === 'number') return { amount: groupAmount(String(value), currency), currency }
      if (typeof value === 'string') return { amount: groupAmount(value, currency), currency }
      if (isObject(value)) {
        const amount = typeof value.amount === 'number' ? groupAmount(String(value.amount), currency) : typeof value.amount === 'string' ? value.amount : ''
        return { amount, currency }
      }
      return { amount: '', currency }
    }
    case 'document':
    case 'documents': {
      const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
      return list.filter(isDocument)
    }
    case 'number':
      return typeof value === 'number' ? groupAmount(String(value)) : typeof value === 'string' ? value : ''
    case 'identifier':
      return typeof value === 'string' ? (field.upperCase ? value.toUpperCase() : value) : value === null || value === undefined ? '' : String(value)
    default:
      return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
  }
}

export function initialDrafts(fields: ExternalFormField[]): Drafts {
  const out: Drafts = {}
  for (const f of fields) out[f.name] = toDraft(f, f.value)
  return out
}

export function isEmptyDraft(field: ExternalFormField, draft: Draft | undefined): boolean {
  if (draft === null || draft === undefined) return true
  if (typeof draft === 'string') return draft.trim() === ''
  if (typeof draft === 'boolean') return false
  if (Array.isArray(draft)) return draft.length === 0
  return field.kind === 'money' ? draft.amount.trim() === '' : false
}

// ---------------------------------------------------------------- checks

export interface Checked {
  /** The value in the core's shape (absent when empty or wrong). */
  value?: unknown
  empty: boolean
  error?: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[\d\s().-]{6,20}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function safeRegExp(source: string): RegExp | null {
  try {
    // The core's patterns are whole-value checks; anchor them when they aren't.
    return new RegExp(source.startsWith('^') ? source : `^(?:${source})$`)
  } catch {
    return null
  }
}

/** One field's value to send, whether it's empty, and what's wrong with it. */
export function checkField(field: ExternalFormField, draft: Draft | undefined): Checked {
  const empty = (): Checked => ({
    empty: true,
    error: field.required ? (isFileField(field) ? S.addAFile : field.kind === 'enum' || field.kind === 'boolean' ? S.pickOne : S.fillThis) : undefined,
  })
  if (isEmptyDraft(field, draft)) return empty()
  const bad = (error: string): Checked => ({ empty: false, error })

  switch (field.kind) {
    case 'boolean':
      return { empty: false, value: draft === true }
    case 'document':
      return { empty: false, value: (draft as ExternalDocument[])[0] }
    case 'documents':
      return { empty: false, value: draft as ExternalDocument[] }
    case 'money': {
      const m = draft as MoneyDraft
      const amount = parseAmount(m.amount)
      if (amount === null) return bad(S.badNumber)
      return { empty: false, value: { amount, currency: m.currency || field.currency || DEFAULT_CURRENCY } }
    }
    case 'number': {
      const n = parseAmount(String(draft))
      return n === null ? bad(S.badNumber) : { empty: false, value: n }
    }
    case 'enum': {
      const s = String(draft)
      if (field.options && !field.options.some(o => o.value === s)) return bad(S.pickOne)
      return { empty: false, value: s }
    }
    default: {
      const s = String(draft).trim()
      if (field.kind === 'email' && !EMAIL.test(s)) return bad(S.badEmail)
      if (field.kind === 'phone' && !PHONE.test(s)) return bad(S.badPhone)
      if (field.kind === 'date' && !DATE.test(s)) return bad(S.badDate)
      if (field.kind === 'identifier') {
        const value = normalizeIdentifier(s, field.upperCase ?? false)
        const re = field.pattern ? safeRegExp(field.pattern) : null
        if (re && !re.test(value)) return bad(S.badIdentifier(field.placeholder))
        return { empty: false, value }
      }
      if (field.kind === 'phone') return { empty: false, value: s.replace(/[\s().-]/g, '') }
      return { empty: false, value: s }
    }
  }
}

export interface Submission {
  values: Record<string, unknown>
  errors: Record<string, string>
  valid: boolean
}

/** The values to submit, and every field's problem. Empty optional fields are left out. */
export function buildSubmission(fields: ExternalFormField[], drafts: Drafts): Submission {
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const c = checkField(f, drafts[f.name])
    if (c.error) errors[f.name] = c.error
    else if (!c.empty) values[f.name] = c.value
  }
  return { values, errors, valid: Object.keys(errors).length === 0 }
}

/**
 * What a saved draft keeps: every value typed so far, in the core's shape where it already is
 * one and as typed where not (a half-typed amount stays text), so reopening shows it again.
 */
export function draftPayload(fields: ExternalFormField[], drafts: Drafts): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const d = drafts[f.name]
    if (isEmptyDraft(f, d)) continue
    const c = checkField(f, d)
    if (!c.error) out[f.name] = c.value
    else if (f.kind === 'money') out[f.name] = { amount: (d as MoneyDraft).amount, currency: (d as MoneyDraft).currency }
    else out[f.name] = d
  }
  return out
}

// ---------------------------------------------------------------- suggestions from documents

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'undefined'
}

/** A value in a form the comparison ignores case and spacing for, where people would. */
function comparable(field: ExternalFormField, value: unknown): unknown {
  if (typeof value === 'string') {
    if (field.kind === 'identifier') return normalizeIdentifier(value)
    if (field.kind === 'number') return parseAmount(value) ?? value.trim()
    if (field.kind === 'money') {
      const n = parseAmount(value)
      return n === null ? value.trim() : { amount: n, currency: field.currency ?? DEFAULT_CURRENCY }
    }
    if (field.kind === 'email') return value.trim().toLowerCase()
    return value.trim().replace(/\s+/g, ' ')
  }
  if (field.kind === 'money' && typeof value === 'number') return { amount: value, currency: field.currency ?? DEFAULT_CURRENCY }
  return value
}

/** Whether the field's working value is this value (a suggestion's), as people would see it. */
export function draftEquals(field: ExternalFormField, draft: Draft | undefined, value: unknown): boolean {
  if (isEmptyDraft(field, draft)) return value === null || value === undefined || value === ''
  const c = checkField({ ...field, required: false }, draft)
  const mine = c.error ? draft : c.value
  return stable(comparable(field, mine)) === stable(comparable(field, value))
}

export interface PrefillState {
  drafts: Drafts
  /** field → the suggestion its value came from. */
  sources: Record<string, string>
}

/** The starting sources: fields whose value the core says came from a suggestion. */
export function initialSources(fields: ExternalFormField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) if (f.source?.kind === 'extracted') out[f.name] = f.source.suggestionId
  return out
}

const byConfidence = (a: ExtractSuggestion, b: ExtractSuggestion) => b.confidence - a.confidence

/**
 * Take in new suggestions. A confident one (`prefill`) fills its field when the field is empty
 * or still holds an earlier suggestion; it never replaces what the person typed or what was
 * already on the case. Everything else is offered under the field (`offersFor`).
 * Returns the new state and the fields it filled.
 */
export function applySuggestions(
  fields: ExternalFormField[],
  state: PrefillState,
  suggestions: ExtractSuggestion[],
  all: ExtractSuggestion[] = suggestions,
): PrefillState & { filled: string[] } {
  const drafts = { ...state.drafts }
  const sources = { ...state.sources }
  const filled: string[] = []
  for (const field of fields) {
    if (isFileField(field)) continue
    const best = suggestions.filter(s => s.field === field.name && s.prefill && s.found).sort(byConfidence)[0]
    if (!best) continue
    const current = drafts[field.name]
    const fromSuggestion = sources[field.name] ? all.find(s => s.id === sources[field.name]) : undefined
    const stillSuggested = fromSuggestion !== undefined && draftEquals(field, current, fromSuggestion.value)
    if (!isEmptyDraft(field, current) && !stillSuggested) continue
    drafts[field.name] = toDraft(field, best.value)
    sources[field.name] = best.id
    filled.push(field.name)
  }
  return { drafts, sources, filled }
}

/** The suggestion a field's value came from, while the value is still that suggestion's. */
export function activeSource(
  field: ExternalFormField,
  draft: Draft | undefined,
  sources: Record<string, string>,
  suggestions: ExtractSuggestion[],
): ExtractSuggestion | undefined {
  const id = sources[field.name]
  const s = id ? suggestions.find(x => x.id === id) : undefined
  return s && draftEquals(field, draft, s.value) ? s : undefined
}

/**
 * What to offer under a field: suggestions for it whose value isn't already there, the most
 * confident first, one per distinct value.
 */
export function offersFor(field: ExternalFormField, draft: Draft | undefined, suggestions: ExtractSuggestion[]): ExtractSuggestion[] {
  if (isFileField(field)) return []
  const seen = new Set<string>()
  const out: ExtractSuggestion[] = []
  for (const s of suggestions.filter(x => x.field === field.name).sort(byConfidence)) {
    if (s.value === null || s.value === undefined || s.value === '') continue
    if (draftEquals(field, draft, s.value)) continue
    const key = stable(comparable(field, s.value)).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** `sources` for the submission: only values still exactly what a suggestion said. */
export function submitSources(
  fields: ExternalFormField[],
  drafts: Drafts,
  sources: Record<string, string>,
  suggestions: ExtractSuggestion[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const s = activeSource(f, drafts[f.name], sources, suggestions)
    if (s) out[f.name] = s.id
  }
  return out
}

/** Merge suggestions from another reading, replacing any with the same id. */
export function mergeSuggestions(prev: ExtractSuggestion[], next: ExtractSuggestion[]): ExtractSuggestion[] {
  const ids = new Set(next.map(s => s.id))
  return [...prev.filter(s => !ids.has(s.id)), ...next]
}

// ---------------------------------------------------------------- files

/** Whether a file may be picked, against the form's limits (the core checks the content again). */
export function fileProblem(
  file: { name: string; size: number; type: string },
  limits: { maxFileBytes: number; accept: string[] },
): string | null {
  if (file.size > limits.maxFileBytes) return S.fileTooBig(file.name, formatBytes(limits.maxFileBytes))
  if (limits.accept.length > 0 && !acceptsFile(file, limits.accept)) return S.fileType(file.name)
  return null
}

/** `accept` entries are MIME types (`image/*` allowed) or extensions (`.pdf`). */
export function acceptsFile(file: { name: string; type: string }, accept: string[]): boolean {
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  // Phones label some files (HEIC photos) with no type at all; let the core judge by content.
  if (!type && accept.every(a => !a.trim().startsWith('.'))) return true
  return accept.some(a => {
    const x = a.trim().toLowerCase()
    if (x.startsWith('.')) return name.endsWith(x)
    if (x.endsWith('/*')) return type.startsWith(x.slice(0, -1))
    return type === x
  })
}
