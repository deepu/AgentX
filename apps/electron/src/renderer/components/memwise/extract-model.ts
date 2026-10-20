/**
 * Reading a step's documents into its form when staff fill it in (Phase 5, docs/memwise/23 §5):
 * the same rules as the client's form (apps/external-form/src/model.ts). A confident suggestion
 * (`prefill`, `found`) fills a field only while it is empty or still holds an earlier suggestion;
 * everything else is offered under the field; on submit, `sources` names the suggestion of every
 * value still exactly as read. Pure, so bun tests run it as it is.
 */

import type { MwExtractSuggestion, MwField } from '@memwise/shared/protocol'
import { coerceFormValue, initialFormValue, toFormField, type FormField, type FormValue, type FormValues } from './form-model'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'undefined'
}

/** A value in the form the comparison ignores case and spacing for, where people would. */
function comparable(field: FormField, value: unknown): unknown {
  if (typeof value === 'string') {
    const s = value.trim()
    if (field.kind === 'identifier') return s.replace(/\s+/g, '').toUpperCase()
    if (field.kind === 'number') { const n = Number(s.replace(/,/g, '')); return Number.isFinite(n) && s ? n : s }
    if (field.kind === 'email') return s.toLowerCase()
    return s.replace(/\s+/g, ' ')
  }
  if (field.kind === 'money' && typeof value === 'number') return { amount: value }
  if (field.kind === 'money' && isObject(value)) return { amount: value.amount }
  return value
}

const isFileKind = (f: FormField) => f.kind === 'document' || f.kind === 'documents'

export function isEmptyValue(field: FormField, v: FormValue | undefined): boolean {
  return coerceFormValue({ ...field, required: false }, v ?? null).empty
}

/** Whether a form value is this (a suggestion's) value, as people would see it. */
export function formValueEquals(field: FormField, v: FormValue | undefined, value: unknown): boolean {
  const c = coerceFormValue({ ...field, required: false }, v ?? null)
  if (c.empty) return value === null || value === undefined || value === ''
  const mine = c.errors.length ? v : c.value
  return stable(comparable(field, mine)) === stable(comparable(field, value))
}

export interface ExtractState {
  values: FormValues
  /** field → the suggestion its value came from. */
  sources: Record<string, string>
}

const byConfidence = (a: MwExtractSuggestion, b: MwExtractSuggestion) => b.confidence - a.confidence

/** Take in new suggestions; returns the new state and the fields filled. `all` holds earlier ones too. */
export function applySuggestions(
  fields: MwField[],
  state: ExtractState,
  suggestions: MwExtractSuggestion[],
  all: MwExtractSuggestion[] = suggestions,
): ExtractState & { filled: string[] } {
  const values = { ...state.values }
  const sources = { ...state.sources }
  const filled: string[] = []
  for (const f of fields) {
    const field = toFormField(f)
    if (isFileKind(field)) continue
    const best = suggestions.filter(s => s.field === f.name && s.prefill && s.found).sort(byConfidence)[0]
    if (!best) continue
    const current = values[f.name]
    const earlier = sources[f.name] ? all.find(s => s.id === sources[f.name]) : undefined
    const stillEarlier = earlier !== undefined && formValueEquals(field, current, earlier.value)
    if (!isEmptyValue(field, current) && !stillEarlier) continue
    values[f.name] = initialFormValue(field, best.value)
    sources[f.name] = best.id
    filled.push(f.name)
  }
  return { values, sources, filled }
}

/** The suggestion a field's value came from, while the value is still that suggestion's. */
export function activeSource(f: MwField, v: FormValue | undefined, sources: Record<string, string>, suggestions: MwExtractSuggestion[]): MwExtractSuggestion | undefined {
  const s = sources[f.name] ? suggestions.find(x => x.id === sources[f.name]) : undefined
  return s && formValueEquals(toFormField(f), v, s.value) ? s : undefined
}

/** What to offer under a field: suggestions whose value isn't there already, most confident first, one per value. */
export function offersFor(f: MwField, v: FormValue | undefined, suggestions: MwExtractSuggestion[]): MwExtractSuggestion[] {
  const field = toFormField(f)
  if (isFileKind(field)) return []
  const seen = new Set<string>()
  const out: MwExtractSuggestion[] = []
  for (const s of suggestions.filter(x => x.field === f.name).sort(byConfidence)) {
    if (s.value === null || s.value === undefined || s.value === '') continue
    if (formValueEquals(field, v, s.value)) continue
    const key = stable(comparable(field, s.value)).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** `sources` for the submission: values still exactly what a suggestion said. */
export function submitSources(fields: MwField[], values: FormValues, sources: Record<string, string>, suggestions: MwExtractSuggestion[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const s = activeSource(f, values[f.name], sources, suggestions)
    if (s) out[f.name] = s.id
  }
  return out
}

/** The uploaded files' ids in the documents field (only files the server knows: they have an id). */
export function documentIds(values: FormValues, documentsField: string): string[] {
  const v = values[documentsField]
  const list = Array.isArray(v) ? v : v ? [v] : []
  return list.flatMap(d => (isObject(d) && typeof d.id === 'string' ? [d.id] : []))
}

export function mergeSuggestions(prev: MwExtractSuggestion[], next: MwExtractSuggestion[]): MwExtractSuggestion[] {
  const ids = new Set(next.map(s => s.id))
  return [...prev.filter(s => !ids.has(s.id)), ...next]
}
