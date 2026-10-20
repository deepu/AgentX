/**
 * Restricted (`access:`) case fields stay hidden in a step record, in the explain digest and in
 * the anchored chat's digest for a person without the role (19 §3): values are nulled, and a
 * step that handles them shows its journal without request and response bodies.
 */
import { describe, expect, it } from 'bun:test'
import { stepDigest } from '@memwise/runtime'
import { hiddenStepFields, toStepRecord, visibleJournal } from '../dto'

const BANK = 'HDFC0001234 / 50100012345678'

const field = (access?: string[]) => ({ type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text', ...(access ? { access } : {}) })

const workflow = {
  id: 'onboarding', version: 1, title: 'Onboarding', start: 'collect',
  caseType: { fields: { client_name: field(), bank_account: field(['finance']) } },
  states: { collect: { on: { done: 'end' } }, greet: { on: { done: 'end' } } },
  steps: {
    collect: {
      id: 'collect', title: 'Collect bank details', performer: 'agent', instructions: 'Read the cheque.',
      reads: ['case.client_name'], writes: { bank_account: { field: 'bank_account' } },
    },
    greet: { id: 'greet', title: 'Greet', performer: 'agent', instructions: 'Say hello.', reads: ['case.client_name'], writes: {} },
  },
}
const project = { workflows: { onboarding: workflow }, entities: {} }

const prov = { kind: 'tool' as const, at: '2026-01-01T00:00:00Z', stepRunId: 'sr1', tool: 'ocr.read', callId: 'c1' }
const journalEntry = (journalKey: string, extra: Record<string, unknown> = {}) => ({
  journalKey, kind: 'model', name: 'checker', request: { prompt: `account ${BANK}` }, response: { text: BANK },
  startedAt: '2026-01-01T00:00:00Z', ...extra,
})

function record(stepId: 'collect' | 'greet') {
  return {
    stepRunId: 'sr1', runId: 'run1', caseId: 'case1', workflowId: 'onboarding', workflowVersion: 1, stepId,
    performer: 'agent', attempt: 1, status: 'completed', outcome: 'done', tainted: false,
    startedAt: '2026-01-01T00:00:00Z',
    context: {
      pushed: { client_name: { value: 'Asha', provenance: prov }, ...(stepId === 'collect' ? { bank_account: { value: BANK, provenance: prov } } : {}) },
      priorAttempts: [], tools: [{ tool: 'ocr.read' }], modelRole: 'checker',
    },
    outputs: stepId === 'collect' ? { bank_account: { value: BANK, provenance: prov } } : {},
    checkpoint: [],
    journal: [
      journalEntry('model:1#1', { response: undefined }),
      journalEntry('model:1'),
      { journalKey: 'tool:c1', kind: 'tool', name: 'ocr.read', callId: 'c1', request: { file: 'cheque.pdf' }, response: { account: BANK }, startedAt: '2026-01-01T00:00:01Z' },
    ],
    usage: { tokens: 10, modelCalls: 1, durationMs: 5 },
  }
}

const staff = { kind: 'person' as const, personId: 'p1', roles: ['staff'] }
const finance = { kind: 'person' as const, personId: 'p2', roles: ['finance'] }

describe('step records with restricted fields', () => {
  it('hide the values and the journal bodies from someone without the role', () => {
    const r = toStepRecord(project as any, record('collect') as any, undefined, staff)
    expect(r.restricted).toBe(true)
    expect(r.outputs.bank_account).toMatchObject({ value: null, hidden: true })
    expect(r.context?.pushed.bank_account).toMatchObject({ value: null, hidden: true })
    expect(r.context?.pushed.client_name?.value).toBe('Asha')
    expect(r.journal.every((j) => j.redacted && j.request === undefined && j.response === undefined)).toBe(true)
    expect(r.journal.map((j) => j.name)).toEqual(['checker', 'ocr.read'])
    expect(JSON.stringify(r)).not.toContain(BANK)
  })

  it('show everything to someone with the role', () => {
    const r = toStepRecord(project as any, record('collect') as any, undefined, finance)
    expect(r.restricted).toBeUndefined()
    expect(r.outputs.bank_account?.value).toBe(BANK)
    expect(r.journal.find((j) => j.kind === 'tool')?.response).toEqual({ account: BANK })
  })

  it('leave a step that never touches a restricted field alone', () => {
    expect(hiddenStepFields(workflow as any, record('greet') as any, staff)).toEqual([])
    const r = toStepRecord(project as any, record('greet') as any, undefined, staff)
    expect(r.restricted).toBeUndefined()
    expect(r.journal.some((j) => j.request !== undefined)).toBe(true)
  })

  it('list each model call once, as usage counts them', () => {
    const j = visibleJournal(record('greet').journal as any, false)
    expect(j.filter((e) => e.kind === 'model').map((e) => e.key)).toEqual(['model:1'])
    // A call cut off before its answer still leaves its trace
    const cut = visibleJournal([journalEntry('model:2#1', { response: undefined })] as any, false)
    expect(cut.map((e) => e.key)).toEqual(['model:2#1'])
  })
})

describe('the explain digest', () => {
  it('leaves out restricted values and the journal bodies for someone without the role', () => {
    const { text, refs } = stepDigest(record('collect') as any, workflow as any, staff)
    expect(text).not.toContain(BANK)
    expect(text).toContain('[tool:c1] tool ocr.read')
    expect(refs.has('tool:c1')).toBe(true)
    expect(refs.has('bank_account')).toBe(false)
  })

  it('keeps them for someone with the role', () => {
    const { text, refs } = stepDigest(record('collect') as any, workflow as any, finance)
    expect(text).toContain(BANK)
    expect(refs.has('bank_account')).toBe(true)
  })

  it('stays within its budget however long the journal is', () => {
    const long = record('greet')
    long.journal = Array.from({ length: 400 }, (_, i) => ({ ...journalEntry(`model:${i}`), request: { prompt: 'x'.repeat(3000) } })) as any
    const { text, refs } = stepDigest(long as any, workflow as any, staff)
    expect(text.length).toBeLessThanOrEqual(32_100)
    expect(refs.size).toBeGreaterThan(1)
  })
})
