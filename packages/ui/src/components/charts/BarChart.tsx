/**
 * Bars for one series (25 §5): vertical with a value axis and the category under each bar, or
 * horizontal (labels on the left) when there are many categories or their labels don't fit
 * under the bars. Hand-drawn SVG in theme colours; each bar names its value on hover.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CHART_INK, chartColor, chartSummary, cleanData, fitLabel, labelStride, textWidth, valueDomain, type ChartDatum } from './chart-utils'
import { ChartDataTable, ChartEmpty, ChartSvg, useChartFormat, useChartWidth, useKindLabel } from './ChartFrame'

export interface BarChartProps {
  data: ChartDatum[]
  /** Names the chart for screen readers (the visible title is the caller's). */
  title?: string
  unit?: string
  /** `auto` (default): horizontal when there are many categories or long labels. */
  orientation?: 'auto' | 'vertical' | 'horizontal'
  /** One colour per bar (categorical) instead of one for the series. */
  colorByCategory?: boolean
  formatValue?: (n: number) => string
  /** Height of the plot area of a vertical chart, px. */
  plotHeight?: number
  className?: string
}

const PAD = 8
const ROW = 24
const BAR_H = 14

export function BarChart({ data: raw, title, unit, orientation = 'auto', colorByCategory, formatValue, plotHeight = 160, className }: BarChartProps) {
  const { t } = useTranslation()
  const [ref, width] = useChartWidth()
  const format = useChartFormat(formatValue)
  const data = React.useMemo(() => cleanData(raw), [raw])
  const summary = chartSummary({ title, kindLabel: useKindLabel('bar', data.length), data, format, unit, more: n => t('chart.more', { count: n }) })

  if (data.length === 0) return <ChartEmpty className={className} />

  const { ticks, min, max } = valueDomain(data.map(d => d.value))
  const tickLabels = ticks.map(format)
  const axisW = Math.max(...tickLabels.map(l => textWidth(l))) + 6
  const slot = (width - PAD * 2 - axisW) / data.length
  const longest = Math.max(...data.map(d => textWidth(d.label)))
  const horizontal = orientation === 'horizontal' || (orientation === 'auto' && (data.length > 12 || longest > slot - 4))
  const fill = (i: number) => (colorByCategory ? chartColor(i) : chartColor(0))

  return (
    <figure ref={ref} className={cn('m-0 min-w-0', className)} data-chart-kind="bar" data-orientation={horizontal ? 'horizontal' : 'vertical'}>
      {horizontal
        ? <Horizontal data={data} width={width} ticks={ticks} min={min} max={max} format={format} unit={unit} summary={summary} fill={fill} />
        : <Vertical data={data} width={width} ticks={ticks} min={min} max={max} format={format} unit={unit} summary={summary} fill={fill} axisW={axisW} plotHeight={plotHeight} />}
      <ChartDataTable data={data} format={format} unit={unit} title={title} />
    </figure>
  )
}

interface LayoutProps {
  data: ChartDatum[]
  width: number
  ticks: number[]
  min: number
  max: number
  format: (n: number) => string
  unit?: string
  summary: string
  fill: (i: number) => string
}

