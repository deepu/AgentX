import { describe, expect, test } from 'bun:test'
import i18next from 'i18next'
import en from '@memwise/shared/i18n/locales/en.json'
import type { MwChange, MwInboxItem } from '@memwise/shared/protocol'
import type { TFunction } from 'i18next'
import { groupAmount } from '../form-model'
import { attentionReason, resultMessage, stateLabel } from '../format'
import { caseChangeMatches, stepChangeMatches } from '../../../hooks/useMemwise'

const i18n = i18next.createInstance()
void i18n.init({ resources: { en: { translation: en } }, lng: 'en', fallbackLng: 'en', initAsync: false, interpolation: { escapeValue: false } })
const t = i18n.t.bind(i18n) as unknown as TFunction

describe('pushes', () => {
  const change = (c: Partial<MwChange>) => ({ kind: 'run', ...c }) as MwChange

  test('a case matches on its case id before anything is loaded', () => {
    expect(caseChangeMatches(change({ id: 'run9', caseId: 'case1' }), 'case1', null)).toBe(true)
    expect(caseChangeMatches(change({ id: 'run9', caseId: 'case2' }), 'case1', { runId: 'run9' })).toBe(false)
    // Older servers send no case id: fall back to the run id
    expect(caseChangeMatches(change({ id: 'run9' }), 'case1', { runId: 'run9' })).toBe(true)
  })

  test('a step record matches its own run or case only', () => {
    const cur = { runId: 'run1', caseId: 'case1' }
    expect(stepChangeMatches(change({ id: 'run1', caseId: 'case1' }), cur)).toBe(true)
    expect(stepChangeMatches(change({ id: 'run2', caseId: 'case2' }), cur)).toBe(false)
    expect(stepChangeMatches(change({ id: 'run2' }), null)).toBe(true)
  })
})

describe('prefilled numbers', () => {
  test('are grouped as people read them', () => {
    expect(groupAmount('1250000', 'INR')).toBe('12,50,000')
    expect(groupAmount('1250000.5', 'USD')).toBe('1,250,000.5')
    expect(groupAmount('12,50,000', 'USD')).toBe('1,250,000')
    expect(groupAmount('about 5')).toBe('about 5')
  })
})

describe('words from codes', () => {
  test('state titles', () => {
    expect(stateLabel('end', t)).toBe(en['memwise.playbook.endTitle'])
    expect(stateLabel('collect_documents', t, 'Collect the documents')).toBe('Collect the documents')
  })

  test('result messages use the code, falling back to the server text', () => {
    expect(resultMessage({ code: 'event.forbidden', message: 'server words' }, t)).toBe(en['memwise.result.event.forbidden'])
    expect(resultMessage({ code: 'no.such.code', message: 'server words' }, t)).toBe('server words')
    expect(resultMessage({ message: 'plain' }, t)).toBe('plain')
  })

  test('attention reasons', () => {
    const item = { kind: 'attention', id: 'a', caseId: 'c', state: 'verify', reason: 'stopped: no reply' } as unknown as Extract<MwInboxItem, { kind: 'attention' }>
    expect(attentionReason({ ...item, reasonCode: 'stopped', stopReason: 'no reply' }, t)).toContain('no reply')
    expect(attentionReason({ ...item, reasonCode: 'stopped' }, t)).toBe(en['memwise.inbox.attention.stopped'])
    expect(attentionReason(item, t)).toBe('stopped: no reply')
  })
})
