import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initReactI18next, setI18n } from 'react-i18next'
import { i18n, setupI18n } from '@memwise/shared/i18n'
import { BarChart, DonutChart, IntervalChart, KpiTiles, LineChart } from '../index'
import { chartSummary, cleanData, fitLabel, foldSlices, formatChartNumber, niceTicks, valueDomain } from '../chart-utils'
import { parseChartSpec } from '../../markdown/chart-spec'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: new Promise(() => {}) }) }))
const { Markdown } = await import('../../markdown/Markdown')

beforeAll(() => {
  setI18n(setupI18n([initReactI18next]))
  void i18n.changeLanguage('en')
})

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

describe('chart utils', () => {
  it('nice ticks cover the data with round steps', () => {
    expect(niceTicks(0, 47, 5)).toEqual([0, 10, 20, 30, 40, 50])
    expect(niceTicks(-1.8, 0.4, 5)).toEqual([-2, -1.5, -1, -0.5, 0, 0.5])
    expect(niceTicks(0, 0)).toEqual([0, 1])
    expect(niceTicks(5, 5)[0]).toBe(0)
    const d = valueDomain([3, 9], [0])
    expect(d.min).toBe(0)
    expect(d.max).toBeGreaterThanOrEqual(9)
  })

  it('formats, fits and folds', () => {
    expect(formatChartNumber(1234.5, 'en')).toBe('1,235')
    expect(formatChartNumber(-1.234, 'en')).toBe('-1.23')
    expect(fitLabel('A very long category label indeed', 60)).toMatch(/…$/)
    expect(fitLabel('Short', 200)).toBe('Short')
    const folded = foldSlices([1, 2, 3, 4, 5, 6, 7].map(v => ({ label: `s${v}`, value: v })), 5, 'Other')
    expect(folded).toHaveLength(5)
    expect(folded[4]).toEqual({ label: 'Other', value: 1 + 2 + 3 })
    expect(cleanData([{ label: 'x', value: Number.NaN }, { label: 'y', value: 2, low: Number.NaN }])).toEqual([{ label: 'y', value: 2 }])
  })

  it('summarises the data in words', () => {
    const s = chartSummary({ title: 'Effect', kindLabel: 'Interval chart, 1 item', data: [{ label: 'A vs B', value: -1.2, low: -2, high: -0.4 }], format: n => String(n), unit: 'mmHg' })
    expect(s).toBe('Effect. Interval chart, 1 item: A vs B: -1.2 (-2 – -0.4) mmHg')
  })
})

describe('the ```chart spec', () => {
  it('reads the documented shape', () => {
    const r = parseChartSpec(JSON.stringify({ kind: 'interval', title: 'T', unit: 'mmHg', source: '[x](https://doi.org/10.1/x)', data: [{ label: 'A', value: -1, low: '-2', high: 0 }] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.spec).toEqual({ kind: 'interval', title: 'T', unit: 'mmHg', source: '[x](https://doi.org/10.1/x)', data: [{ label: 'A', value: -1, low: -2, high: 0 }] })
  })

  it('says what is wrong', () => {
    expect(parseChartSpec('{ "kind": ')).toMatchObject({ ok: false, error: 'json' })
    expect(parseChartSpec('{ "kind": "pie", "data": [] }')).toMatchObject({ ok: false, error: 'kind' })
    expect(parseChartSpec('{ "kind": "bar", "data": [{ "label": "a" }] }')).toMatchObject({ ok: false, error: 'data' })
    expect(parseChartSpec('{ "kind": "bar", "data": [] }')).toMatchObject({ ok: false, error: 'empty' })
  })
})

describe('the kit', () => {
  const data = [{ label: '2022', value: 3 }, { label: '2023', value: 7 }, { label: '2024', value: 12 }]

  it('bars: an image named by its data, a hidden table, one bar per item', () => {
    const out = html(<BarChart data={data} title="Included papers by year" />)
    expect(out).toContain('role="img"')
    expect(out).toContain('aria-label="Included papers by year. Bar chart, 3 items: 2022: 3; 2023: 7; 2024: 12"')
    expect(out).toContain('data-chart-table')
    expect(out.split('data-bar=').length - 1).toBe(3)
    expect(out).toContain('data-orientation="vertical"')
    expect(out).toContain('var(--accent)')
  })

  it('bars turn horizontal for many or long labels', () => {
    const long = [{ label: 'Semaglutide 1 mg once weekly vs placebo', value: 4 }, { label: 'Tirzepatide 15 mg vs semaglutide', value: 6 }]
    expect(html(<BarChart data={long} />)).toContain('data-orientation="horizontal"')
  })

  it('line, donut and interval charts', () => {
    expect(html(<LineChart data={data} />)).toContain('<polyline')
    const donut = html(<DonutChart data={data} />)
    expect(donut).toContain('data-chart-legend')
    expect(donut.split('data-slice=').length - 1).toBe(3)
    const forest = html(<IntervalChart data={[{ label: 'A vs placebo', value: -1.2, low: -2, high: -0.4 }, { label: 'B vs placebo', value: 0.3, low: -0.5, high: 1.1 }]} unit="mmHg" />)
    expect(forest).toContain('data-reference="0"')
    expect(forest.split('data-interval=').length - 1).toBe(2)
    expect(forest).toContain('mmHg')
    expect(forest).toContain('<th scope="col">Low</th>')
  })

  it('an empty chart says so', () => {
    expect(html(<BarChart data={[]} />)).toContain('Nothing to chart yet.')
  })

  it('KPI tiles: big numbers, targets in words', () => {
    const out = html(<KpiTiles items={[{ label: 'Included', value: 12 }, { label: 'Reviewed', value: 40, format: 'percent', target: 80 }, { label: 'Kept', value: null }]} />)
    expect(out).toContain('data-kpis')
    expect(out).toContain('>12<')
    expect(out).toContain('Target 80%')
    expect(out).toContain('text-destructive')
    expect(out).toContain('No value')
  })
})

describe('the ```chart markdown block', () => {
  const md = '```chart\n' + JSON.stringify({ kind: 'bar', title: 'Papers by year', data: [{ label: '2023', value: 4 }, { label: '2024', value: 9 }], source: 'PubMed, [PMID 123](https://pubmed.ncbi.nlm.nih.gov/123/)' }) + '\n```'

  for (const mode of ['minimal', 'full'] as const) {
    it(`draws in ${mode} mode, with its source as a caption`, () => {
      const out = html(<Markdown mode={mode}>{md}</Markdown>)
      expect(out).toContain('data-ca-block-type="chart"')
      expect(out).toContain('data-chart-block="bar"')
      expect(out).toContain('Papers by year')
      expect(out).toContain('data-chart-source')
      expect(out).toContain('href="https://pubmed.ncbi.nlm.nih.gov/123/"')
    })
  }

  it('invalid JSON shows the code and a short error', () => {
    const out = html(<Markdown mode="full">{'```chart\n{ "kind": "bar", \n```'}</Markdown>)
    expect(out).toContain('data-chart-invalid="json"')
    expect(out).toContain('Couldn’t draw this chart: the JSON could not be read.')
  })
})
