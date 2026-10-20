import { describe, expect, test } from 'bun:test'
import type { MwField } from '@memwise/shared/protocol'
import {
  buildSubmission,
  coerceFormValue,
  emptyItem,
  initialFormValue,
  initialFormValues,
  toFormField,
} from '../form-model'
import { sampleCaseFields, sampleInbox } from '../sample-data'

const field = (name: string) => sampleCaseFields.find(f => f.name === name)!

describe('field kinds', () => {
  test('from type expressions and schema', () => {
    const kinds = Object.fromEntries(sampleCaseFields.map(f => [f.name, toFormField(f).kind]))
    expect(kinds).toEqual({
      client_name: 'text',
      client_email: 'email',
      pan: 'identifier',
      gstin: 'identifier',
      annual_turnover: 'money',
      documents: 'documents',
      gstin_ok: 'boolean',
      legal_name: 'text',
      flags: 'records',
      customer: 'text',
      status: 'enum',
    })
  })

  test('details: identifier scheme, enum options, record fields', () => {
    expect(toFormField(field('pan'))).toMatchObject({ scheme: 'PAN', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', required: true })
    expect(toFormField(field('status')).options).toEqual(['draft', 'submitted', 'checked', 'approved', 'rejected'])
    expect(toFormField(field('flags')).itemFields?.map(f => [f.name, f.kind])).toEqual([['field', 'text'], ['problem', 'text'], ['document', 'text']])
  })

  test('schema-only fields', () => {
    const f = (schema: Record<string, unknown>): MwField => ({ name: 'x', type: '', schema })
    expect(toFormField(f({ type: 'string', format: 'date' })).kind).toBe('date')
    expect(toFormField(f({ type: 'integer' })).kind).toBe('number')
    expect(toFormField(f({ type: 'array', items: { type: 'string' } }))).toMatchObject({ kind: 'list', itemKind: 'text' })
    expect(toFormField({ name: 'd', type: 'Document', schema: {} }).kind).toBe('document')
  })
})

describe('initial values', () => {
  test('prefill becomes form values', () => {
    const item = sampleInbox[0]!
    if (item.kind !== 'input') throw new Error('expected an input item')
    const values = initialFormValues(item.fields, item.prefill)
    expect(values.client_name).toBe('Acme Traders')
    expect(values.annual_turnover).toEqual({ amount: '0', currency: 'INR' })
    expect(values.documents).toEqual([])
    expect(values.pan).toBe('')
  })

  test('records and empty rows', () => {
    const flags = toFormField(field('flags'))
    expect(initialFormValue(flags, [{ field: 'pan', problem: 'x' }])).toEqual([{ field: 'pan', problem: 'x', document: '' }])
    expect(emptyItem(flags)).toEqual({ field: '', problem: '', document: '' })
  })
})

describe('coercion and validation', () => {
  test('required and empty', () => {
    expect(coerceFormValue(toFormField(field('client_name')), '  ').errors).toEqual([{ key: 'memwise.form.error.required' }])
    expect(coerceFormValue(toFormField(field('legal_name')), '')).toEqual({ value: undefined, empty: true, errors: [] })
  })

  test('scalars', () => {
    expect(coerceFormValue(toFormField(field('client_email')), 'not-an-email').errors[0]!.key).toBe('memwise.form.error.email')
    expect(coerceFormValue(toFormField(field('gstin_ok')), true).value).toBe(true)
    expect(coerceFormValue({ name: 'n', label: 'N', kind: 'number', required: false }, '1,250.5').value).toBe(1250.5)
    expect(coerceFormValue({ name: 'n', label: 'N', kind: 'number', required: false }, 'abc').errors[0]!.key).toBe('memwise.form.error.number')
  })

  test('identifiers are upper-cased and checked against their pattern', () => {
    const pan = toFormField(field('pan'))
    expect(coerceFormValue(pan, 'aaacm1234m').value).toBe('AAACM1234M')
    expect(coerceFormValue(pan, 'AAACM1234').errors[0]).toEqual({
      key: 'memwise.form.error.identifierExample',
      params: { scheme: 'PAN', example: 'ABCDE1234F' },
    })
  })

  test('money', () => {
    const money = toFormField(field('annual_turnover'))
    expect(coerceFormValue(money, { amount: '85,00,000', currency: 'inr' }).value).toEqual({ amount: 8500000, currency: 'INR' })
    expect(coerceFormValue(money, { amount: '10', currency: 'RUPEES' }).errors[0]!.key).toBe('memwise.form.error.currency')
    expect(coerceFormValue(money, { amount: '', currency: 'INR' }).empty).toBe(true)
  })

  test('lists of records drop empty rows and locate errors', () => {
    const flags = toFormField(field('flags'))
    const ok = coerceFormValue(flags, [{ field: 'pan', problem: 'Mismatch', document: 'pan.pdf' }, { field: '', problem: '', document: '' }])
    expect(ok.value).toEqual([{ field: 'pan', problem: 'Mismatch', document: 'pan.pdf' }])
    const nested: MwField = {
      name: 'rows', type: 'List<Row>', schema: { type: 'array', items: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } },
    }
    const bad = coerceFormValue(toFormField(nested), [{ email: 'x' }])
    expect(bad.errors).toEqual([{ key: 'memwise.form.error.email', at: '[0].email' }])
  })

  test('documents', () => {
    const docs = toFormField(field('documents'))
    const doc = { id: 'f1', name: 'pan.pdf', mime: 'application/pdf', size: 1, sha256: 'x' }
    expect(coerceFormValue(docs, [doc]).value).toEqual([doc])
    expect(coerceFormValue(docs, []).empty).toBe(true)
  })

  test('buildSubmission collects values and every field error', () => {
    const fields = ['client_name', 'client_email', 'pan', 'annual_turnover'].map(field)
    const s = buildSubmission(fields, { client_name: 'Ravi', client_email: 'ravi@x.example', pan: 'bad', annual_turnover: { amount: '', currency: '' } })
    expect(s.valid).toBe(false)
    expect(Object.keys(s.errors)).toEqual(['pan'])
    expect(s.values).toEqual({ client_name: 'Ravi', client_email: 'ravi@x.example' })
    const good = buildSubmission(fields, { client_name: 'Ravi', client_email: 'ravi@x.example', pan: 'AAACM1234M', annual_turnover: { amount: '5', currency: 'INR' } })
    expect(good).toEqual({
      valid: true,
      errors: {},
      values: { client_name: 'Ravi', client_email: 'ravi@x.example', pan: 'AAACM1234M', annual_turnover: { amount: 5, currency: 'INR' } },
    })
  })
})