function Vertical({ data, width, ticks, min, max, format, unit, summary, fill, axisW, plotHeight }: LayoutProps & { axisW: number; plotHeight: number }) {
  const top = unit ? 20 : 10
  const bottom = 22
  const height = top + plotHeight + bottom
  const left = PAD + axisW
  const plotW = Math.max(1, width - left - PAD)
  const slot = plotW / data.length
  const barW = Math.min(48, Math.max(2, slot * 0.68))
  const y = (v: number) => top + plotHeight - ((v - min) / (max - min || 1)) * plotHeight
  const stride = labelStride(data.length, slot, Math.min(Math.max(...data.map(d => textWidth(d.label))), 60))
  const showValues = slot >= Math.max(...data.map(d => textWidth(format(d.value)))) + 2
  return (
    <ChartSvg width={width} height={height} summary={summary}>
      {unit && <text x={PAD} y={10} fill={CHART_INK.axis} dominantBaseline="middle">{unit}</text>}
      {ticks.map(tk => (
        <g key={tk}>
          <line x1={left} x2={width - PAD} y1={y(tk)} y2={y(tk)} stroke={tk === 0 ? CHART_INK.zero : CHART_INK.grid} strokeWidth={1} shapeRendering="crispEdges" />
          <text x={left - 6} y={y(tk)} textAnchor="end" dominantBaseline="middle" fill={CHART_INK.axis} className="tabular-nums">{format(tk)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = left + slot * i + slot / 2
        const y0 = y(Math.max(min, Math.min(0, max)))
        const y1 = y(d.value)
        const label = fitLabel(d.label, Math.max(slot * stride - 4, 12))
        return (
          <g key={`${i}:${d.label}`} data-bar={d.label}>
            <rect x={cx - barW / 2} y={Math.min(y0, y1)} width={barW} height={Math.max(1, Math.abs(y1 - y0))} rx={2} fill={fill(i)}>
              <title>{`${d.label}: ${format(d.value)}${unit ? ` ${unit}` : ''}`}</title>
            </rect>
            {showValues && (
              <text x={cx} y={d.value >= 0 ? y1 - 4 : y1 + 4} textAnchor="middle" dominantBaseline={d.value >= 0 ? 'auto' : 'hanging'} fill={CHART_INK.label} className="tabular-nums">{format(d.value)}</text>
            )}
            {(i % stride === 0 || i === data.length - 1) && (
              <text x={cx} y={top + plotHeight + 15} textAnchor="middle" fill={CHART_INK.label}>
                {label !== d.label && <title>{d.label}</title>}
                {label}
              </text>
            )}
          </g>
        )
      })}
    </ChartSvg>
  )
}

function Horizontal({ data, width, ticks, min, max, format, unit, summary, fill }: LayoutProps) {
  const labelW = Math.min(Math.max(...data.map(d => textWidth(d.label))), width * 0.38)
  const valueW = Math.max(...data.map(d => textWidth(format(d.value)))) + 6
  const left = PAD + labelW + 8
  const plotW = Math.max(1, width - left - valueW - PAD)
  const top = 4
  const height = top + data.length * ROW + 22 + (unit ? 14 : 0)
  const x = (v: number) => left + ((v - min) / (max - min || 1)) * plotW
  const x0 = x(Math.max(min, Math.min(0, max)))
  const axisY = top + data.length * ROW
  return (
    <ChartSvg width={width} height={height} summary={summary}>
      {ticks.map(tk => (
        <g key={tk}>
          <line x1={x(tk)} x2={x(tk)} y1={top} y2={axisY} stroke={tk === 0 ? CHART_INK.zero : CHART_INK.grid} strokeWidth={1} shapeRendering="crispEdges" />
          <text x={x(tk)} y={axisY + 14} textAnchor="middle" fill={CHART_INK.axis} className="tabular-nums">{format(tk)}</text>
        </g>
      ))}
      {unit && <text x={left + plotW / 2} y={axisY + 30} textAnchor="middle" fill={CHART_INK.axis}>{unit}</text>}
      {data.map((d, i) => {
        const cy = top + ROW * i + ROW / 2
        const x1 = x(d.value)
        const label = fitLabel(d.label, labelW)
        return (
          <g key={`${i}:${d.label}`} data-bar={d.label}>
            <text x={PAD + labelW} y={cy} textAnchor="end" dominantBaseline="middle" fill={CHART_INK.label}>
              {label !== d.label && <title>{d.label}</title>}
              {label}
            </text>
            <rect x={Math.min(x0, x1)} y={cy - BAR_H / 2} width={Math.max(1, Math.abs(x1 - x0))} height={BAR_H} rx={2} fill={fill(i)}>
              <title>{`${d.label}: ${format(d.value)}${unit ? ` ${unit}` : ''}`}</title>
            </rect>
            <text x={Math.max(x0, x1) + 4} y={cy} dominantBaseline="middle" fill={CHART_INK.label} className="tabular-nums">{format(d.value)}</text>
          </g>
        )
      })}
    </ChartSvg>
  )
}
