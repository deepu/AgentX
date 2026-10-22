/**
 * Stage 4 (doc 26 §2, §5): the model behind the playbook, run and record list pages in the
 * project shell, and the records list's chat anchor.
 */

import { describe, expect, test } from 'bun:test'
import type { MwDraftSummary, MwTransitionOption } from '@memwise/shared/protocol'
import { samplePlaybook, sampleCase, sampleCaseSummaries } from '../sample-data'
import {
  boardColumns, combineFilters, draftChangeCount, hiddenByFilters, dropDecision, listColumns, numberedSteps, pageDraft, recordsFence, runTimeline, runWhere,
  runsThisWeek, stepNumber, stepRows, whoDoes,
} from '../project/pages/every-page-model'
import { chatAnchorFor, sidebarRecordCounts } from '../project/project-model'

const DAY = 86_400_000

describe('playbook page', () => {
  test('steps are the states with a step, numbered in reading order', () => {
    const steps = numberedSteps(samplePlaybook)
    expect(steps.map(s => [s.n, s.state])).toEqual([[1, 'fill'], [2, 'check'], [3, 'verify'], [4, 'onboard']])
    expect(stepNumber(samplePlaybook, 'verify')).toBe(3)
    expect(stepNumber(samplePlaybook, 'needs_person')).toBeUndefined()
  })

  test('who does a step: system, agent, outside person, you, or the role', () => {
    expect(whoDoes(samplePlaybook.steps.onboard!, [])).toEqual({ kind: 'system' })
    expect(whoDoes(samplePlaybook.steps.check!, [])).toEqual({ kind: 'agent' })
    expect(whoDoes(samplePlaybook.steps.fill!, [])).toEqual({ kind: 'external' })
    expect(whoDoes(samplePlaybook.steps.verify!, ['manager'])).toEqual({ kind: 'you' })
    expect(whoDoes(samplePlaybook.steps.verify!, ['staff'])).toEqual({ kind: 'role', role: 'manager' })
  })

  test("this week's runs: the ones still going first, then the ones finished in the last week", () => {
    const now = Date.parse(sampleCaseSummaries[0]!.updatedAt) + 2 * DAY
    const old = { ...sampleCaseSummaries[2]!, caseId: 'case_old', status: 'done' as const, updatedAt: new Date(now - 10 * DAY).toISOString() }
    const recent = { ...sampleCaseSummaries[2]!, caseId: 'case_recent', status: 'done' as const, updatedAt: new Date(now - DAY).toISOString() }
    const other = { ...sampleCaseSummaries[0]!, caseId: 'case_other', workflowId: 'other' }
    const runs = runsThisWeek([old, recent, other, ...sampleCaseSummaries.slice(0, 2)], 'client-intake', now)
    expect(runs.map(r => r.caseId)).toEqual(['case_acme', 'case_menon', 'case_recent'])
    expect(runWhere(sampleCaseSummaries[0]!, samplePlaybook)).toEqual({ kind: 'step', n: 3, title: 'Manager approves onboarding' })
    expect(runWhere({ ...sampleCaseSummaries[0]!, status: 'done' }, samplePlaybook)).toEqual({ kind: 'done' })
    expect(runWhere(sampleCaseSummaries[2]!, samplePlaybook)).toEqual({ kind: 'state', title: 'Needs a person' })
  })

  test("a draft's changed step shows the words it adds to the live title", () => {
    const draftPlaybook = {
      ...samplePlaybook,
      steps: { ...samplePlaybook.steps, verify: { ...samplePlaybook.steps.verify!, title: 'Manager approves onboarding, and copies the CRA' } },
    }
    const structure = {
      steps: { verify: { change: 'changed' as const, parts: ['instructions', 'title'] } },
      caseFields: { added: [], removed: [], changed: [] }, roles: { added: [], removed: [] }, transitions: [],
    }
    const rows = stepRows(samplePlaybook, { playbook: draftPlaybook, structure } as never)
    const verify = rows.find(r => r.state === 'verify')!
    expect(verify.change).toEqual({ kind: 'changed', title: 'Manager approves onboarding, and copies the CRA', added: 'and copies the CRA', parts: ['instructions', 'title'] })
    expect(rows.filter(r => r.change).length).toBe(1)
    expect(draftChangeCount({ structure, changedFiles: 3 } as never)).toBe(1)
    expect(draftChangeCount({ changedFiles: 2 } as never)).toBe(2)
  })

  test("the page's draft: its chat's draft first, never a published or discarded one", () => {
    const d = (id: string, extra: Partial<MwDraftSummary>): MwDraftSummary => ({
      id, kind: 'change', workflowId: 'client-intake', stage: 'editing', updatedAt: '2026-10-01T00:00:00Z', ...extra,
    } as MwDraftSummary)
    const drafts = [
      d('old_chat', { chatId: 'chat_1', updatedAt: '2026-10-01T00:00:00Z' }),
      d('newer', { updatedAt: '2026-10-05T00:00:00Z' }),
      d('done', { stage: 'published', chatId: 'chat_2', updatedAt: '2026-10-09T00:00:00Z' }),
      d('other', { workflowId: 'other', chatId: 'chat_3' }),
    ]
    expect(pageDraft(drafts, 'client-intake')?.id).toBe('old_chat')
    expect(pageDraft(drafts.slice(1), 'client-intake')?.id).toBe('newer')
    expect(pageDraft([], 'client-intake')).toBeUndefined()
  })
})

