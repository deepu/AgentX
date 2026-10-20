import { describe, expect, test } from 'bun:test'
import type { ExternalFormField, ExtractSuggestion } from '@memwise/defs/external'
import {
  acceptsFile,
  activeSource,
  applySuggestions,
  buildSubmission,
  checkField,
  draftEquals,
  draftPayload,
  fileProblem,
  formatBytes,
  formatValue,
  groupAmount,
  initialDrafts,
  initialSources,
  offersFor,
  parseAmount,
  submitSources,
  toDraft,
} from '../model'
import { parseRoute } from '../route'

const field = (f: Partial<ExternalFormField> & Pick<ExternalFormField, 'name' | 'kind'>): ExternalFormField => ({
  label: f.name,
  required: false,
  ...f,
})

const PAN = field({ name: 'pan', kind: 'identifier', required: true, upperCase: true, pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', placeholder: 'ABCDE1234F' })
const NAME = field({ name: 'client_name', kind: 'text', required: true })
const TURNOVER = field({ name: 'turnover', kind: 'money', currency: 'INR' })
const DOCS = field({ name: 'documents', kind: 'documents', required: true })

const suggestion = (s: Partial<ExtractSuggestion> & Pick<ExtractSuggestion, 'id' | 'field' | 'value'>): ExtractSuggestion => ({
  confidence: 0.9,
  document: 'pan-card.pdf',
  documentId: 'doc_1',
  found: true,
  prefill: true,
  ...s,
})

describe('money and numbers', () => {
  test('parseAmount reads what people type', () => {
    expect(parseAmount('4,20,00,000')).toBe(42000000)
    expect(parseAmount('1,200.50')).toBe(1200.5)
    expect(parseAmount(' ₹ 1 200 ')).toBe(1200)
    expect(parseAmount('Rs. 500')).toBe(500)
    expect(parseAmount('-12')).toBe(-12)
    expect(parseAmount('.5')).toBe(0.5)
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('12abc')).toBeNull()
    expect(parseAmount('1.2.3')).toBeNull()
    expect(parseAmount('ten')).toBeNull()
  })

  test('groupAmount groups rupees in lakhs and others in thousands, keeping decimals', () => {
    expect(groupAmount('42000000', 'INR')).toBe('4,20,00,000')
    expect(groupAmount('42000000', 'USD')).toBe('42,000,000')
    expect(groupAmount('1200.5')).toBe('1,200.5')
    expect(groupAmount('-1500', 'INR')).toBe('-1,500')
    expect(groupAmount('not a number')).toBe('not a number')
  })

  test('money is sent as { amount, currency }', () => {
    expect(checkField(TURNOVER, { amount: '4,20,00,000', currency: 'INR' })).toEqual({ empty: false, value: { amount: 42000000, currency: 'INR' } })
    expect(checkField(TURNOVER, { amount: 'lots', currency: 'INR' }).error).toBeTruthy()
    expect(checkField(TURNOVER, { amount: '', currency: 'INR' })).toEqual({ empty: true, error: undefined })
  })

  test('toDraft takes money as an object or a bare number', () => {
    expect(toDraft(TURNOVER, { amount: 4200000, currency: 'INR' })).toEqual({ amount: '42,00,000', currency: 'INR' })
    expect(toDraft(TURNOVER, 1500)).toEqual({ amount: '1,500', currency: 'INR' })
    expect(toDraft(TURNOVER, undefined)).toEqual({ amount: '', currency: 'INR' })
  })

  test('formatValue shows values for one line', () => {
    expect(formatValue({ amount: 42000000, currency: 'INR' })).toBe('₹4,20,00,000')
    expect(formatValue(1500, TURNOVER)).toBe('₹1,500')
    expect(formatValue(true)).toBe('Yes')
    expect(formatValue('gst', field({ name: 'x', kind: 'enum', options: [{ value: 'gst', label: 'GST registered' }] }))).toBe('GST registered')
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatBytes(2048)).toBe('2 KB')
  })
})

