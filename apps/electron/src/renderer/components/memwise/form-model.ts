/**
 * The model behind generated step forms: what control each field gets (from its type
 * expression and JSON Schema), the form's working values, and turning them back into the
 * plain values `memwiseSubmitStep` takes. The server validates again (`validateValue`);
 * these checks only catch the obvious before a round trip.
 */

import type { MwCaseValue, MwDocument, MwField } from '@memwise/shared/protocol'
import { humanize, isMoney } from './format'

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'email'
  | 'phone'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'datetime'
  | 'money'
  | 'identifier'
  | 'document'
  | 'documents'
  | 'list'
  | 'records'
  | 'record'

export interface FormField {
  name: string
  label: string
  kind: FieldKind
  required: boolean
  description?: string
  /** enum */
  options?: string[]
  /** identifier: scheme and pattern (JSON Schema `pattern`) */
  scheme?: string
  pattern?: string
  /** records / record: the record's fields */
  itemFields?: FormField[]
  /** list: the kind of each item */
  itemKind?: FieldKind
}

type Schema = Record<string, unknown>

const asSchema = (v: unknown): Schema => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Schema) : {})

function isDocumentSchema(s: Schema): boolean {
  const any = s.anyOf
  return Array.isArray(any) && any.some(x => {
    const props = asSchema(asSchema(x).properties)
    return asSchema(x).type === 'object' && 'name' in props
  })
}

function isMoneySchema(s: Schema): boolean {
  const props = asSchema(s.properties)
  return s.type === 'object' && 'amount' in props && 'currency' in props
}

/** The kind of control for a type expression (`Identifier(PAN)`, `List<Document>`, `Enum[a, b]`) and schema. */
function kindOf(type: string | undefined, schema: Schema): Pick<FormField, 'kind' | 'options' | 'scheme' | 'pattern' | 'itemKind'> & { itemSchema?: Schema } {
  const tx = (type ?? '').trim()
  const list = /^List<(.+)>$/.exec(tx)
  if (list || schema.type === 'array') {
    const itemType = list?.[1]?.trim()
    const itemSchema = asSchema(schema.items)
    const inner = kindOf(itemType, itemSchema)
    if (inner.kind === 'document') return { kind: 'documents' }
    if (inner.kind === 'record') return { kind: 'records', itemSchema }
    return { kind: 'list', itemKind: inner.kind, options: inner.options, scheme: inner.scheme, pattern: inner.pattern }
  }
  const ident = /^Identifier\((.+)\)$/.exec(tx)
  if (ident) return { kind: 'identifier', scheme: ident[1]!.trim(), pattern: typeof schema.pattern === 'string' ? schema.pattern : undefined }
  if (tx === 'Money' || isMoneySchema(schema)) return { kind: 'money' }
  if (tx === 'Document' || tx === 'File' || tx === 'Image' || isDocumentSchema(schema)) return { kind: 'document' }
  const enumMatch = /^Enum\[(.*)\]$/.exec(tx)
  if (enumMatch) return { kind: 'enum', options: enumMatch[1]!.split(',').map(s => s.trim()).filter(Boolean) }
  if (Array.isArray(schema.enum)) return { kind: 'enum', options: schema.enum.map(String) }
  if (tx === 'Boolean' || schema.type === 'boolean') return { kind: 'boolean' }
  if (tx === 'Number' || tx === 'Percentage' || schema.type === 'number' || schema.type === 'integer') return { kind: 'number' }
  if (tx === 'Email' || schema.format === 'email') return { kind: 'email' }
  if (tx === 'Phone') return { kind: 'phone' }
  if (tx === 'Date' || schema.format === 'date') return { kind: 'date' }
  if (tx === 'DateTime' || schema.format === 'date-time') return { kind: 'datetime' }
  if (tx === 'Address') return { kind: 'longtext' }
  if (schema.type === 'object' && Object.keys(asSchema(schema.properties)).length > 0) return { kind: 'record' }
  if (typeof schema.pattern === 'string') return { kind: 'identifier', pattern: schema.pattern }
  return { kind: 'text' }
}

function recordFields(schema: Schema): FormField[] {
  const props = asSchema(schema.properties)
  const required = Array.isArray(schema.required) ? schema.required.map(String) : []
  return Object.entries(props).map(([name, s]) => fromSchema(name, undefined, asSchema(s), required.includes(name)))
}

