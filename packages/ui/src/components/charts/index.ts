/**
 * The chart kit (25 §5): hand-drawn SVG in theme colours, used by record pages, dashboards and
 * the ```chart markdown block.
 */

export { BarChart, type BarChartProps } from './BarChart'
export { LineChart, type LineChartProps } from './LineChart'
export { DonutChart, type DonutChartProps } from './DonutChart'
export { IntervalChart, type IntervalChartProps } from './IntervalChart'
export { KpiTiles, kpiBelowTarget, type KpiTile, type KpiTilesProps } from './KpiTiles'
export { Chart, type ChartProps } from './Chart'
export {
  CHART_COLORS,
  chartColor,
  niceTicks,
  formatChartNumber,
  chartSummary,
  type ChartDatum,
  type ChartKind,
} from './chart-utils'
