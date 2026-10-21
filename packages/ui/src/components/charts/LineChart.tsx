/**
 * One series over ordered categories (years, months): a line with a dot per point over a light
 * area, a value axis with round ticks, and as many category labels as fit. Hand-drawn SVG.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CHART_INK, chartColor, chartSummary, cleanData, fitLabel, labelStride, textWidth, valueDomain, type ChartDatum } from './chart-utils'
import { ChartDataTable, ChartEmpty, ChartSvg, useChartFormat, useChartWidth, useKindLabel } from './ChartFrame'

export interface LineChartProps {
  data: ChartDatum[]
  title?: string
  unit?: string
  formatValue?: (n: number) => string
  /** Start the value axis at zero (default true; false fits the axis to the data). */
  zero?: boolean
  plotHeight?: number
  className?: string
}

const PAD = 8

export function LineChart({ data: raw, title, unit, formatValue, zero = true, plotHeight = 150, className }: LineChartProps) {
  const { t } = useTranslation()
  const [ref, width] = useChartWidth()
  const format = useChartFormat(formatValue)
  const data = React.useMemo(() => cleanData(raw), [raw])
  const summary = chartSummary({ title, kindLabel: useKindLabel('line', data.length), data, format, unit, more: n => t('chart.more', { count: n }) })

  if (data.length === 0) return <ChartEmpty className={className} />

  const { ticks, min, max } = valueDomain(data.map(d => d.value), zero ? [0] : [])
  const axisW = Math.max(...ticks.map(tk => textWidth(format(tk)))) + 6
  const top = unit ? 20 : 10
  const bottom = 22
  const height = top + plotHeight + bottom
  const left = PAD + axisW
  const inset = 6
  const plotW = Math.max(1, width - left - PAD - inset * 2)
  const step = data.length > 1 ? plotW / (data.length - 1) : 0
  const px = (i: number) => left + inset + (data.length > 1 ? step * i : plotW / 2)
  const py = (v: number) => top + plotHeight - ((v - min) / (max - min || 1)) * plotHeight
  const longest = Math.min(Math.max(...data.map(d => textWidth(d.label))), 80)
  const stride = data.length > 1 ? labelStride(data.length, step, longest) : 1
  const points = data.map((d, i) => `${px(i)},${py(d.value)}`).join(' ')
  const base = py(Math.max(min, Math.min(0, max)))
  const area = data.length > 1 ? `M${px(0)},${base} L${points.replace(/ /g, ' L')} L${px(data.length - 1)},${base} Z` : ''
  const color = chartColor(0)

  return (
    <figure ref={ref} className={cn('m-0 min-w-0', className)} data-chart-kind="line">
      <ChartSvg width={width} height={height} summary={summary}>
        {unit && <text x={PAD} y={10} fill={CHART_INK.axis} dominantBaseline="middle">{unit}</text>}
        {ticks.map(tk => (
          <g key={tk}>
            <line x1={left} x2={width - PAD} y1={py(tk)} y2={py(tk)} stroke={tk === 0 ? CHART_INK.zero : CHART_INK.grid} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={left - 6} y={py(tk)} textAnchor="end" dominantBaseline="middle" fill={CHART_INK.axis} className="tabular-nums">{format(tk)}</text>
          </g>
        ))}
        {area && <path d={area} fill={CHART_INK.area} stroke="none" />}
        {data.length > 1 && <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {data.map((d, i) => (
          <g key={`${i}:${d.label}`} data-point={d.label}>
            <circle cx={px(i)} cy={py(d.value)} r={data.length > 40 ? 2 : 3.5} fill={color} stroke="var(--background)" strokeWidth={1.5}>
              <title>{`${d.label}: ${format(d.value)}${unit ? ` ${unit}` : ''}`}</title>
            </circle>
            {(i % stride === 0 || i === data.length - 1) && (data.length - 1 - i >= stride || i === data.length - 1 || i === 0) && (
              <text x={px(i)} y={top + plotHeight + 15} textAnchor={data.length === 1 ? 'middle' : i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fill={CHART_INK.label}>
                {fitLabel(d.label, Math.max(step * stride - 4, 40))}
              </text>
            )}
          </g>
        ))}
      </ChartSvg>
      <ChartDataTable data={data} format={format} unit={unit} title={title} />
    </figure>
  )
}