function fromSchema(name: string, type: string | undefined, schema: Schema, required: boolean, description?: string): FormField {
  const k = kindOf(type, schema)
  const field: FormField = {
    name,
    label: humanize(name),
    kind: k.kind,
    required,
    description: description ?? (typeof schema.description === 'string' && k.kind !== 'identifier' && k.kind !== 'document' ? schema.description : undefined),
  }
  if (k.options) field.options = k.options
  if (k.scheme) field.scheme = k.scheme
  if (k.pattern) field.pattern = k.pattern
  if (k.itemKind) field.itemKind = k.itemKind
  if (k.kind === 'records') field.itemFields = recordFields(k.itemSchema ?? {})
  if (k.kind === 'record') field.itemFields = recordFields(schema)
  return field
}

export function toFormField(field: MwField): FormField {
  return fromSchema(field.name, field.type, field.schema ?? {}, !!field.required, field.description)
}

// ---------------------------------------------------------------- working values

export interface MoneyDraft { amount: string; currency: string }

/** Shown filled in, not as a placeholder: an empty currency box that looks filled fails validation. */
export const DEFAULT_CURRENCY = 'INR'
export type DocumentDraft = MwDocument | { name: string; [k: string]: unknown }
export type FormValue =
  | string
  | boolean
  | MoneyDraft
  | DocumentDraft
  | null
  | FormValue[]
  | { [field: string]: FormValue }

export type FormValues = Record<string, FormValue>

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The form's starting value for a field, from a prefilled case value when there is one. */
export function initialFormValue(field: FormField, prefill: unknown): FormValue {
  switch (field.kind) {
    case 'boolean':
      return typeof prefill === 'boolean' ? prefill : false
    case 'number':
      return typeof prefill === 'number' ? String(prefill) : typeof prefill === 'string' ? prefill : ''
    case 'money':
      return isMoney(prefill)
        ? { amount: String(prefill.amount), currency: prefill.currency }
        : { amount: '', currency: isPlainObject(prefill) && typeof prefill.currency === 'string' ? prefill.currency : DEFAULT_CURRENCY }
    case 'document':
      if (isPlainObject(prefill) && typeof prefill.name === 'string') return prefill as DocumentDraft
      if (typeof prefill === 'string' && prefill) return { name: prefill }
      return null
    case 'documents':
      return Array.isArray(prefill)
        ? prefill.map(d => (isPlainObject(d) && typeof d.name === 'string' ? (d as DocumentDraft) : { name: String(d) }))
        : []
    case 'list':
      return Array.isArray(prefill) ? prefill.map(x => initialFormValue({ ...field, kind: field.itemKind ?? 'text' }, x)) : []
    case 'records':
      return Array.isArray(prefill) ? prefill.map(x => initialRecord(field.itemFields ?? [], x)) : []
    case 'record':
      return initialRecord(field.itemFields ?? [], prefill)
    default:
      return typeof prefill === 'string' ? prefill : prefill === undefined || prefill === null ? '' : String(prefill)
  }
}

function initialRecord(fields: FormField[], prefill: unknown): { [field: string]: FormValue } {
  const src = isPlainObject(prefill) ? prefill : {}
  const out: { [field: string]: FormValue } = {}
  for (const f of fields) out[f.name] = initialFormValue(f, src[f.name])
  return out
}

/** An empty item for a repeatable list. */
export function emptyItem(field: FormField): FormValue {
  if (field.kind === 'records') return initialRecord(field.itemFields ?? [], undefined)
  return initialFormValue({ ...field, kind: field.itemKind ?? 'text' }, undefined)
}

export function initialFormValues(fields: MwField[], prefill: Record<string, MwCaseValue | undefined> = {}): FormValues {
  const out: FormValues = {}
  for (const f of fields) out[f.name] = initialFormValue(toFormField(f), prefill[f.name]?.value)
  return out
}

// ---------------------------------------------------------------- validation and coercion