describe('checks', () => {
  test('identifiers are upper-cased, spaces dropped, and checked against the pattern', () => {
    expect(checkField(PAN, 'aaaca 1234a')).toEqual({ empty: false, value: 'AAACA1234A' })
    expect(checkField(PAN, 'AAACA1234').error).toBe('This doesn’t look right. It should look like ABCDE1234F.')
    expect(checkField(PAN, '').error).toBe('Please fill this in.')
  })

  test('a pattern without anchors checks the whole value', () => {
    const f = field({ name: 'pin', kind: 'identifier', pattern: '[0-9]{6}' })
    expect(checkField(f, '560001').error).toBeUndefined()
    expect(checkField(f, '5600012').error).toBeTruthy()
  })

  test('email, phone, date, number', () => {
    expect(checkField(field({ name: 'e', kind: 'email' }), 'asha@acme').error).toBe('Please check this email address.')
    expect(checkField(field({ name: 'e', kind: 'email' }), ' asha@acme.example ').value).toBe('asha@acme.example')
    expect(checkField(field({ name: 'p', kind: 'phone' }), '+91 98765 43210').value).toBe('+919876543210')
    expect(checkField(field({ name: 'p', kind: 'phone' }), 'call me').error).toBe('Please check this phone number.')
    expect(checkField(field({ name: 'd', kind: 'date' }), '2026-10-20').value).toBe('2026-10-20')
    expect(checkField(field({ name: 'n', kind: 'number' }), '1,200').value).toBe(1200)
  })

  test('booleans are unanswered until chosen; enums only take their options', () => {
    const b = field({ name: 'gst_registered', kind: 'boolean', required: true })
    expect(checkField(b, null).error).toBe('Please choose one.')
    expect(checkField(b, false)).toEqual({ empty: false, value: false })
    const e = field({ name: 'via', kind: 'enum', options: [{ value: 'email', label: 'Email' }] })
    expect(checkField(e, 'fax').error).toBeTruthy()
    expect(checkField(e, 'email').value).toBe('email')
  })

  test('buildSubmission leaves out empty optional fields and collects problems', () => {
    const drafts = { pan: 'aaaca1234a', client_name: '', turnover: { amount: '', currency: 'INR' }, documents: [] }
    const s = buildSubmission([PAN, NAME, TURNOVER, DOCS], drafts)
    expect(s.valid).toBe(false)
    expect(s.values).toEqual({ pan: 'AAACA1234A' })
    expect(Object.keys(s.errors).sort()).toEqual(['client_name', 'documents'])
    expect(s.errors.documents).toBe('Please add a file.')
  })

  test('a single document is sent as one, a list as a list', () => {
    const doc = { id: 'd1', name: 'pan-card.pdf', mime: 'application/pdf', size: 1200 }
    expect(checkField(field({ name: 'one', kind: 'document' }), [doc]).value).toEqual(doc)
    expect(checkField(DOCS, [doc]).value).toEqual([doc])
  })

  test('a draft keeps half-typed values as typed', () => {
    const p = draftPayload([PAN, NAME, TURNOVER], { pan: 'AAAC', client_name: 'Asha', turnover: { amount: '12x', currency: 'INR' } })
    expect(p).toEqual({ pan: 'AAAC', client_name: 'Asha', turnover: { amount: '12x', currency: 'INR' } })
  })
})

