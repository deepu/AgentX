/**
 * Pages screens (docs/memwise/26-projects-and-pages.md §4) rendered with the real English strings:
 * a draft page with "Keep this page", a kept page with its refresh pill, its waiting change and
 * "Changed from chat · Undo", a parent summing its sub-pages, "Review an answer change", Home's
 * "What changed this week" and "Pages kept up to date", and the same page blocks in a chat message.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { i18n, setupI18n } from '@memwise/shared/i18n'
import type { MwPage, MwPageChange, MwPageSummary } from '@memwise/shared/protocol'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider, Markdown } = await import('@memwise/ui')
const P = await import('../pages')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

const summary = (over: Partial<MwPageSummary> & { id: string; title: string }): MwPageSummary => ({
  projectId: 'literature', status: 'kept', headline: '', pinned: false, sumsChildren: false, version: 1, updatedAt: '2026-06-01T09:00:00Z', ...over,
})

const PAGES: MwPageSummary[] = [
  summary({ id: 'glp1', title: 'GLP-1', sumsChildren: true, headline: 'Oral GLP-1s work for weight and sugar', refresh: { every: 'mon' }, lastRefresh: { at: '2026-06-01T07:00:00Z', status: 'nothing_new' } }),
  summary({ id: 'weight', parent: 'glp1', title: 'Weight loss', headline: '9 to 13 points more than placebo', refresh: { every: 'mon' }, pendingChange: { id: 'ch1', label: '1 new trial' }, lastRefresh: { at: '2026-06-01T07:00:00Z', status: 'pending' } }),
  summary({ id: 't2d', parent: 'glp1', title: 'Type 2 diabetes', headline: 'ATTAIN-2: 7.1 points more than placebo at 36 mg', refresh: { every: 'mon' }, lastRefresh: { at: '2026-06-01T07:00:00Z', status: 'accepted', title: 'ATTAIN-2 added' } }),
  summary({ id: 'draft', title: 'Stopping for side effects', status: 'draft', headline: 'About 1 in 10 stop' }),
  summary({ id: 'old', title: 'Old page', status: 'archived' }),
]

const WEIGHT_BODY = [
  'Oral GLP-1s give **9 to 13 points** more weight loss than placebo, and 7 points in people with type 2 diabetes.',
  '',
  '```tiles',
  '{"tiles":[{"label":"Trials","value":"9","note":"since 2021"},{"label":"People","value":"4,120"}]}',
  '```',
  '',
  '## Note under the chart',
  '',
  'An **indirect** comparison found similar weight loss.',
  '',
  '## The trials',
  '',
  '```table',
  '{"columns":[{"key":"trial","label":"Trial"},{"key":"loss","label":"Weight lost"}],"rows":[{"trial":"OASIS 1","loss":{"text":"15.1%","quote":{"text":"mean change of -15.1%","cite":"Knop 2023"}}}]}',
  '```',
  '',
  '```markdown',
  '## Not a section (inside a fence)',
  '```',
].join('\n')

const page = (over: Partial<MwPage> = {}): MwPage => ({
  ...PAGES[1]!,
  body: WEIGHT_BODY, written: WEIGHT_BODY, regulated: false,
  breadcrumb: [{ id: 'glp1', title: 'GLP-1' }], children: [], canUndo: true, changes: [],
  question: 'How much weight do people lose on oral GLP-1s?',
  history: [
    { at: '2026-06-01T09:00:00Z', kind: 'chat', version: 3, byName: 'Leah', text: 'Changed from chat' },
    { at: '2026-05-25T07:00:00Z', kind: 'nothing_new' },
    { at: '2026-05-18T07:00:00Z', kind: 'accepted', version: 2, byName: 'Leah', text: 'SURMOUNT-5 added' },
    { at: '2026-05-11T07:00:00Z', kind: 'asked', version: 1, byName: 'Omar' },
  ],
  ...over,
})

describe('page model', () => {
  test('sections are cut at ## outside fences; the first paragraph is the headline', () => {
    const s = P.splitSections(WEIGHT_BODY)
    expect(s.map(x => x.heading ?? '')).toEqual(['', 'Note under the chart', 'The trials'])
    expect(P.splitHeadline(s[0]!.markdown).headline).toStartWith('Oral GLP-1s give')
    expect(P.splitHeadline('```tiles\n{}\n```').headline).toBe('')
  })

  test('refreshes, history and where a change came from, in words', () => {
    expect(P.refreshLabel('mon', t as never, 'en')).toBe('Refreshes every Monday')
    expect(P.refreshLabel('daily', t as never, 'en')).toBe('Refreshes every day')
    expect(P.historyText({ at: '', kind: 'accepted', byName: 'Leah', text: 'ATTAIN-MAINTAIN added' }, t as never)).toBe('ATTAIN-MAINTAIN added, accepted by Leah')
    expect(P.historyText({ at: '', kind: 'asked', byName: 'Omar' }, t as never)).toBe("made from Omar's question")
    expect(P.changeFromLabel({ kind: 'schedule', every: 'mon' }, t as never, 'en')).toBe("From the page's Monday refresh")
    expect(P.changeFromLabel({ kind: 'manual', byName: 'Leah' }, t as never, 'en')).toBe('From a refresh Leah asked for')
    expect(P.foundByLabel({ kind: 'schedule', every: 'mon' }, '2026-06-01T07:00:00Z', t as never, 'en')).toMatch(/^found by Monday's refresh, /)
    expect(P.foundByShort({ kind: 'schedule', every: 'mon' }, t as never, 'en')).toBe("Found by Monday's refresh")
  })

  test('the tree puts sub-pages under their parent; a page may not go under itself or its own sub-pages', () => {
    const rows = P.pageTree(PAGES.filter(p => p.status !== 'archived'))
    expect(rows.map(r => `${'  '.repeat(r.depth)}${r.page.title}`)).toEqual(['GLP-1', '  Weight loss', '  Type 2 diabetes', 'Stopping for side effects'])
    expect(rows[0]!.hasChildren).toBe(true)
    expect(P.pageTree(PAGES, new Set(['glp1'])).map(r => r.page.id)).toEqual(['glp1', 'draft', 'old'])
    expect(P.parentChoices('glp1', PAGES).map(p => p.id)).toEqual(['draft'])
    expect(P.parentChoices('draft', PAGES).map(p => p.id)).toEqual(['glp1', 'weight', 't2d'])
    expect(P.pathTitle(PAGES[1]!, PAGES)).toEqual({ parents: ['GLP-1'], title: 'Weight loss' })
  })
})

describe('a page', () => {
  test('a draft: Draft pill, "Keep this page" with where it goes and how often, no refresh pill', () => {
    const p = page({ ...PAGES[3]!, id: 'draft', parent: undefined, status: 'draft', pendingChange: undefined, breadcrumb: [], history: [{ at: '2026-06-03T09:00:00Z', kind: 'asked', version: 1, byName: 'Leah' }] })
    const html = render(<P.PageView page={p} pages={PAGES} onKeep={() => {}} />)
    expect(html).toContain('data-pill="draft"')
    expect(html).toContain('>Draft<')
    expect(html).toContain('Built for your question. Keep it and it stays up to date.')
    expect(html).toContain('data-action="keep-page"')
    expect(html).toContain('Keep this page')
    expect(html).toContain('Under GLP-1')
    expect(html).toContain('refresh weekly')
    expect(html).not.toContain('Under Stopping for side effects')
    expect(html).not.toContain('data-pill="kept"')
    expect(html).toContain('Pages</span><span aria-hidden="true"> › </span>')
  })

  test('a kept page: refresh pill, last refresh, the waiting change, "Changed from chat · Undo", blocks and history', () => {
    const p = page({ changedFromChat: { version: 3, sections: ['Note under the chart'] } })
    const html = render(<P.PageView page={p} pages={PAGES} onUndo={() => {}} onRefresh={() => {}} onArchive={() => {}} onOpenChange={() => {}} onShowAll={() => {}} actions={{ onOpenPage: () => {} }} />)
    expect(html).toContain('Refreshes every Monday')
    expect(html).toContain('data-action="refresh-now"')
    expect(html).toContain('A change is waiting for review')
    expect(html).toContain('1 new trial')
    expect(html).toContain('data-action="review-change"')
    // The chat changed one section: only it is marked, with Undo.
    expect(html).toContain('data-section="Note under the chart" data-changed-from-chat=""')
    expect(html).not.toContain('data-section="The trials" data-changed-from-chat')
    expect(html).toContain('Changed from chat')
    expect(html).toContain('data-action="undo-chat-change"')
    // The headline is set apart; the tiles and the table draw with the one block renderer.
    expect(html).toContain('data-headline')
    expect(html).toContain('data-page-block="tiles"')
    expect(html).toContain('4,120')
    expect(html).toContain('data-page-block="table"')
    expect(html).toContain('15.1%')
    // A heading inside a fence is not a section.
    expect(html).not.toContain('data-section="Not a section (inside a fence)"')
    expect(html).toContain('History:')
    expect(html).toContain('SURMOUNT-5 added, accepted by Leah')
    expect(html).toContain('nothing new')
    expect(html).toContain('All changes')
    expect(html).toContain('GLP-1</button>')
  })

  test('a parent sums up its kept sub-pages; drafts show but stay out of the summary', () => {
    const kids = [
      { ...PAGES[1]!, inSummary: true },
      { ...PAGES[2]!, inSummary: true },
      { ...summary({ id: 'kid-draft', parent: 'glp1', title: 'Heart outcomes', status: 'draft' }), inSummary: false },
    ]
    const subpages = JSON.stringify({
      pages: kids.map(k => ({ id: k.id, title: k.title, status: k.status, headline: k.headline, inSummary: k.inSummary, last: k.id === 't2d' ? { kind: 'accepted', at: '2026-06-01T07:00:00Z' } : undefined })),
      changes: [{ pageId: 't2d', title: 'Type 2 diabetes', kind: 'accepted', text: 'ATTAIN-2 added', byName: 'Leah', at: '2026-06-01T07:00:00Z' }],
    })
    const body = `GLP-1s by outcome.\n\n\`\`\`subpages\n${subpages}\n\`\`\``
    const p = page({ ...PAGES[0]!, body, written: '```subpages\n{}\n```', breadcrumb: [], children: kids, pendingChange: undefined })
    const html = render(<P.PageView page={p} pages={PAGES} actions={{ onOpenPage: () => {} }} />)
    expect(html).toContain('Sums up its sub-pages')
    expect(html).toContain('3 sub-pages, 2 kept')
    expect(html).toContain('data-page-block="subpages"')
    expect(html).toContain('data-subpage="weight" data-in-summary=""')
    expect(html).toContain('data-subpage="kid-draft"')
    expect(html).not.toContain('data-subpage="kid-draft" data-in-summary')
    expect(html).toContain('What changed this week')
    expect(html).toContain('ATTAIN-2 added, accepted by Leah')
  })

  test('a regulated kept page says its changes are reviewed', () => {
    const html = render(<P.PageView page={page({ regulated: true })} pages={PAGES} />)
    expect(html).toContain('Changes to this page are reviewed before anyone sees them.')
  })
})

const CHANGE: MwPageChange = {
  id: 'ch1', pageId: 'weight', pageTitle: 'Weight loss', projectId: 'literature', status: 'pending', fromVersion: 3,
  label: 'one new finding', title: 'ATTAIN-MAINTAIN added',
  before: 'Oral GLP-1s give 9 to 13 points more weight loss than placebo, and 7 points in people with type 2 diabetes.',
  after: 'Oral GLP-1s give 9 to 13 points more weight loss than placebo, and 7 points in people with type 2 diabetes. After switching from weekly injections, orforglipron kept about three quarters of the weight lost.',
  plus: 'after switching from weekly injections, orforglipron kept about three quarters of the weight lost, against 38 to 49% on placebo.',
  sections: [
    { heading: 'Keeping weight off after injections', origin: 'refresh', changed: 'added', markdown: '```table\n{"columns":[{"key":"from","label":"Switched from"},{"key":"kept","label":"Kept on orforglipron"}],"rows":[{"from":"Tirzepatide (205 people)","kept":"74.7%"}]}\n```' },
    { heading: 'Note under the chart', origin: 'chat', changed: 'changed', markdown: 'An **indirect** comparison found similar weight loss.' },
  ],
  removed: [],
  leftOut: [{ title: 'Semaglutide for cognitive dysfunction in depression', href: 'https://pubmed.ncbi.nlm.nih.gov/1', why: '16 weeks, weight a secondary outcome' }],
  numbers: { added: ['74.7%'], removed: [] },
  from: { kind: 'schedule', every: 'mon' },
  beforeBody: '', afterBody: '', at: '2026-06-01T07:00:00Z', mayDecide: true,
}

describe('review an answer change', () => {
  test('before and after, the new section from the refresh, the chat\'s change, what was left out, Send back / Accept', () => {
    const html = render(<P.PageChangeView change={CHANGE} onAccept={() => {}} onSendBack={() => {}} onAskWhy={() => {}} actions={{ onOpenPage: () => {} }} />)
    expect(html).toContain('Waiting for you')
    expect(html).toContain('Review an answer change')
    expect(html).toContain('Weight loss</button>')
    expect(html).toMatch(/found by Monday&#x27;s refresh, /)
    expect(html).toContain('The page says now')
    expect(html).toContain('After this change')
    expect(html).toContain('The same, plus:')
    expect(html).toContain('data-plus')
    expect(html).toContain('New section: Keeping weight off after injections')
    expect(html).toContain('From the refresh')
    expect(html).toContain('data-origin="chat"')
    expect(html).toContain('Changed from chat')
    expect(html).toContain('Tirzepatide (205 people)')
    expect(html).toContain('Left out:')
    expect(html).toContain('Semaglutide for cognitive dysfunction in depression')
    expect(html).toContain('16 weeks, weight a secondary outcome')
    expect(html).toContain('data-action="ask-why"')
    expect(html).toContain('Accepting updates the page for everyone in the project.')
    expect(html).toContain('data-action="send-back"')
    expect(html).toContain('data-action="accept-change"')
  })

  test('decided, or not this person\'s to decide: a status line instead of the buttons', () => {
    const accepted = render(<P.PageChangeView change={{ ...CHANGE, status: 'accepted', reviewedByName: 'Leah' }} onAccept={() => {}} onSendBack={() => {}} />)
    expect(accepted).not.toContain('data-action="accept-change"')
    expect(accepted).toContain('Accepted by Leah')
    const sentBack = render(<P.PageChangeView change={{ ...CHANGE, status: 'sent_back', reviewedByName: 'Leah', comment: 'Wait for the full paper' }} />)
    expect(sentBack).toContain('Sent back by Leah')
    expect(sentBack).toContain('Wait for the full paper')
    const notMine = render(<P.PageChangeView change={{ ...CHANGE, mayDecide: false }} onAccept={() => {}} onSendBack={() => {}} />)
    expect(notMine).not.toContain('data-action="accept-change"')
    expect(notMine).toContain("Waiting for the page&#x27;s owner to review it.")
  })
})

describe('home', () => {
  test('"What changed this week": the change, needs your review, what the page will say, where it came from', () => {
    const html = render(<P.WhatChangedCard change={CHANGE} parents={['GLP-1']} onOpen={() => {}} />)
    expect(html).toContain('GLP-1<span aria-hidden="true"> › </span>Weight loss: one new finding')
    expect(html).toContain('Needs your review')
    expect(html).toContain('orforglipron kept about three quarters')
    expect(html).toContain("Found by Monday&#x27;s refresh · nothing else on the page moved")
    const { pending, accepted } = P.changedThisWeek(PAGES, new Date('2026-06-03T09:00:00Z'))
    expect(pending.map(p => p.id)).toEqual(['weight'])
    expect(accepted.map(p => p.id)).toEqual(['t2d'])
  })

  test('"Pages kept up to date": kept pages only, with the parent, what each says now, and when it refreshed', () => {
    const html = render(<P.PagesKeptTable pages={PAGES} now={new Date('2026-06-03T09:00:00Z')} onOpenPage={() => {}} />)
    expect(html).toContain('Pages kept up to date')
    expect(html).toContain('What it says now')
    expect(html).toContain('data-kept-page="weight"')
    expect(html).not.toContain('data-kept-page="draft"')
    expect(html).not.toContain('data-kept-page="old"')
    expect(html).toContain('GLP-1<span aria-hidden="true"> › </span></span><span class="text-foreground">Weight loss')
    expect(html).toContain('9 to 13 points more than placebo')
    expect(html).toContain('2 sub-pages, a change waiting')
    expect(html).toContain('>Mon<')
  })
})

describe('the same blocks in chat', () => {
  test('a chat message draws tiles and tables with the page renderer; live blocks say they show on the page', () => {
    const md = 'Here is what I found.\n\n```tiles\n[{"label":"Trials","value":"9"}]\n```\n\n```records\n{"entity":"paper"}\n```\n\n```table\n{oops\n```'
    const html = render(<Markdown mode="minimal">{md}</Markdown>)
    expect(html).toContain('data-page-block="tiles"')
    expect(html).toContain('Trials')
    expect(html).toContain('Live paper records show on the page.')
    expect(html).toContain('This table block can&#x27;t be shown: it isn&#x27;t valid JSON.')
    const full = render(<Markdown mode="full">{'```tiles\n[{"label":"People","value":"4,120"}]\n```'}</Markdown>)
    expect(full).toContain('data-page-block="tiles"')
  })
})
