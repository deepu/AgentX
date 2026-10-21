/**
 * Stage 4 (doc 26 §2, mocks `Site`, `Document`, `Sign`): the record page under the shell's header,
 * and signing in the page itself, rendered with the real English strings.
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
const { SignatureCard } = await import('../records/SignatureCard')
const { ChatChip, ShellTable, Tag } = await import('../project/pages/shell-ui')
const { signsDocument } = await import('../project/pages/RecordShellPage')
const S = await import('../records/sample-records')
const { DraftPanel, TestRunResult } = await import('../project/pages/PlaybookShellPage')
const { samplePlaybook } = await import('../sample-data')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const ok = async () => ({ applied: true })

describe('record page in the shell', () => {
  test("the shell's header: crumb, title, the record's facts and Export audit trail when regulated", () => {
    const html = render(
      <RecordPageView
        page={S.sampleDocumentPage}
        now={S.SAMPLE_NOW}
        actions={{ exportAudit: async () => {} }}
        shell={{ crumb: <span>Records › Documents › {S.sampleDocumentPage.title}</span> }}
      />,
    )
    expect(html).toContain('data-shell-header')
    expect(html).toContain('Records › Documents')
    expect(html).toContain(`>${S.sampleDocumentPage.title}</h1>`)
    expect(html).toContain('data-action="export-audit"')
    expect(html).toContain('Export audit trail')
    // No hero, no domain breadcrumb: the shell's header replaces them.
    expect(html).not.toContain(`<span>${S.sampleDocumentPage.domainName}</span>`)
    // The document's preview sits beside its facts at the shell's narrower page width.
    expect(html).toContain('@xl/record:grid-cols-2')
    expect(html).not.toContain('@3xl/record:grid-cols-2')
  })

  test('an unregulated record has no Export audit trail in its header', () => {
    const html = render(
      <RecordPageView page={{ ...S.sampleSitePage, regulated: false }} now={S.SAMPLE_NOW} actions={{ exportAudit: async () => {} }} shell={{ crumb: 'Records' }} />,
    )
    expect(html).not.toContain('data-action="export-audit"')
    expect(html).toContain('@3xl/record:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]')
  })

  test('the classic page keeps its hero and breadcrumbs', () => {
    const html = render(<RecordPageView page={S.sampleSitePage} now={S.SAMPLE_NOW} />)
    expect(html).not.toContain('data-shell-header')
    expect(html).toContain(S.sampleSitePage.domainName)
  })
})

describe('the Sign page', () => {
  test('signing in the page: meaning, password, what signing records, Send back and Sign', () => {
    const html = render(
      <RecordPageView
        page={S.sampleDocumentReviewPage}
        now={S.SAMPLE_NOW}
        review={{ submit: ok, inlineSignature: true }}
        shell={{ crumb: 'Waiting for you › QC and sign', subtitle: <span data-review-from>from File a document, step 3</span> }}
      />,
    )
    expect(html).toContain('data-testid="signature-card"')
    expect(html).toContain('Your signature')
    expect(html).toContain(S.sampleDocumentReview.sign!.meaning)
    expect(html).toContain('Signing records your name, the time and this meaning, and locks this version.')
    expect(html).toContain('data-action="send-back"')
    expect(html).toContain('data-action="sign"')
    expect(html).toContain('data-signature-password')
    // The dialog's "Approve and sign" button gives way to the card.
    expect(html).not.toContain('data-review-actions')
    expect(html).toContain('data-review-from')
    // A review in the shell offers no audit export: the record isn't filed yet.
    expect(html).not.toContain('data-action="export-audit"')
  })

  test('without inlineSignature the review keeps its buttons', () => {
    const html = render(<RecordPageView page={S.sampleDocumentReviewPage} now={S.SAMPLE_NOW} review={{ submit: ok }} />)
    expect(html).toContain('data-review-actions')
    expect(html).not.toContain('data-testid="signature-card"')
  })

  test('the card alone: Sign stays off until a password is typed', () => {
    const html = render(<SignatureCard meaning="Reviewed and approved" onSign={ok} onSendBack={() => {}} />)
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*data-action="sign"/)
    expect(html).toContain('Send back')
  })

  test('a signed document review is a Sign page; other waiting steps are not', () => {
    expect(signsDocument(S.sampleDocumentReviewItem)).toBe(true)
    expect(signsDocument({ ...S.sampleDocumentReviewItem, sign: undefined })).toBe(false)
    expect(signsDocument(S.sampleTableReviewItem)).toBe(false)
    expect(signsDocument(S.sampleFlagItem)).toBe(false)
    expect(signsDocument(null)).toBe(false)
  })
})

describe('shell pieces', () => {
  test('a chat chip says where the filter came from and clears', () => {
    const html = render(<ChatChip label="Activating, no CRA" from="from chat" onClear={() => {}} clearLabel="Clear the filter" />)
    expect(html).toContain('Activating, no CRA')
    expect(html).toContain('from chat')
    expect(html).toContain('aria-label="Clear the filter"')
  })

  test('tables and tags', () => {
    const html = render(<ShellTable head={['Step', 'Who']} testId="t"><tr><td>1</td></tr></ShellTable>)
    expect(html).toContain('data-testid="t"')
    expect(html).toContain('>Who</th>')
    expect(render(<Tag tone="amber">Waiting for you</Tag>)).toContain('text-amber-700')
  })
})

describe('a draft on its playbook page (D121, D122)', () => {
  const run = {
    draftId: 'd1', workflowId: 'chase-missing', at: '2026-10-21T10:00:00Z', by: 'person_a', byName: 'Anika Rao', status: 'pass' as const,
  }
  const draft = {
    id: 'd1', title: 'Copy the CRA', workflowId: 'chase-missing', playbookTitle: 'Chase missing documents', kind: 'change' as const,
    stage: 'draft' as const, createdBy: 'person_a', createdAt: '2026-10-21T09:00:00Z', updatedAt: '2026-10-21T10:00:00Z',
    pendingEdits: 0, changedFiles: 1, chatId: 'chat-1', edits: [], files: [], conflicts: [], reportStale: false, diagnostics: [],
    lastTestRun: { ...run, record: { entity: 'etmf.Site', id: 'site_1' }, detail: false, differences: [] }, testRunStale: false, testRun: 'pass' as const,
  }

  test("someone who may not change it sees no Discard or Send for review, and no part of someone else's run", () => {
    const html = render(<DraftPanel draft={{ ...draft, mayChange: false } as never} playbook={samplePlaybook} onChanged={() => {}} />)
    expect(html).not.toContain('data-action="send-for-review"')
    expect(html).not.toContain('data-action="discard-draft"')
    expect(html).toContain('test run passed')
    expect(html).not.toContain('Would send')
  })

  test('who may change it gets the buttons', () => {
    const html = render(<DraftPanel draft={{ ...draft, mayChange: true } as never} playbook={samplePlaybook} onChanged={() => {}} />)
    expect(html).toContain('data-action="send-for-review"')
    expect(html).toContain('data-action="discard-draft"')
  })

  test("a run's summary names who ran it and keeps what it saw to them; the runner's own shows the calls", () => {
    const summary = render(<TestRunResult run={draft.lastTestRun as never} />)
    expect(summary).toContain('Run by Anika Rao. What it saw is shown only to them.')
    expect(summary).toContain('>Test run<')
    const full = render(<TestRunResult run={{
      ...run, detail: true, record: { entity: 'etmf.Site', id: 'site_1', title: 'DE-104' }, differences: [], copied: { 'etmf.Site': 1 },
      trace: { state: 'wait_for_upload', status: 'active', steps: [], calls: [{ state: 'send', tool: 'etmf.reminder.create', args: { sent_to: 'coordinator@site.example' }, stubbed: true }] },
    } as never} />)
    expect(full).toContain('Test run on DE-104')
    expect(full).toContain('coordinator@site.example')
    expect(full).not.toContain('shown only to them')
  })
})
