/**
 * Phase 6 models: record values and their sources, layouts, lifecycles, review drafts and the
 * queue keys, table and diff reviews, the dashboard, the sidebar tree, and quote matching in a
 * PDF's text layer. Run with the real English strings.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'
import type { MwDashboardBlock, MwInboxItem, MwTransitionOption } from '@memwise/shared/protocol'
import {
  acceptAllAbove, areaBlocks, chartData, changedReviewFields, confidenceLabel, detailFields, diffRows, fieldSourceLabel,
  fieldSourceTone, firstDocumentReview, headerFields, heatBucket, initialReviewDraft, isReviewItem, kpiBelowTarget, kpiValue,
  layoutColumns, lifecycleSteps, lockedMessage, missingReviewFields, nestTree, queueKeyAction, queueNeighbour, retentionLabel,
  reviewOutcomes, sameKindItems, statusLabel, tableColumns, tableRows, tableSubmission, transitionBlockedReason, transitionLabel,
  treeNodeKey,
} from '../records/record-model'
import { findQuotes, highlightItemHtml, rangesByItem } from '../records/quote-highlight'
import {
  sampleDefaultDomains, sampleDiffReviewItem, sampleDocumentReview, sampleDocumentReviewItem, sampleDocumentText, sampleDomains,
  sampleSecondReviewItem, sampleSitePage, sampleStudyPage, sampleTableReviewItem, sampleTreeChildren, sampleTreeTop,
} from '../records/sample-records'

// The screens' modules pull in the PDF viewer: mock pdf.js before importing them.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { diffSides } = await import('../records/DiffReview')
const { needsSignature } = await import('../records/SignGate')
const { showDomainsSection, needsDomainFilter } = await import('../domains/DomainsSidebar')
const { inboxItemDomain } = await import('../domains/DomainFilter')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})
const t = ((key: string, opts?: Record<string, unknown>) => i18n.t(key, opts)) as Parameters<typeof fieldSourceLabel>[1]

describe('record values and sources', () => {
  test('a status in words', () => {
    expect(statusLabel('in_qc')).toBe('In QC')
    expect(statusLabel(undefined)).toBe('')
  })

  test('where a value came from, in plain words', () => {
    expect(fieldSourceLabel({ kind: 'domain' }, t)).toBe('MemWise')
    expect(fieldSourceLabel({ kind: 'calculated' }, t)).toBe('Calculated')
    expect(fieldSourceLabel({ kind: 'link', domain: 'safety', domainName: 'Safety', entity: 'safety.case' }, t)).toBe('From Safety')
    expect(fieldSourceLabel({ kind: 'step', label: 'Activate a site' } as never, t)).toBe('Agent, from Activate a site')
    expect(fieldSourceLabel({ kind: 'person', name: 'Priya Shah' } as never, t)).toBe('Priya Shah')
    expect(fieldSourceTone({ kind: 'calculated' })).toBe('calculated')
    expect(fieldSourceTone({ kind: 'step' } as never)).toBe('agent')
  })

  test('retention in years when it divides, else days', () => {
    expect(retentionLabel(9125, t)).toBe('Kept 25 years')
    expect(retentionLabel(30, t)).toBe('Kept 30 days')
    expect(retentionLabel(undefined, t)).toBeUndefined()
  })

  test('a lock-out says when to try again', () => {
    expect(lockedMessage(undefined, t)).toBe('Too many attempts. Try again later.')
    expect(lockedMessage('2026-10-20T10:30:00Z', t, 'en')).toMatch(/^Too many attempts\. Try again after .+\.$/)
  })
})

describe('layouts and blocks', () => {
  test('columns per layout, and details for fields no block shows', () => {
    expect(layoutColumns(sampleStudyPage.layout).columns).toHaveLength(1)
    expect(layoutColumns(sampleSitePage.layout).columns).toHaveLength(2)
    const shown = new Set([...headerFields(sampleSitePage), ...detailFields(sampleSitePage)].map(f => f.name))
    expect(shown.size).toBeGreaterThan(0)
    const areas = layoutColumns(sampleSitePage.layout).columns.flatMap(a => areaBlocks(sampleSitePage.layout, a))
    expect(areas.length).toBeGreaterThan(0)
  })

  test('the lifecycle row marks done, current and to do', () => {
    expect(lifecycleSteps(['selected', 'activating', 'open'], 'activating').map(s => s.state)).toEqual(['done', 'current', 'todo'])
    expect(lifecycleSteps(['a', 'b'], undefined).map(s => s.state)).toEqual(['todo', 'todo'])
  })

  test('a blocked move says why', () => {
    const tr: MwTransitionOption = { name: 'open', to: 'open', allowed: false, guard: { condition: 'start_up_pack = 100', holds: false } } as never
    expect(transitionLabel(tr, t)).toBe('Move to Open')
    expect(transitionBlockedReason(tr, t)).toBe('Not yet: start_up_pack = 100')
    expect(transitionBlockedReason({ ...tr, guard: undefined }, t)).toBe('Your role cannot make this move.')
    expect(transitionBlockedReason({ ...tr, reason: 'Needs the IRB letter' }, t)).toBe('Needs the IRB letter')
    expect(transitionBlockedReason({ ...tr, allowed: true }, t)).toBeUndefined()
  })

  test('a chart counts related rows by status', () => {
    const chart = Object.values(sampleSitePage.layout).flat().find((b): b is Extract<typeof b, { kind: 'chart' }> => !!b && typeof b === 'object' && 'kind' in b && b.kind === 'chart')
    if (chart) {
      const bars = chartData(sampleSitePage, chart)
      expect(bars.reduce((n, b) => n + b.value, 0)).toBeGreaterThan(0)
    }
    expect(chartData(sampleSitePage, { kind: 'chart', of: 'nothing_here', chart: 'bar' } as never)).toEqual([])
  })
})

describe('document review', () => {
  test('the draft starts from the proposed values; edits and blanks are found', () => {
    const draft = initialReviewDraft(sampleDocumentReview)
    expect(changedReviewFields(sampleDocumentReview, draft)).toEqual([])
    expect(missingReviewFields(sampleDocumentReview, draft)).toEqual([])
    const edited = { ...draft, document_date: '', version: '2026 rev. C' }
    expect(changedReviewFields(sampleDocumentReview, edited)).toEqual(['document_date', 'version'])
    expect(missingReviewFields(sampleDocumentReview, edited)).toEqual(['document_date'])
  })

  test('outcomes, confidence and signing', () => {
    expect(reviewOutcomes(['approved', 'sent_back'])).toEqual({ approve: 'approved', sendBack: 'sent_back' })
    expect(confidenceLabel(0.95, t)).toBe('Sure')
    expect(confidenceLabel(0.62, t)).toBe('Unsure')
    expect(needsSignature({ meaning: 'x' }, 'approved')).toBe(true)
    expect(needsSignature({ meaning: 'x' }, 'sent_back')).toBe(false)
    expect(needsSignature(undefined, 'approved')).toBe(false)
  })

  test('queue keys only when no field has the focus', () => {
    expect(queueKeyAction({ key: 'a' })).toBe('approve')
    expect(queueKeyAction({ key: 's' })).toBe('sendBack')
    expect(queueKeyAction({ key: 'j' })).toBe('next')
    expect(queueKeyAction({ key: 'k' })).toBe('previous')
    expect(queueKeyAction({ key: 'a', target: { tagName: 'TEXTAREA' } })).toBeNull()
    expect(queueKeyAction({ key: 'a', target: { tagName: 'DIV', isContentEditable: true } })).toBeNull()
    expect(queueKeyAction({ key: 'a', metaKey: true })).toBeNull()
    expect(queueKeyAction({ key: 'x' })).toBeNull()
  })

  test('the queue: same review kind, playbook and step', () => {
    const inbox: MwInboxItem[] = [sampleTableReviewItem, sampleDocumentReviewItem, sampleSecondReviewItem, sampleDiffReviewItem]
    expect(isReviewItem(sampleDocumentReviewItem, 'document')).toBe(true)
    expect(isReviewItem(sampleTableReviewItem, 'document')).toBe(false)
    const first = firstDocumentReview(inbox)!
    expect(first.review?.kind).toBe('document')
    const same = sameKindItems(inbox, first)
    expect(same.map(i => i.id).sort()).toEqual([sampleDocumentReviewItem.id, sampleSecondReviewItem.id].sort())
    const next = queueNeighbour(inbox, same[0]!)
    expect(next?.id).toBe(same[1]!.id)
    // After a decision the current item is gone: the first one left.
    expect(queueNeighbour(inbox.filter(i => i.id !== same[0]!.id), same[0]!)?.id).toBe(same[1]!.id)
  })
})

describe('table and diff review', () => {
  const rows = tableRows(sampleTableReviewItem.prefill.documents_to_update)

  test('rows with confidence and why; columns without them', () => {
    expect(rows).toHaveLength(4)
    expect(rows[0]!.confidence).toBe(0.96)
    expect(rows[3]!.why).toContain('optional')
    expect(tableColumns(rows)).toEqual(['document', 'site'])
  })

  test('accept all at 90% or higher, then submit accepted rows with edits', () => {
    const decided = acceptAllAbove(rows, {})
    expect(decided).toEqual({ 0: 'accept', 1: 'accept' })
    expect(tableSubmission(rows, decided, {}).pending).toBe(2)
    const all = { ...decided, 2: 'accept' as const, 3: 'reject' as const }
    const { pending, values } = tableSubmission(rows, all, { 2: { site: 'DE-104' } })
    expect(pending).toBe(0)
    expect(values).toHaveLength(3)
    expect(values[2]).toMatchObject({ document: 'Pharmacy manual', site: 'DE-104' })
  })

  test('diff rows put changes first', () => {
    const d = diffRows({ a: 1, b: 'x' }, { a: 1, b: 'y', c: true })
    expect(d.map(r => [r.field, r.changed])).toEqual([['b', true], ['c', true], ['a', false]])
  })

  test('a form step diffs its prefill against what it read', () => {
    const item = { ...sampleTableReviewItem, prefill: { pi: { value: 'New', provenance: { kind: 'input', at: '' } } }, context: { pi: { value: 'Old', provenance: { kind: 'input', at: '' } } } } as never
    expect(diffSides(item)).toEqual({ before: { pi: 'Old' }, after: { pi: 'New' } })
    expect(diffSides(sampleDiffReviewItem).after).toMatchObject({ principal_investigator: 'Dr. Lena Vogel-Hartmann' })
  })
})

describe('dashboard', () => {
  const kpi = (value: number | null, target?: number): Extract<MwDashboardBlock, { kind: 'kpi' }> => ({ kind: 'kpi', title: 'Complete', value, format: 'percent', target } as never)

  test('heat buckets', () => {
    expect([100, 95, 94, 85, 84, 70, 69, null].map(v => heatBucket(v))).toEqual(['top', 'top', 'good', 'good', 'fair', 'fair', 'low', 'none'])
  })

  test('numbers against their targets', () => {
    expect(kpiValue(kpi(87.5), t, 'en')).toBe('87.5%')
    expect(kpiValue(kpi(null), t)).toBe('No value')
    expect(kpiBelowTarget(kpi(87, 95))).toBe(true)
    expect(kpiBelowTarget(kpi(97, 95))).toBe(false)
    expect(kpiBelowTarget(kpi(87))).toBe(false)
  })
})

describe('the sidebar tree and domains', () => {
  test('records after a group without a view nest under it; a group with a view stands alone', () => {
    const level = nestTree(sampleTreeChildren['etmf.study:study_ast301']!)
    const sites = level.find(e => e.node.kind === 'group' && e.node.entity === 'etmf.site') as { children: unknown[] }
    expect(sites.children).toHaveLength(7)
    const docs = level.find(e => e.node.kind === 'group' && e.node.entity === 'etmf.document') as { children: unknown[] }
    expect(docs.children).toEqual([])
    expect(level.filter(e => e.node.kind === 'page')).toHaveLength(2)
    expect(nestTree(sampleTreeTop)).toHaveLength(3)
  })

  test('stable node keys', () => {
    expect(treeNodeKey(sampleTreeTop[0]!)).toBe('r:etmf.sponsor:sponsor_aster')
    expect(treeNodeKey({ kind: 'page', pageId: 'tmf-health', title: '', params: { study: 's' } })).toBe('p:tmf-health:{"study":"s"}')
  })

  test('a project with only the default domain stays calm', () => {
    expect(showDomainsSection(sampleDefaultDomains)).toBe(false)
    expect(showDomainsSection(sampleDomains)).toBe(true)
    expect(showDomainsSection(null)).toBe(false)
    expect(needsDomainFilter(sampleDefaultDomains, ['domain', undefined])).toBe(false)
    expect(needsDomainFilter(sampleDomains, ['etmf', 'etmf'])).toBe(false)
    expect(needsDomainFilter(sampleDomains, ['etmf', 'safety'])).toBe(true)
  })

  test("an inbox item's domain: its own, else its playbook's", () => {
    expect(inboxItemDomain(sampleTableReviewItem)).toBe('etmf')
    const bare = { ...sampleTableReviewItem, domain: undefined } as never
    expect(inboxItemDomain(bare, [{ id: 'apply-amendment', domain: 'safety' } as never])).toBe('safety')
  })
})

describe('quote highlights', () => {
  test('quotes split across text items are found, on their stated page first', () => {
    const { matches, missing } = findQuotes(sampleDocumentText, [
      { quote: 'Curriculum vitae', page: 1 },
      { quote: '14 Mar 2026', page: 2 },
      { quote: 'dr. MED. lena   vogel' },
      { quote: 'Version 2026 rev. B', page: 2 },
    ])
    expect(missing).toEqual([3])
    const date = matches.find(m => m.quote === 1)!
    expect(date.page).toBe(2)
    expect(date.ranges.map(r => r.item)).toEqual([3, 4])
    expect(matches.find(m => m.quote === 2)!.page).toBe(1)
  })

  test('highlighted html escapes the text and marks the active quote', () => {
    const { matches } = findQuotes([['a <b> 14 Mar', ' 2026']], [{ quote: '14 Mar 2026' }])
    const ranges = rangesByItem(matches, 1)
    const html = highlightItemHtml('a <b> 14 Mar', ranges.get(0), 0)
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<mark class="mw-quote mw-quote-active" data-quote="0">14 Mar</mark>')
    expect(highlightItemHtml(' 2026', ranges.get(1), null)).toContain('<mark class="mw-quote" data-quote="0">2026</mark>')
  })
})