describe('run page', () => {
  test('the timeline: done steps, the waiting one open, the rest next', () => {
    const rows = runTimeline(sampleCase, samplePlaybook)
    expect(rows.map(r => [r.n, r.state, r.status])).toEqual([[1, 'fill', 'done'], [2, 'check', 'done'], [3, 'verify', 'waiting'], [4, 'onboard', 'next']])
    expect(rows[2]!.run?.stepRunId).toBe('sr_verify_3')
  })

  test('a finished run has nothing waiting', () => {
    const kase = {
      ...sampleCase,
      status: 'done' as const,
      state: 'end',
      timeline: [...sampleCase.timeline.slice(0, 2), { ...sampleCase.timeline[2]!, status: 'completed' as const, outcome: 'approved' }],
      path: ['fill', 'check', 'verify', 'onboard'],
    }
    const rows = runTimeline(kase, samplePlaybook)
    expect(rows.some(r => r.status === 'waiting')).toBe(false)
    expect(rows.find(r => r.state === 'onboard')!.status).toBe('skipped')
  })
})

describe('record lists', () => {
  const tr = (to: string, extra: Partial<MwTransitionOption> = {}): MwTransitionOption => ({ name: `to_${to}`, label: to, to, allowed: true, ...extra })

  test('cards by lifecycle state, in its order, with the totals', () => {
    const rows = [{ id: 'a', status: 'draft' }, { id: 'b', status: 'filed' }, { id: 'c', status: 'draft' }, { id: 'd', status: 'gone' }]
    const cols = boardColumns(['draft', 'in_review', 'filed'], rows, 1)
    expect(cols.map(c => [c.state, c.total, c.rows.map(r => r.id)])).toEqual([['draft', 2, ['a']], ['in_review', 0, []], ['filed', 1, ['b']]])
  })

  test('a drop is a move, a signature, or a short refusal', () => {
    expect(dropDecision('draft', 'draft', [])).toEqual({ kind: 'same' })
    expect(dropDecision('draft', 'in_review', [tr('in_review')])).toMatchObject({ kind: 'move', transition: { name: 'to_in_review' } })
    expect(dropDecision('in_review', 'filed', [tr('filed', { signed: true, allowed: false })])).toMatchObject({ kind: 'sign' })
    expect(dropDecision('draft', 'filed', [tr('in_review')])).toEqual({ kind: 'refuse', reason: 'no-move' })
    expect(dropDecision('draft', 'qc', [tr('qc', { allowed: false, automatic: true })])).toMatchObject({ kind: 'refuse', reason: 'automatic' })
    expect(dropDecision('draft', 'qc', [tr('qc', { allowed: false, reason: 'Only a QC reviewer can' })])).toMatchObject({ kind: 'refuse', reason: 'not-allowed', message: 'Only a QC reviewer can' })
  })

  test("the list's columns: calculated values first, then fields, then references; or the chat's", () => {
    const result = { columns: [
      { name: 'id', label: 'Id', type: 'Text' }, { name: 'status', label: 'Status', type: 'Text' },
      { name: 'study', label: 'Study', type: 'Ref<Study>' }, { name: 'city', label: 'City', type: 'Text' },
      { name: 'complete', label: 'Complete', type: 'Percent', calculated: true }, { name: 'pi', label: 'PI', type: 'Text' },
    ] } as never
    expect(listColumns(result, 3).map(c => c.name)).toEqual(['complete', 'city', 'pi'])
    expect(listColumns(result, 3, ['study', 'nope', 'city']).map(c => c.name)).toEqual(['study', 'city'])
  })

  test('a chat filter saved as a page is a records block', () => {
    const fence = recordsFence({ entity: 'etmf.site', filter: 'status = "activating"', title: 'Sites: activating', sort: [{ field: 'name', desc: true }] })
    expect(fence.startsWith('```records\n')).toBe(true)
    expect(fence.endsWith('\n```')).toBe(true)
    const spec = JSON.parse(fence.split('\n').slice(1, -1).join('\n'))
    expect(spec).toEqual({ entity: 'etmf.site', filter: 'status = "activating"', sort: ['-name'], limit: 50, title: 'Sites: activating' })
  })

  test("a records list's chat is anchored to the record type", () => {
    expect(chatAnchorFor('etmf', { type: 'records', entity: 'etmf.site' })).toEqual({ kind: 'records', id: 'etmf.site' })
  })
})