describe('suggestions from documents', () => {
  const fields = [PAN, NAME, TURNOVER, DOCS]
  const panS = suggestion({ id: 's1', field: 'pan', value: 'AAACA1234A', confidence: 0.93 })
  const nameS = suggestion({ id: 's2', field: 'client_name', value: 'Acme Traders Pvt Ltd', confidence: 0.62, prefill: false })

  test('a confident suggestion fills an empty field; an unsure one is only offered', () => {
    const state = { drafts: initialDrafts(fields), sources: {} }
    const next = applySuggestions(fields, state, [panS, nameS])
    expect(next.filled).toEqual(['pan'])
    expect(next.drafts.pan).toBe('AAACA1234A')
    expect(next.sources).toEqual({ pan: 's1' })
    expect(next.drafts.client_name).toBe('')
    expect(offersFor(NAME, next.drafts.client_name, [panS, nameS]).map(s => s.id)).toEqual(['s2'])
    expect(offersFor(PAN, next.drafts.pan, [panS, nameS])).toEqual([])
  })

  test('it never replaces what the person typed, but offers it', () => {
    const state = { drafts: { ...initialDrafts(fields), pan: 'AAACB9999Z' }, sources: {} }
    const next = applySuggestions(fields, state, [panS])
    expect(next.filled).toEqual([])
    expect(next.drafts.pan).toBe('AAACB9999Z')
    expect(offersFor(PAN, next.drafts.pan, [panS]).map(s => s.id)).toEqual(['s1'])
  })

  test('a not-found value is never pre-filled, even when marked prefill', () => {
    const invented = suggestion({ id: 's9', field: 'pan', value: 'ZZZZZ0000Z', found: false, confidence: 0.5 })
    const next = applySuggestions(fields, { drafts: initialDrafts(fields), sources: {} }, [invented])
    expect(next.filled).toEqual([])
  })

  test('a newer reading replaces an earlier suggestion the person kept as it was', () => {
    const later = suggestion({ id: 's3', field: 'pan', value: 'AAACA1234B', confidence: 0.97, document: 'gst-certificate.pdf' })
    const first = applySuggestions(fields, { drafts: initialDrafts(fields), sources: {} }, [panS])
    const second = applySuggestions(fields, first, [later], [panS, later])
    expect(second.drafts.pan).toBe('AAACA1234B')
    expect(second.sources.pan).toBe('s3')
  })

  test('the most confident of several suggestions wins', () => {
    const low = suggestion({ id: 'a', field: 'pan', value: 'AAACA1111A', confidence: 0.81 })
    const high = suggestion({ id: 'b', field: 'pan', value: 'AAACA2222A', confidence: 0.95 })
    const next = applySuggestions(fields, { drafts: initialDrafts(fields), sources: {} }, [low, high])
    expect(next.sources.pan).toBe('b')
    expect(offersFor(PAN, next.drafts.pan, [low, high]).map(s => s.id)).toEqual(['a'])
  })

  test('sources are sent only while the value is still the suggestion', () => {
    const filled = applySuggestions(fields, { drafts: initialDrafts(fields), sources: {} }, [panS])
    expect(submitSources(fields, filled.drafts, filled.sources, [panS])).toEqual({ pan: 's1' })
    // typed in lower case with a space: still the same PAN
    expect(submitSources(fields, { ...filled.drafts, pan: 'aaaca 1234a' }, filled.sources, [panS])).toEqual({ pan: 's1' })
    // changed: it is the person's own now
    expect(submitSources(fields, { ...filled.drafts, pan: 'AAACA1234Z' }, filled.sources, [panS])).toEqual({})
    expect(activeSource(PAN, 'AAACA1234Z', filled.sources, [panS])).toBeUndefined()
  })

  test('money suggestions compare by amount', () => {
    const s = suggestion({ id: 'm', field: 'turnover', value: { amount: 42000000, currency: 'INR' } })
    expect(draftEquals(TURNOVER, { amount: '4,20,00,000', currency: 'INR' }, s.value)).toBe(true)
    expect(draftEquals(TURNOVER, { amount: '4,20,00,001', currency: 'INR' }, s.value)).toBe(false)
    expect(draftEquals(TURNOVER, { amount: '42000000', currency: 'INR' }, 42000000)).toBe(true)
  })

  test('values the core says came from a suggestion keep their source after a reload', () => {
    const reloaded = [{ ...PAN, value: 'AAACA1234A', source: { kind: 'extracted' as const, suggestionId: 's1', document: 'pan-card.pdf', confidence: 0.93 } }, NAME]
    expect(initialSources(reloaded)).toEqual({ pan: 's1' })
  })

  test('offers show each distinct value once', () => {
    const a = suggestion({ id: 'a', field: 'client_name', value: 'Acme Traders', prefill: false, confidence: 0.6 })
    const b = suggestion({ id: 'b', field: 'client_name', value: 'acme  traders', prefill: false, confidence: 0.4, document: 'gst.pdf' })
    expect(offersFor(NAME, '', [a, b]).map(s => s.id)).toEqual(['a'])
  })
})

describe('files', () => {
  const limits = { maxFileBytes: 15 * 1024 * 1024, accept: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'text/plain'] }
  test('too big and wrong types are caught before uploading', () => {
    expect(fileProblem({ name: 'scan.pdf', size: 20 * 1024 * 1024, type: 'application/pdf' }, limits)).toBe('scan.pdf is too big. Files can be up to 15 MB.')
    expect(fileProblem({ name: 'tool.exe', size: 100, type: 'application/x-msdownload' }, limits)).toContain('can’t be added')
    expect(fileProblem({ name: 'pan.jpg', size: 100, type: 'image/jpeg' }, limits)).toBeNull()
  })
  test('accept takes MIME types, wildcards and extensions; untyped files go to the core', () => {
    expect(acceptsFile({ name: 'a.png', type: 'image/png' }, ['image/*'])).toBe(true)
    expect(acceptsFile({ name: 'a.PDF', type: '' }, ['.pdf'])).toBe(true)
    expect(acceptsFile({ name: 'IMG_1.HEIC', type: '' }, limits.accept)).toBe(true)
    expect(acceptsFile({ name: 'a.zip', type: 'application/zip' }, limits.accept)).toBe(false)
  })
})

describe('route', () => {
  test('finds the link under any base', () => {
    expect(parseRoute('/f/mwl_abc-_1')).toEqual({ kind: 'form', token: 'mwl_abc-_1', api: '/f/mwl_abc-_1/api' })
    expect(parseRoute('/x/abcdefghijklmnop/f/mwl_abc')).toEqual({ kind: 'form', token: 'mwl_abc', api: '/x/abcdefghijklmnop/f/mwl_abc/api' })
    expect(parseRoute('/i/mwl_xyz/')).toEqual({ kind: 'inbox', token: 'mwl_xyz', api: '/i/mwl_xyz/api' })
    expect(parseRoute('/f/')).toBeNull()
    expect(parseRoute('/assets/form/x.js')).toBeNull()
  })
})
