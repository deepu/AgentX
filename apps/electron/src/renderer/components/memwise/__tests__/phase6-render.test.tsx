/**
 * Phase 6 screens rendered from the eTMF sample data with the real English strings: the record
 * page in its three layouts and in review mode, signing (wrong password, lock-out), the inbox's
 * table and diff reviews, flags and held firings, the dashboard, entities, automations, the
 * domain page, and the case's links and wait.
 */

import { describe, expect, test, beforeAll, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { setupI18n, i18n } from '@memwise/shared/i18n'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { RecordPageView } = await import('../records/RecordPageView')
const { SignForm } = await import('../records/SignDialog')
const { InboxItemView } = await import('../InboxItemView')
type InboxActions = import('../InboxItemView').InboxActions
const { DashboardView } = await import('../domains/DashboardView')
const { AutomationsView } = await import('../automations/AutomationsView')
const { EntityView, viewToState } = await import('../domains/EntitiesView')
const { DomainView, PagesOverview } = await import('../domains/DomainView')
const { CaseView } = await import('../CaseView')
const { sampleCase } = await import('../sample-data')
const S = await import('../records/sample-records')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const ok = async () => ({ applied: true })
const actions: InboxActions = { submitStep: ok, decideApproval: ok, sendEvent: ok, openCase: () => {}, openRecord: () => {}, releaseTrigger: async () => ({ applied: true, started: 300 }) }
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('record page', () => {
  test('sidebar layout: breadcrumbs, regulated mark, header fields, source badges', () => {
    const html = render(<RecordPageView page={S.sampleSitePage} now={S.SAMPLE_NOW} actions={{ openRecord: () => {} }} />)
    expect(html).toContain('data-layout="sidebar"')
    expect(html).toContain('data-mode="page"')
    expect(html).toContain('data-breadcrumbs')
    expect(html).toContain(S.sampleSitePage.domainName)
    expect(html).toContain(S.sampleSitePage.title)
    if (S.sampleSitePage.regulated) expect(html).toContain('Regulated')
    expect(html).toContain('data-source=')
    // The columns sit side by side only when the record's container is wide: they stack when narrow.
    expect(html).toContain('@3xl/record:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]')
    // A related row's date reads as a date, by its declared type.
    expect(html).toContain('Oct 2, 2026')
    expect(html).not.toContain('2026-10-02')
  })

  test('single and split layouts', () => {
    expect(render(<RecordPageView page={S.sampleStudyPage} now={S.SAMPLE_NOW} />)).toContain('data-layout="single"')
    const split = render(<RecordPageView page={S.sampleDocumentPage} now={S.SAMPLE_NOW} />)
    expect(split).toContain('data-layout="split"')
    expect(split).toContain('@3xl/record:grid-cols-2')
    // An open flag shows as an alert, and history names a signature changed since signing.
    expect(split).toContain(`data-flag="${S.sampleDocumentPage.flags[0]!.id}"`)
    // `related: [versions, signatures]` draws the record's history, once.
    expect(count(split, 'data-signatures')).toBe(1)
    expect(count(split, 'data-versions')).toBe(1)
    expect(split).toContain('data-changed-since')
  })

  test('review mode: proposed values beside the document, checks, send back and approve and sign', () => {
    const html = render(
      <RecordPageView
        page={S.sampleDocumentReviewPage}
        now={S.SAMPLE_NOW}
        missingQuotes={[3]}
        review={{ submit: ok, roleTitle: r => r }}
      />,
    )
    expect(html).toContain('data-mode="review"')
    expect(html).toContain('Proposed values')
    for (const p of S.sampleDocumentReview.proposed) expect(html).toContain(`data-proposed-field="${p.field}"`)
    expect(html).toContain('Send back')
    expect(html).toContain('Approve and sign')
    expect(html).toContain('data-checks')
    expect(html).toContain('Check this')
    // A proposed reference reads as its record's title, not its id.
    expect(html).toContain('DE-104 · Berlin')
    expect(html).not.toContain('site_de104')
    // The engine's checks on the agent's answer fold into one line; the domain's stay.
    expect(html).toContain('data-form-checks="2"')
    expect(html).not.toContain('writes.site')
    expect(html).toContain('Signed and dated (page 2)')
  })

  test('the agent reasoning shared by every proposed value is shown once', () => {
    const because = 'The email names site US-012.'
    const proposed = S.sampleDocumentReview.proposed.map(p => ({ ...p, provenance: { kind: 'judgement' as const, at: '2026-10-20T08:09:00Z', stepRunId: 'sr', rationale: because } }))
    const page = { ...S.sampleDocumentReviewPage, review: { ...S.sampleDocumentReview, proposed } }
    const html = render(<RecordPageView page={page} now={S.SAMPLE_NOW} review={{ submit: ok }} />)
    expect(html).toContain('data-agent-rationale')
    expect(count(html, because)).toBe(1)
  })

  test('review in a row shows where you are and the keys', () => {
    const html = render(<RecordPageView page={S.sampleDocumentReviewPage} now={S.SAMPLE_NOW} review={{ submit: ok, queue: { position: 2, total: 5 } }} />)
    expect(html).toContain('data-review-queue')
    expect(html).toContain('2 of 5')
    expect(html).toContain('a approve · s send back · j next · k previous')
  })
})

describe('signing', () => {
  const props = { name: 'Priya Shah', role: 'TMF specialist', meaning: 'Reviewed and approved for filing in the TMF', onSign: ok, onCancel: () => {} }

  test('says who signs and what it means', () => {
    const html = render(<SignForm {...props} />)
    expect(html).toContain('Signing as Priya Shah, TMF specialist')
    expect(html).toContain('Meaning: Reviewed and approved for filing in the TMF')
    expect(html).toContain('type="password"')
  })

  test('a wrong password says so plainly', () => {
    const html = render(<SignForm {...props} initialResult={{ applied: false, code: 'submit.signature-failed' }} />)
    expect(html).toContain('data-sign-error="submit.signature-failed"')
    expect(html).toContain('That password is not right, so nothing was signed.')
  })

  test('a lock-out says when to try again and disables signing', () => {
    const html = render(<SignForm {...props} initialResult={{ applied: false, code: 'submit.locked', retryAfter: '2026-10-20T10:30:00Z' }} />)
    expect(html).toMatch(/Too many attempts\. Try again after [^<]+\./)
    expect(html).toMatch(/<input[^>]*type="password"[^>]*disabled=""/)
  })
})

describe('inbox: Phase 6 items', () => {
  test('a table review: rows with reasons, accept all at 90%, approval waits for every row', () => {
    const html = render(<InboxItemView item={S.sampleTableReviewItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-table-review="documents_to_update"')
    expect(count(html, 'data-row=')).toBe(4)
    expect(html).toContain('Accept 2 at 90% or higher')
    expect(html).toContain('4 rows still to decide')
    expect(html).toContain('Why: New safety data in section 6.')
  })

  test('a diff review', () => {
    const html = render(<InboxItemView item={S.sampleDiffReviewItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-diff-review')
    expect(html).toContain('What changes')
    expect(html).toContain('Dr. Lena Vogel-Hartmann')
  })

  test('a flag opens its record', () => {
    const html = render(<InboxItemView item={S.sampleFlagItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-flag=')
    expect(html).toContain(S.sampleFlagItem.flag.message.replace(/"/g, '&quot;'))
    expect(html).toContain('Open the record')
  })

  test('held firings: start or discard', () => {
    const html = render(<InboxItemView item={S.sampleTriggerHoldItem} actions={actions} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-trigger-hold="watch-expiries:0"')
    expect(html).toContain('300 firings held since')
    expect(html).toContain('Start 300')
    expect(html).toContain('Discard')
  })
})

describe('dashboard, entities, automations, domains', () => {
  test('the dashboard: numbers against targets and the heatmap legend', () => {
    const html = render(<DashboardView dashboard={S.sampleDashboard} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-kpis')
    expect(html).toContain('data-heatmap')
    expect(html).toContain('95% or more')
    expect(html).toContain('Under 70%')
    expect(html).toMatch(/data-heat="fair">70%</)
    expect(html).toMatch(/Computed /)
  })

  test('entity records: views, filter, table; a filter error in plain words', () => {
    const base = { domain: S.sampleDomains[0]!, type: S.sampleSiteType, onTab: () => {}, views: S.sampleViews, state: viewToState(null), onState: () => {} }
    const html = render(<EntityView {...base} tab="records" result={S.sampleSitesQuery} onSaveView={async v => ({ ...v, domain: 'etmf', personal: true })} />)
    expect(html).toContain('data-records-table')
    // A reference reads as the record's title, not its id.
    expect(html).toContain('AST-301')
    expect(html).not.toContain('stud_ast301')
    // The kernel keeps a row's status beside its values, not in them: the column still shows it.
    const bare = { ...S.sampleSitesQuery, rows: S.sampleSitesQuery.rows.map(({ values: { status: _s, ...values }, ...r }) => ({ ...r, values })) }
    expect(count(render(<EntityView {...base} tab="records" result={bare} />), 'lucide-circle-dot')).toBe(bare.rows.length)
    // Grouped, the table sets its rows under each group's heading.
    const grouped = render(<EntityView {...base} tab="records" result={{ ...S.sampleSitesQuery, groups: undefined }} state={{ ...viewToState(null), group: 'study' }} />)
    expect(grouped).toContain('data-table-group="stud_ast301"')
    expect(grouped).toMatch(/data-table-group="stud_ast301"[^]*?>AST-301</)
    expect(html).toContain('All records')
    expect(html).toContain('Save as my view')
    const broken = render(<EntityView {...base} tab="records" result={null} error="Unexpected '!' at position 9." state={{ ...viewToState(null), filter: 'status !! 1' }} />)
    expect(broken).toContain('data-filter-error')
    expect(broken).toContain('That filter could not be read')
    expect(broken).toContain('Unexpected &#x27;!&#x27; at position 9.')
  })

  test('entity definition: fields, where they come from, who sees them', () => {
    const html = render(<EntityView domain={S.sampleDomains[0]!} type={S.sampleSiteType} tab="definition" onTab={() => {}} views={[]} state={viewToState(null)} onState={() => {}} result={null} />)
    expect(html).toContain('data-definition-fields')
    expect(html).toContain('Comes from')
    expect(html).toContain('Who sees it')
  })

  test('automations: triggers with held firings', () => {
    const html = render(<AutomationsView triggers={S.sampleTriggers} domains={S.sampleDomains} now={S.SAMPLE_NOW} release={async () => ({ applied: true, started: 1 })} />)
    expect(html).toContain('data-automations')
    expect(count(html, 'data-trigger=')).toBe(S.sampleTriggers.length)
    if (S.sampleTriggers.some(tr => tr.held > 0)) expect(html).toContain('data-held')
  })

  test('a regulated domain says what that means; the pages overview lists every domain', () => {
    const etmf = S.sampleDomains.find(d => d.regulated)!
    const html = render(<DomainView domain={etmf} />)
    expect(html).toContain('data-regulated-note')
    expect(html).toContain('House rules')
    const pages = render(<PagesOverview domains={S.sampleDomains} workspacePages={[{ slug: 'welcome', name: 'Welcome' }]} />)
    expect(pages).toContain('Workspace pages')
    expect(pages).toContain('Welcome')
  })
})

describe('case view', () => {
  test('linked cases and what it waits for', () => {
    const html = render(<CaseView kase={S.withPhase6Case(sampleCase)} now={S.SAMPLE_NOW} />)
    expect(html).toContain('data-case-links')
    expect(html).toContain('Started by')
    expect(html).toContain('File a TMF document: vogel-cv.pdf')
    expect(html).toContain('data-waiting="waits"')
    expect(html).toContain('start_up_pack = 100')
    expect(html).toContain('Now: Start up pack: 90')
  })

  test('a case without them shows neither panel', () => {
    const html = render(<CaseView kase={sampleCase} now={S.SAMPLE_NOW} />)
    expect(html).not.toContain('data-case-links')
    expect(html).not.toContain('data-waiting')
  })
})
