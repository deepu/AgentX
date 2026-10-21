/**
 * A forest plot (25 §5): one row per item, its label on the left, a dot at the value with the
 * confidence interval as a line from low to high, a dashed reference line (0 by default), an
 * axis with round ticks and the unit under it. When there is room the estimate is written out
 * on the right ("−1.2 (−2.0 – −0.4)").
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CHART_INK, chartColor, chartSummary, cleanData, fitLabel, textWidth, valueDomain, type ChartDatum } from './chart-utils'
import { ChartDataTable, ChartEmpty, ChartSvg, useChartFormat, useChartWidth, useKindLabel } from './ChartFrame'

export interface IntervalChartProps {
  data: ChartDatum[]
  title?: string
  unit?: string
  /** Where "no effect" is: 0 for differences (default), 1 for ratios. */
  reference?: number
  formatValue?: (n: number) => string
  className?: string
}

const PAD = 8
const ROW = 26
const CAP = 4

export function IntervalChart({ data: raw, title, unit, reference = 0, formatValue, className }: IntervalChartProps) {
  const { t } = useTranslation()
  const [ref, width] = useChartWidth()
  const format = useChartFormat(formatValue)
  const data = React.useMemo(() => cleanData(raw), [raw])
  const summary = chartSummary({ title, kindLabel: useKindLabel('interval', data.length), data, format, unit, more: n => t('chart.more', { count: n }) })

  if (data.length === 0) return <ChartEmpty className={className} />

  const values = data.flatMap(d => [d.value, d.low, d.high]).filter((v): v is number => v !== undefined)
  const { ticks, min, max } = valueDomain(values, [reference], width < 360 ? 4 : 6)
  const estimate = (d: ChartDatum) => d.low !== undefined && d.high !== undefined ? `${format(d.value)} (${format(d.low)} – ${format(d.high)})` : format(d.value)
  const estimateW = Math.max(...data.map(d => textWidth(estimate(d))))
  const showEstimate = width >= 420
  const labelW = Math.min(Math.max(...data.map(d => textWidth(d.label))), width * (showEstimate ? 0.32 : 0.38))
  const right = showEstimate ? estimateW + 12 : 0
  const left = PAD + labelW + 10
  const plotW = Math.max(1, width - left - right - PAD)
  const top = 6
  const axisY = top + data.length * ROW
  const height = axisY + 20 + (unit ? 16 : 0) + 4
  const x = (v: number) => left + ((Math.min(max, Math.max(min, v)) - min) / (max - min || 1)) * plotW
  const dot = chartColor(0)

  return (
    <figure ref={ref} className={cn('m-0 min-w-0', className)} data-chart-kind="interval">
      <ChartSvg width={width} height={height} summary={summary}>
        {data.map((_, i) => i % 2 === 1 && <rect key={i} x={0} y={top + ROW * i} width={width} height={ROW} rx={3} fill="var(--fill-hover)" />)}
        {ticks.map(tk => (
          <g key={tk}>
            <line x1={x(tk)} x2={x(tk)} y1={top} y2={axisY} stroke={CHART_INK.grid} strokeWidth={1} shapeRendering="crispEdges" />
            <line x1={x(tk)} x2={x(tk)} y1={axisY} y2={axisY + 4} stroke={CHART_INK.zero} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={x(tk)} y={axisY + 15} textAnchor="middle" fill={CHART_INK.axis} className="tabular-nums">{format(tk)}</text>
          </g>
        ))}
        <line x1={left} x2={left + plotW} y1={axisY} y2={axisY} stroke={CHART_INK.zero} strokeWidth={1} shapeRendering="crispEdges" />
        <line x1={x(reference)} x2={x(reference)} y1={top - 2} y2={axisY} stroke={CHART_INK.axis} strokeWidth={1} strokeDasharray="3 3" data-reference={reference} />
        {unit && <text x={left + plotW / 2} y={axisY + 31} textAnchor="middle" fill={CHART_INK.axis}>{unit}</text>}
        {data.map((d, i) => {
          const cy = top + ROW * i + ROW / 2
          const label = fitLabel(d.label, labelW)
          const hasCi = d.low !== undefined && d.high !== undefined
          const tip = `${d.label}: ${estimate(d)}${unit ? ` ${unit}` : ''}`
          return (
            <g key={`${i}:${d.label}`} data-interval={d.label}>
              <title>{tip}</title>
              <text x={PAD + labelW} y={cy} textAnchor="end" dominantBaseline="middle" fill={CHART_INK.label}>{label}</text>
              {hasCi && (
                <>
                  <line x1={x(d.low!)} x2={x(d.high!)} y1={cy} y2={cy} stroke={CHART_INK.label} strokeWidth={1.5} strokeLinecap="round" />
                  <line x1={x(d.low!)} x2={x(d.low!)} y1={cy - CAP} y2={cy + CAP} stroke={CHART_INK.label} strokeWidth={1.5} strokeLinecap="round" />
                  <line x1={x(d.high!)} x2={x(d.high!)} y1={cy - CAP} y2={cy + CAP} stroke={CHART_INK.label} strokeWidth={1.5} strokeLinecap="round" />
                </>
              )}
              <circle cx={x(d.value)} cy={cy} r={4.5} fill={dot} stroke="var(--background)" strokeWidth={1.5} />
              {showEstimate && (
                <text x={width - PAD} y={cy} textAnchor="end" dominantBaseline="middle" fill={CHART_INK.label} className="tabular-nums">{estimate(d)}</text>
              )}
            </g>
          )
        })}
      </ChartSvg>
      <ChartDataTable data={data} format={format} unit={unit} title={title} interval />
    </figure>
  )
}
