/** One chart by its kind: the ```chart block, record pages and dashboards draw through this. */

import * as React from 'react'
import { BarChart } from './BarChart'
import { DonutChart } from './DonutChart'
import { IntervalChart } from './IntervalChart'
import { LineChart } from './LineChart'
import type { ChartDatum, ChartKind } from './chart-utils'

export interface ChartProps {
  kind: ChartKind
  data: ChartDatum[]
  title?: string
  unit?: string
  formatValue?: (n: number) => string
  className?: string
}

export function Chart({ kind, ...props }: ChartProps) {
  switch (kind) {
    case 'line': return <LineChart {...props} />
    case 'donut': return <DonutChart {...props} />
    case 'interval': return <IntervalChart {...props} />
    default: return <BarChart {...props} />
  }
}
