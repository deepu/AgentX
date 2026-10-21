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
