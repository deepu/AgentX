/**
 * Literature watch screens (25 §4, §5): quotes found in a Text field the way the kernel checks
 * them, the text viewer's highlights and missing list, and the record page's and dashboard's
 * charts, KPI tiles and "Ask about this topic" drawn with the chart kit.
 */

import { beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { i18n, setupI18n } from '@memwise/shared/i18n'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { TooltipProvider } = await import('@memwise/ui')
const { TextViewer } = await import('../records/TextViewer')
const { findTextQuotes, normalizeQuote, textSegments } = await import('../records/quote-highlight')
const { RecordPageView } = await import('../records/RecordPageView')
const { DashboardView } = await import('../domains/DashboardView')
const L = await import('../records/sample-literature')
const { EntityView, viewToState } = await import('../domains/EntitiesView')
const { defaultColumns, filterExample, recordColumns } = await import('../records/record-model')
const S = await import('../records/sample-records')
const { GeneratedForm } = await import('../GeneratedForm')
const { isLongTextField } = await import('../domains/NewRecordDialog')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const render = (node: React.ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)

const ABSTRACT = 'Background: We ran a phase 3 trial.\n\nMethods: 1·204 adults (n = 1204) were randomised; sponsor: Acme  Pharma.'

describe('quotes in a text (25 §4)', () => {
  test('match after NFKC, case folding, collapsed whitespace and · read as .', () => {
    expect(normalizeQuote('  Phase 3\n TRIAL ')).toBe('phase 3 trial')
    const { ranges, missing } = findTextQuotes(ABSTRACT, ['phase 3 trial', '1.204 adults', 'Sponsor: ACME Pharma', 'placebo'])
    expect(missing).toEqual([3])
    const slice = (i: number) => ABSTRACT.slice(ranges[i]!.start, ranges[i]!.end)
    expect(slice(0)).toBe('phase 3 trial')
    expect(slice(1)).toBe('1·204 adults')
    expect(slice(2)).toBe('sponsor: Acme  Pharma')
  })

  test('overlapping quotes cut the text into pieces covered by each', () => {
    const text = 'abcdef'
    const segs = textSegments(text, [{ quote: 0, start: 1, end: 4 }, { quote: 1, start: 3, end: 6 }])
    expect(segs).toEqual([
      { start: 0, end: 1, quotes: [] },
      { start: 1, end: 3, quotes: [0] },
      { start: 3, end: 4, quotes: [0, 1] },
      { start: 4, end: 6, quotes: [1] },
    ])
  })

  test('the viewer marks each quote with its field and lists the ones not found', () => {
    const html = render(
      <TextViewer
        title="Abstract"
        text={ABSTRACT}
        quotes={[
          { quote: 'phase 3 trial', label: 'Phase', field: 'phase' },
          { quote: '(n = 1204)', label: 'Sample size', field: 'n' },
          { quote: 'double-blind', label: 'Evidence · Design', field: 'evidence' },
        ]}
      />,
    )
    expect(html).toContain('data-text-viewer')
    expect(html).toContain('data-quotes-found="2"')
    expect(html).toContain('title="Quote for Phase"')
    expect(html).toContain('data-quote-field="n"')
    expect(html).toContain('data-quotes-missing="1"')
    expect(html).toContain('Not found in the text:')
    expect(html).toContain('“double-blind”')
  })

  test('an empty text says so', () => {
    expect(render(<TextViewer title="Abstract" text={null} />)).toContain('No text yet.')
  })
})

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('the Topic page (25 §5)', () => {
  test('KPI tiles with the fields\' labels, the kernel\'s charts, and "Ask about this topic"', () => {
    const html = render(<RecordPageView page={L.sampleTopicPage} actions={{ openChat: () => {}, openRecord: () => {} }} />)
    expect(html).toContain('data-kpis')
    expect(count(html, 'data-kpi=')).toBe(4)
    expect(html).toContain('data-kpi="Evidence reviewed"')
    expect(html).toContain('66.7%')
    // KPI fields are not repeated in the details.
    expect(html).not.toContain('data-field="included"')
    expect(html).toContain('data-chart="bar"')
    expect(html).toContain('Included papers by year')
    expect(count(html, 'data-bar=')).toBe(5)
    expect(html).toContain('data-chart="interval"')
    expect(count(html, 'data-interval=')).toBe(3)
    expect(html).toContain('data-reference="0"')
    expect(html).toContain('data-chart-skipped="1"')
    expect(html).toContain('1 record without a value left out')
    expect(html).toContain('data-action="ask-about-record"')
    expect(html).toContain('Ask about this topic')
  })

  test('a move only a playbook step makes is said in words, not offered as a button', () => {
    const page = {
      ...L.sampleTopicPage, status: 'draft',
      lifecycle: {
        states: ['draft', 'active', 'paused', 'closed'], current: 'draft',
        transitions: [
          { name: 'activate', label: 'Activate', to: 'active', allowed: false, reason: 'only a playbook step can move a Topic to active ("activate")', automatic: true },
          { name: 'close', label: 'Close', to: 'closed', allowed: true },
        ],
      },
    }
    const html = render(<RecordPageView page={page} actions={{ openRecord: () => {}, transition: async () => ({ applied: true }) } as never} />)
    expect(html).not.toContain('data-transition="activate"')
    expect(html).toContain('data-automatic="activate"')
    expect(html).toContain('Only a playbook step can move a Topic to active')
    expect(html).toContain('data-transition="close"')
  })

  test('no openChat: no chat button', () => {
    expect(render(<RecordPageView page={L.sampleTopicPage} />)).not.toContain('data-action="ask-about-record"')
  })

  test('a chart block the kernel sent no rows for falls back to counting its related rows', () => {
    const page = { ...L.sampleTopicPage, charts: {} }
    const html = render(<RecordPageView page={page} />)
    expect(html).toContain('data-chart="bar"')
    // The interval chart can't be counted here: it says there is nothing to chart.
    expect(html).toContain('Nothing to chart yet.')
  })
})

describe('the Article page (25 §4)', () => {
  test('the abstract with its quotes lit, each naming its field; a value with a quote can show it', () => {
    const html = render(<RecordPageView page={L.sampleArticlePage} actions={{ openRecord: () => {} }} />)
    expect(html).toContain('data-text-viewer')
    expect(html).toContain('data-quotes-found="5"')
    expect(html).toContain('title="Quote for Sample size: 1,204"')
    expect(html).toContain('data-quote-field="quote"')
    expect(html).toContain('title="Quote for Quote: Drug A vs placebo"')
    expect(html).toContain('data-quotes-missing="1"')
    expect(html).toContain('“once-daily oral tablet”')
    expect(count(html, 'data-action="show-quote"')).toBe(4)
    // The abstract is the viewer, not a detail row.
    expect(html).not.toContain('data-field="abstract"')
  })
})

describe('free pages (25 §5)', () => {
  test('chart blocks draw with the kit beside the KPI tiles', () => {
    const html = render(<DashboardView dashboard={L.sampleLiteratureDashboard} />)
    expect(html).toContain('data-kpis')
    expect(html).toContain('Target 80%')
    expect(html).toContain('data-chart="donut"')
    expect(html).toContain('Screenings by decision')
    expect(html).toContain('data-chart="line"')
    expect(html).toContain('<polyline')
  })
})

describe('the Article records table (walkthrough)', () => {
  const columns = [
    { name: 'pmid', label: 'Pmid', type: 'Text' }, { name: 'doi', label: 'Doi', type: 'Text' }, { name: 'pmc_id', label: 'Pmc id', type: 'Text' },
    { name: 'title', label: 'Title', type: 'Text' }, { name: 'journal', label: 'Journal', type: 'Text' }, { name: 'year', label: 'Year', type: 'Number' },
    { name: 'article_types', label: 'Article types', type: 'List<Text>' }, { name: 'abstract', label: 'Abstract', type: 'Text' },
    { name: 'n', label: 'N', type: 'Number' }, { name: 'sponsor', label: 'Sponsor', type: 'Text' }, { name: 'status', label: 'Status', type: 'Lifecycle' },
  ]
  const long = 'Background: oral GLP-1 receptor agonists. '.repeat(10)
  const row = (id: string, title: string, values: Record<string, unknown>) => ({ entity: 'literature.article', id, title, status: 'found', hidden: [], values: { title, ...values } })
  const result = {
    entity: 'literature.article', columns, total: 2,
    rows: [
      row('a1', 'ATTAIN-2: orforglipron in adults with type 2 diabetes', { pmid: '40500001', doi: '10.1/attain2', journal: 'Lancet', year: 2025, article_types: ['Randomized Controlled Trial', 'Multicenter Study'], abstract: long, n: 1613 }),
      row('a2', 'Example Review B', { pmid: '40500002', journal: 'BMJ', year: 2024, article_types: ['Review'], abstract: long }),
    ],
  }

  test('default columns: short fields only, not the abstract, not the title, not a field no row has; the status last', () => {
    const names = defaultColumns(columns, result.rows).map(c => c.name)
    expect(names).toEqual(['pmid', 'doi', 'journal', 'year', 'article_types', 'status'])
    expect(defaultColumns(columns, result.rows, { max: 10 }).map(c => c.name)).toEqual(['pmid', 'doi', 'journal', 'year', 'article_types', 'n', 'status'])
    // Fields in the `title:` template are the first column already.
    expect(defaultColumns(columns, result.rows, { title: '{pmid} · {title}' }).map(c => c.name)).not.toContain('pmid')
    expect(defaultColumns(columns, [], { title: '{title}' }).map(c => c.name)).toEqual(['pmid', 'doi', 'pmc_id', 'journal', 'year', 'status'])
    // The entity's `list:` wins, in its order.
    expect(defaultColumns(columns, result.rows, { list: ['journal', 'year', 'n', 'status'] }).map(c => c.name)).toEqual(['journal', 'year', 'n', 'status'])
  })

  test('every column stays in the Columns menu, whatever the last query asked for', () => {
    const type = { fields: columns.filter(c => c.name !== 'status').map(c => ({ name: c.name, type: c.type })), lifecycle: ['found', 'read'], definition: { calculated: [{ name: 'evidence_count' }] } }
    const all = recordColumns(type, [{ name: 'year', label: 'Year', type: 'Number' }]).map(c => c.name)
    expect(all).toEqual([...columns.filter(c => c.name !== 'status').map(c => c.name), 'evidence_count', 'status'])
  })

  test('one line per row: cut with an ellipsis, the whole value in the tooltip, lists joined, years not grouped', () => {
    const type = { name: 'Article', key: 'literature.article', fields: columns.map(c => ({ name: c.name, type: c.type, schema: {} })), lifecycle: ['found', 'read'] }
    const html = render(<EntityView domain={S.sampleDomains[0]!} type={type} tab="records" onTab={() => {}} views={[]} state={viewToState(null)} onState={() => {}} result={result} />)
    expect(html).not.toContain('Background: oral GLP-1')
    expect(html).not.toContain('>Abstract<')
    expect(html).toContain('title="Randomized Controlled Trial, Multicenter Study"')
    expect(html).toContain('>2025<')
    expect(count(html, 'class="max-w-[16rem] truncate"')).toBeGreaterThan(0)
    // Chosen columns still show what was chosen, the abstract too.
    const chosen = render(<EntityView domain={S.sampleDomains[0]!} type={type} tab="records" onTab={() => {}} views={[]} state={{ ...viewToState(null), columns: ['abstract'] }} onState={() => {}} result={result} />)
    expect(chosen).toContain(`title="${long}"`)
  })

  test("the filter box's example names the entity's own fields", () => {
    const topic = { fields: [{ name: 'name', type: 'Text' }, { name: 'question', type: 'Text' }, { name: 'next_check', type: 'Date' }], lifecycle: ['draft', 'active'] }
    expect(filterExample(topic)).toBe("status = 'draft'")
    expect(filterExample({ fields: [{ name: 'study_type', type: 'Enum[randomised_trial, cohort]' }, { name: 'year', type: 'Number' }], lifecycle: ['found'] })).toBe("status = 'found' and study_type = 'randomised_trial'")
    expect(filterExample({ fields: [{ name: 'year', type: 'Number' }] })).toBe('year > 0')
    expect(filterExample({ fields: [{ name: 'name', type: 'Text' }] })).toBe('name is set')
    const type = { name: 'Topic', key: 'literature.topic', fields: topic.fields.map(f => ({ ...f, schema: {} })), lifecycle: topic.lifecycle }
    const html = render(<EntityView domain={S.sampleDomains[0]!} type={type} tab="records" onTab={() => {}} views={[]} state={viewToState(null)} onState={() => {}} result={null} />)
    expect(html).toContain('placeholder="e.g. status = &#x27;draft&#x27;"')
    expect(html).not.toContain('country')
  })
})

describe('New Topic (walkthrough)', () => {
  test('free text like the question is typed in a multi-line box; the name stays one line', () => {
    const fields = [
      { name: 'name', type: 'Text', schema: { type: 'string' }, required: true },
      { name: 'question', type: 'Text', schema: { type: 'string' }, required: true },
      { name: 'next_check', type: 'Date', schema: { type: 'string', format: 'date' } },
    ]
    expect(fields.map(isLongTextField)).toEqual([false, true, false])
    const html = render(<GeneratedForm fields={fields} values={{}} onChange={() => {}} multiline={isLongTextField} />)
    expect(count(html, '<textarea')).toBe(1)
    expect(html).toContain('data-field="question" data-kind="longtext"')
    // Without it, as every other form: one line each.
    expect(count(render(<GeneratedForm fields={fields} values={{}} onChange={() => {}} />), '<textarea')).toBe(0)
  })
})
