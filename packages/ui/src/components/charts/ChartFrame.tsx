/**
 * What every chart in the kit shares: the measured width (the SVG is drawn at the width it gets,
 * so its labels stay at their real size), the figure with an SVG that screen readers hear as one
 * image with a summary, and the same data as a visually hidden table.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CHART_FONT, formatChartNumber, type ChartDatum } from './chart-utils'

/** The width of the element `ref` points at, kept current; `fallback` until it is measured (and in SSR). */
export function useChartWidth(fallback = 480): [React.RefObject<HTMLElement>, number] {
  const ref = React.useRef<HTMLElement>(null)
  const [width, setWidth] = React.useState(fallback)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (w: number) => { if (w > 0) setWidth(Math.round(w)) }
    measure(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => measure(entries[0]?.contentRect.width ?? 0))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

/** A number formatter in the reader's language. */
export function useChartFormat(formatValue?: (n: number) => string): (n: number) => string {
  const { i18n } = useTranslation()
  return React.useCallback((n: number) => (formatValue ? formatValue(n) : formatChartNumber(n, i18n.language)), [formatValue, i18n.language])
}

export interface ChartSvgProps {
  width: number
  height: number
  summary: string
  children: React.ReactNode
  className?: string
}

/** The chart's SVG: one image named by its summary, scaling with its box (viewBox, width 100%). */
export function ChartSvg({ width, height, summary, children, className }: ChartSvgProps) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label={summary}
      className={cn('block h-auto max-w-full overflow-visible', className)}
      style={{ fontSize: CHART_FONT }}
    >
      {children}
    </svg>
  )
}

/** The chart's data as a table only screen readers see (and copy/paste picks up). */
export function ChartDataTable({ data, format, unit, title, interval }: {
  data: ChartDatum[]
  format: (n: number) => string
  unit?: string
  title?: string
  interval?: boolean
}) {
  const { t } = useTranslation()
  const withUnit = (label: string) => (unit ? `${label} (${unit})` : label)
  return (
    <table className="sr-only" data-chart-table>
      <caption>{title ?? t('chart.data')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('chart.label')}</th>
          <th scope="col">{withUnit(t('chart.value'))}</th>
          {interval && <th scope="col">{t('chart.low')}</th>}
          {interval && <th scope="col">{t('chart.high')}</th>}
        </tr>
      </thead>
      <tbody>
        {data.map((d, i) => (
          <tr key={`${i}:${d.label}`}>
            <th scope="row">{d.label}</th>
            <td>{format(d.value)}</td>
            {interval && <td>{d.low === undefined ? '' : format(d.low)}</td>}
            {interval && <td>{d.high === undefined ? '' : format(d.high)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** "Nothing to chart yet." in the chart's place. */
export function ChartEmpty({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { t } = useTranslation()
  return <p className={cn('text-label text-tertiary', className)} data-chart-empty>{children ?? t('chart.noData')}</p>
}

/** The plural-aware "Bar chart, 5 items" a summary starts with. */
export function useKindLabel(kind: 'bar' | 'line' | 'donut' | 'interval', count: number): string {
  const { t } = useTranslation()
  return t('chart.kindCount', { kind: t(`chart.kind.${kind}`), count })
}
