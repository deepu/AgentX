import { describe, expect, test } from 'bun:test'
import i18next from 'i18next'
import en from '@memwise/shared/i18n/locales/en.json'
import type { MwCaseValue } from '@memwise/shared/protocol'
import type { TFunction } from 'i18next'
import {
  filterCases,
  formatValueInline,
  humanize,
  outcomeLabel,
  outcomeNeedsComment,
  peopleById,
  provenanceBadge,
  relativeTime,
  sortInbox,
  toolLabel,
  checkLabel,
  waitingOnLabel,
} from '../format'
import { sampleCaseSummaries, sampleInbox, samplePeople, sampleRoles, sampleValues } from '../sample-data'

// A private instance: the shared i18next singleton is set up once per process, possibly by
// another test file with other options, when the whole suite runs together.
const i18n = i18next.createInstance()
void i18n.init({ resources: { en: { translation: en } }, lng: 'en', fallbackLng: 'en', initAsync: false, interpolation: { escapeValue: false } })
const t = i18n.t.bind(i18n) as unknown as TFunction

describe('words', () => {
  test('humanize', () => {
    expect(humanize('client_name')).toBe('Client name')
    expect(humanize('gstin_ok')).toBe('GSTIN ok')
    expect(humanize('needs_person')).toBe('Needs person')
    expect(toolLabel('intake.extract_fields')).toBe('Extract fields')
    expect(toolLabel('gst.validate_gstin')).toBe('Validate GSTIN')
    expect(toolLabel('domain.customer.create')).toBe('Create customer')
    expect(checkLabel('outcome is declared', t)).toBe('Finished with one of the step’s outcomes')
    expect(checkLabel('writes.gstin_ok: from tool gst.validate_gstin (valid)', t)).toBe('GSTIN ok matches what “Validate GSTIN” returned')
    expect(checkLabel('writes.flags: List<Flag>', t)).toBe('Flags is in the right form')
    expect(checkLabel('every flag names the document it came from', t)).toBe('every flag names the document it came from')
  })

  test('outcomes', () => {
    expect(outcomeLabel('sent_back', t)).toBe('Send back')
    expect(outcomeLabel('approved', t)).toBe('Approve')
    expect(outcomeLabel('needs_info', t)).toBe('Needs info')
    expect(outcomeNeedsComment('sent_back')).toBe(true)
    expect(outcomeNeedsComment('rejected')).toBe(true)
    expect(outcomeNeedsComment('approved')).toBe(false)
  })
})

describe('provenance badges', () => {
  const people = peopleById(samplePeople)
  const at = '2026-10-20T00:00:00Z'
  const badge = (v: MwCaseValue) => provenanceBadge(v, t, people)

  test('each kind reads in plain words', () => {
    expect(badge(sampleValues.client_name!)).toMatchObject({ tone: 'person', text: 'Typed by Priya Shah' })
    expect(badge(sampleValues.gstin_ok!)).toMatchObject({ tone: 'tool', text: 'From Validate GSTIN' })
    expect(badge({ value: 1, provenance: { kind: 'judgement', at, stepRunId: 's' } })).toMatchObject({ tone: 'judgement', text: 'Agent’s judgement' })
    expect(badge({ value: 1, provenance: { kind: 'input', at } })).toMatchObject({ tone: 'input', text: 'Entered at start' })
    expect(badge({ value: 1, provenance: { kind: 'system', at } })).toMatchObject({ tone: 'system' })
  })

  test('taint and hidden win over the source', () => {
    expect(badge(sampleValues.flags!)).toMatchObject({ tone: 'tainted', text: 'From a document' })
    expect(badge(sampleValues.bank_account!)).toMatchObject({ tone: 'hidden', text: 'Restricted' })
  })

  test('unknown people fall back to their id', () => {
    expect(provenanceBadge({ value: 1, provenance: { kind: 'person', at, by: 'per_x' } }, t, {}).text).toBe('Typed by per_x')
  })
})

describe('values', () => {
  test('inline formatting', () => {
    expect(formatValueInline(true, t, 'en')).toBe('Yes')
    expect(formatValueInline(null, t, 'en')).toBe('—')
    expect(formatValueInline({ amount: 8500000, currency: 'INR' }, t, 'en-IN')).toContain('85,00,000')
    expect(formatValueInline([{ name: 'a.pdf', mime: 'application/pdf' }, { name: 'b.pdf', mime: 'x' }], t, 'en')).toBe('a.pdf, b.pdf')
    expect(formatValueInline([{ field: 'pan' }, { field: 'gstin' }], t, 'en')).toBe('2 items')
  })

  test('relative time', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(relativeTime('2026-10-17T12:00:00Z', now, 'en')).toBe('3 days ago')
    expect(relativeTime('2026-10-20T11:59:50Z', now, 'en')).toBe('this minute')
    expect(relativeTime(undefined, now, 'en')).toBe('')
  })
})

describe('inbox and cases', () => {
  test('inbox is newest first', () => {
    const sorted = sortInbox([...sampleInbox].reverse())
    const times = sorted.map(i => Date.parse(i.since))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(sorted[0]!.id).toBe('inb_input_acme')
  })

  test('cases filter by playbook and status, latest first', () => {
    expect(filterCases(sampleCaseSummaries, {}).map(c => c.caseId)).toEqual(['case_acme', 'case_menon', 'case_sun'])
    expect(filterCases(sampleCaseSummaries, { status: 'stopped' }).map(c => c.caseId)).toEqual(['case_sun'])
    expect(filterCases(sampleCaseSummaries, { workflowId: 'other' })).toEqual([])
  })

  test('who a case waits on', () => {
    expect(waitingOnLabel(sampleCaseSummaries[0]!, t, sampleRoles)).toBe('Waiting on Manager')
    expect(waitingOnLabel(sampleCaseSummaries[2]!, t, sampleRoles)).toBeUndefined()
  })
})