describe('records list filters', () => {
  test("a saved view's filter, the typed one and the chat's all apply", () => {
    expect(combineFilters(undefined, ' ', null)).toBeUndefined()
    expect(combineFilters("status = 'open'")).toBe("status = 'open'")
    expect(combineFilters("status = 'open'", '', 'missing_documents > 0 or reminders_sent > 2'))
      .toBe("(status = 'open') and (missing_documents > 0 or reminders_sent > 2)")
  })

  test('what the filters hide is counted against the records the person sees, not the type count', () => {
    expect(hiddenByFilters(3, 2)).toBe(1)
    expect(hiddenByFilters(2, 2)).toBe(0)
    expect(hiddenByFilters(undefined, 2)).toBe(0)
    expect(hiddenByFilters(1, 4)).toBe(0)
  })
})

describe('in a project (Stage 3)', () => {
  test("a study's playbook page shows its runs and the drafts of its own copy", () => {
    const now = Date.parse(sampleCaseSummaries[0]!.updatedAt) + DAY
    const mine = { ...sampleCaseSummaries[0]!, caseId: 'case_301', project: 'mw301' }
    const theirs = { ...sampleCaseSummaries[0]!, caseId: 'case_207', project: 'mw207' }
    expect(runsThisWeek([mine, theirs], 'client-intake', now, 'mw301').map(r => r.caseId)).toEqual(['case_301'])
    expect(runsThisWeek([mine, theirs], 'client-intake', now).map(r => r.caseId)).toEqual(['case_301', 'case_207'])
    const d = (id: string, project?: string): MwDraftSummary => ({
      id, kind: 'change', workflowId: 'client-intake', stage: 'editing', updatedAt: '2026-10-01T00:00:00Z', ...(project ? { project } : {}),
    } as MwDraftSummary)
    const drafts = [d('template'), d('d301', 'mw301'), d('d207', 'mw207')]
    expect(pageDraft(drafts, 'client-intake', 'mw301')?.id).toBe('d301')
    expect(pageDraft(drafts, 'client-intake')?.id).toBe('template')
    expect(pageDraft([d('d207', 'mw207')], 'client-intake', 'mw301')).toBeUndefined()
  })

  test("a study's playbook and list chats are that study's", () => {
    expect(chatAnchorFor('mw301', { type: 'playbook', workflowId: 'chase-missing' }, null, undefined, 'mw301')).toEqual({ kind: 'workflow', id: 'chase-missing', project: 'mw301' })
    expect(chatAnchorFor('mw301', { type: 'records', entity: 'etmf.Site' }, null, undefined, 'mw301')).toEqual({ kind: 'records', id: 'etmf.Site', project: 'mw301' })
    expect(chatAnchorFor('etmf', { type: 'records', entity: 'etmf.Site' })).toEqual({ kind: 'records', id: 'etmf.Site' })
  })

  test("the sidebar's RECORDS counts are the study's own, never the app's across studies", () => {
    const types = [{ key: 'edc.Site', title: 'Sites', count: 18 }, { key: 'edc.Study', title: 'Studies', count: 2 }]
    expect(sidebarRecordCounts({ stored: true }, types, { 'edc.Site': 6, 'edc.Study': 1 })).toEqual([
      { key: 'edc.Site', title: 'Sites', count: 6 }, { key: 'edc.Study', title: 'Studies', count: 1 },
    ])
    // Still reading: no count rather than every study's.
    expect(sidebarRecordCounts({ stored: true }, types, undefined)).toEqual([{ key: 'edc.Site', title: 'Sites' }, { key: 'edc.Study', title: 'Studies' }])
    expect(sidebarRecordCounts({ stored: true }, types, { 'edc.Site': 6 })[1]).toEqual({ key: 'edc.Study', title: 'Studies' })
    // One project per domain (no stored projects): the domain's counts are the project's.
    expect(sidebarRecordCounts({ stored: false }, types, undefined)).toEqual(types)
  })
})