/** A problem with a value, as an i18n key with its parameters. */
export interface FormError {
  key: string
  params?: Record<string, string | number>
  /** Where inside the value (`[1].document`), when it is in a list or record. */
  at?: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CURRENCY = /^[A-Z]{3}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Known examples so the hint under an identifier shows what one looks like. */
export const IDENTIFIER_EXAMPLES: Record<string, string> = {
  PAN: 'ABCDE1234F',
  GSTIN: '27ABCDE1234F1Z5',
}

interface Coerced { value: unknown; empty: boolean; errors: FormError[] }

function safeRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

/** The plain value to submit for a field, whether it's empty, and what's wrong with it. */
export function coerceFormValue(field: FormField, v: FormValue): Coerced {
  const ok = (value: unknown): Coerced => ({ value, empty: false, errors: [] })
  const empty = (): Coerced => ({ value: undefined, empty: true, errors: field.required ? [{ key: 'memwise.form.error.required' }] : [] })
  const bad = (key: string, params?: FormError['params']): Coerced => ({ value: undefined, empty: false, errors: [{ key, params }] })

  switch (field.kind) {
    case 'boolean':
      return ok(v === true)
    case 'number': {
      const s = typeof v === 'string' ? v.trim() : ''
      if (!s) return empty()
      const n = Number(s.replace(/,/g, ''))
      return Number.isFinite(n) ? ok(n) : bad('memwise.form.error.number')
    }
    case 'money': {
      const m = isPlainObject(v) ? (v as Partial<MoneyDraft>) : {}
      const amount = typeof m.amount === 'string' ? m.amount.trim() : ''
      const currency = typeof m.currency === 'string' ? m.currency.trim().toUpperCase() : ''
      if (!amount) return empty()
      const n = Number(amount.replace(/,/g, ''))
      if (!Number.isFinite(n)) return bad('memwise.form.error.number')
      if (!CURRENCY.test(currency)) return bad('memwise.form.error.currency')
      return ok({ amount: n, currency })
    }
    case 'document': {
      if (isPlainObject(v) && typeof v.name === 'string' && v.name) return ok(v)
      return empty()
    }
    case 'documents': {
      const docs = Array.isArray(v) ? v.filter(d => isPlainObject(d) && typeof d.name === 'string') : []
      return docs.length ? ok(docs) : empty()
    }
    case 'list':
    case 'records': {
      const items = Array.isArray(v) ? v : []
      const itemField: FormField = field.kind === 'records'
        ? { ...field, kind: 'record', required: false }
        : { ...field, kind: field.itemKind ?? 'text', required: false }
      const values: unknown[] = []
      const errors: FormError[] = []
      items.forEach((item, i) => {
        const c = coerceFormValue(itemField, item)
        for (const e of c.errors) errors.push({ ...e, at: `[${i}]${e.at ?? ''}` })
        if (!c.empty) values.push(c.value)
      })
      if (errors.length) return { value: undefined, empty: false, errors }
      return values.length ? ok(values) : empty()
    }
    case 'record': {
      const src = isPlainObject(v) ? (v as Record<string, FormValue>) : {}
      const out: Record<string, unknown> = {}
      const errors: FormError[] = []
      let any = false
      for (const f of field.itemFields ?? []) {
        const c = coerceFormValue(f, src[f.name] ?? null)
        if (!c.empty && f.kind !== 'boolean') any = true
        if (!c.empty) out[f.name] = c.value
        for (const e of c.errors) errors.push({ ...e, at: `.${f.name}${e.at ?? ''}` })
      }
      if (!any) return empty()
      if (errors.length) return { value: undefined, empty: false, errors }
      return ok(out)
    }
    default: {
      const s = typeof v === 'string' ? v.trim() : ''
      if (!s) return empty()
      if (field.kind === 'email' && !EMAIL.test(s)) return bad('memwise.form.error.email')
      if (field.kind === 'date' && !DATE.test(s)) return bad('memwise.form.error.date')
      if (field.kind === 'identifier') {
        // Schemes whose pattern only allows capitals (PAN, GSTIN) accept lower-case typing.
        const value = field.pattern && !field.pattern.includes('a-z') ? s.toUpperCase() : s
        const re = field.pattern ? safeRegExp(field.pattern) : null
        if (re && !re.test(value)) {
          const example = field.scheme ? IDENTIFIER_EXAMPLES[field.scheme.toUpperCase()] : undefined
          return example
            ? bad('memwise.form.error.identifierExample', { scheme: field.scheme ?? '', example })
            : bad('memwise.form.error.identifier', { scheme: field.scheme ?? field.label })
        }
        return ok(value)
      }
      return ok(s)
    }
  }
}

export interface Submission {
  values: Record<string, unknown>
  errors: Record<string, FormError[]>
  valid: boolean
}

/** Turn the form into submit values, collecting every field's problems. Empty optional fields are left out. */
export function buildSubmission(fields: MwField[], values: FormValues): Submission {
  const out: Record<string, unknown> = {}
  const errors: Record<string, FormError[]> = {}
  for (const f of fields) {
    const ff = toFormField(f)
    const c = coerceFormValue(ff, values[f.name] ?? null)
    if (c.errors.length) errors[f.name] = c.errors
    else if (!c.empty) out[f.name] = c.value
  }
  return { values: out, errors, valid: Object.keys(errors).length === 0 }
}
