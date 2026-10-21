/**
 * Shares of a whole: a ring with the total in the middle and a legend (colour, label, value,
 * percent). More than five slices fold the smallest into "Other", so no colour repeats.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CHART_COLORS, chartColor, chartSummary, cleanData, foldSlices, type ChartDatum } from './chart-utils'
import { ChartDataTable, ChartEmpty, ChartSvg, useChartFormat, useKindLabel } from './ChartFrame'

export interface DonutChartProps {
  data: ChartDatum[]
  title?: string
  unit?: string
  formatValue?: (n: number) => string
  /** Diameter of the ring, px (default 120). */
  size?: number
  className?: string
}

export function DonutChart({ data: raw, title, unit, formatValue, size = 120, className }: DonutChartProps) {
  const { t, i18n } = useTranslation()
  const format = useChartFormat(formatValue)
  const data = React.useMemo(() => cleanData(raw), [raw])
  const slices = React.useMemo(() => foldSlices(data, CHART_COLORS.length, t('chart.other')), [data, t])
  const total = slices.reduce((s, d) => s + d.value, 0)
  const summary = chartSummary({ title, kindLabel: useKindLabel('donut', data.length), data, format, unit, more: n => t('chart.more', { count: n }) })

  if (total <= 0) return <ChartEmpty className={className} />

  const percent = (v: number) => new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: v / total < 0.1 ? 1 : 0 }).format(v / total)
  const r = 15.9155 // circumference 100
  const gap = slices.length > 1 ? 0.6 : 0
  let at = 0

  return (
    <figure className={cn('m-0 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3', className)} data-chart-kind="donut">
      <div className="shrink-0" style={{ width: size }}>
        <ChartSvg width={42} height={42} summary={summary}>
          <circle cx={21} cy={21} r={r} fill="none" stroke="var(--fill-hover)" strokeWidth={6} />
          {slices.map((d, i) => {
            const pct = (d.value / total) * 100
            const el = (
              <circle
                key={`${i}:${d.label}`}
                cx={21}
                cy={21}
                r={r}
                fill="none"
                stroke={chartColor(i)}
                strokeWidth={6}
                strokeDasharray={`${Math.max(0.0001, pct - gap)} ${100 - Math.max(0.0001, pct - gap)}`}
                strokeDashoffset={25 - at}
                data-slice={d.label}
              >
                <title>{`${d.label}: ${format(d.value)}${unit ? ` ${unit}` : ''} (${percent(d.value)})`}</title>
              </circle>
            )
            at += pct
            return el
          })}
          <text x={21} y={21} textAnchor="middle" dominantBaseline="central" fill="var(--text)" className="tabular-nums" style={{ fontSize: 7, fontWeight: 600 }}>{format(total)}</text>
        </ChartSvg>
      </div>
      <ul className="min-w-0 flex-1 space-y-1 text-label-sm" aria-hidden data-chart-legend>
        {slices.map((d, i) => (
          <li key={`${i}:${d.label}`} className="flex min-w-0 items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: chartColor(i) }} />
            <span className="min-w-0 flex-1 truncate text-secondary" title={d.label}>{d.label}</span>
            <span className="shrink-0 tabular-nums text-foreground">{format(d.value)}{unit ? ` ${unit}` : ''}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-tertiary">{percent(d.value)}</span>
          </li>
        ))}
      </ul>
      <ChartDataTable data={data} format={format} unit={unit} title={title} />
    </figure>
  )
}
