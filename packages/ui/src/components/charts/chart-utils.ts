/**
 * Pure helpers for the chart kit (25 §5): the colour roles, nice axis ticks, number formatting,
 * rough text widths for laying out SVG labels, and the summary a screen reader hears.
 */

export interface ChartDatum {
  label: string
  value: number
  /** Interval charts: the lower and upper bound of the confidence interval. */
  low?: number
  high?: number
}

export type ChartKind = 'bar' | 'line' | 'donut' | 'interval'

/**
 * Categorical colours, in order: theme roles (tokens.css), so every theme and mode gets its own
 * contrast-solved value. One series takes the first; a donut walks the list.
 */
export const CHART_COLORS = ['var(--accent)', 'var(--info)', 'var(--success)', 'var(--destructive)', 'var(--text-tertiary)'] as const

export const CHART_INK = {
  /** Category labels, the interval lines. */
  label: 'var(--text-secondary)',
  /** Tick labels, the unit, the reference line. */
  axis: 'var(--text-tertiary)',
  grid: 'var(--border)',
  zero: 'var(--border-strong)',
  area: 'var(--accent-tint)',
} as const

export function chartColor(i: number): string {
  return CHART_COLORS[((i % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length]!
}

/** Font size of the labels drawn in SVG (label-sm). */
export const CHART_FONT = 11

/** A step of 1, 2, 2.5 or 5 times a power of ten near `span / count`. */
function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * pow
}

/** Round off floating-point noise from tick arithmetic (0.30000000000000004 → 0.3). */
function clean(n: number): number {
  return Number.parseFloat(n.toPrecision(12))
}

/**
 * Evenly spaced round ticks covering [min, max], about `count` of them. The first tick is at or
 * below `min` and the last at or above `max`, so they are the axis's domain.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min > max) [min, max] = [max, min]
  if (min === max) {
    if (min === 0) return [0, 1]
    const pad = Math.abs(min) * 0.5
    ;[min, max] = min > 0 ? [0, max + pad] : [min - pad, 0]
  }
  const step = niceStep(max - min, count)
  const start = Math.floor(clean(min / step)) * step
  const end = Math.ceil(clean(max / step)) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(clean(v))
  return ticks
}

/** The axis domain for values that should include zero (bars) or a reference line. */
export function valueDomain(values: number[], include: number[] = [0], count = 5): { ticks: number[]; min: number; max: number } {
  const all = [...values, ...include].filter(Number.isFinite)
  const ticks = niceTicks(Math.min(...all), Math.max(...all), count)
  return { ticks, min: ticks[0]!, max: ticks[ticks.length - 1]! }
}

/** A number for a chart label: grouped, with as many decimals as its size needs (at most 2). */
export function formatChartNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs === 0 || abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n)
  } catch {
    return String(Number(n.toFixed(digits)))
  }
}

/** Roughly how wide a label renders at `fontSize` (average glyph ≈ 0.58em; digits are narrower). */
export function textWidth(text: string, fontSize = CHART_FONT): number {
  let w = 0
  for (const ch of text) w += /[0-9.,\s]/.test(ch) ? 0.55 : /[A-Z@WMmw]/.test(ch) ? 0.75 : /[　-鿿＀-￯]/.test(ch) ? 1 : 0.58
  return w * fontSize
}

/** A label cut to fit `maxWidth` px, with an ellipsis (the full text stays in its <title>). */
export function fitLabel(text: string, maxWidth: number, fontSize = CHART_FONT): string {
  if (textWidth(text, fontSize) <= maxWidth) return text
  let out = text
  while (out.length > 1 && textWidth(`${out}…`, fontSize) > maxWidth) out = out.slice(0, -1)
  return `${out.trimEnd()}…`
}

/** Data a chart can draw: finite values with a label; intervals keep only finite bounds. */
export function cleanData(data: ChartDatum[]): ChartDatum[] {
  return data
    .filter(d => d && Number.isFinite(d.value))
    .map(d => ({
      label: String(d.label ?? ''),
      value: d.value,
      ...(Number.isFinite(d.low) ? { low: d.low } : {}),
      ...(Number.isFinite(d.high) ? { high: d.high } : {}),
    }))
}

/** One datum in words: "2021: 12", "Drug A vs placebo: −1.2 (−2.0 to −0.4) mmHg". */
export function datumText(d: ChartDatum, format: (n: number) => string, unit?: string): string {
  const u = unit ? ` ${unit}` : ''
  const range = d.low !== undefined && d.high !== undefined ? ` (${format(d.low)} – ${format(d.high)})` : ''
  return `${d.label}: ${format(d.value)}${range}${u}`
}

/**
 * The text a screen reader hears for a chart (its aria-label): the title, what kind of chart with
 * how many items, then the first items in words.
 */
export function chartSummary(opts: {
  title?: string
  kindLabel: string
  data: ChartDatum[]
  format: (n: number) => string
  unit?: string
  more?: (count: number) => string
  limit?: number
}): string {
  const { title, kindLabel, data, format, unit, more, limit = 12 } = opts
  const shown = data.slice(0, limit).map(d => datumText(d, format, unit))
  const rest = data.length - shown.length
  const items = shown.join('; ') + (rest > 0 ? `; ${more ? more(rest) : `+${rest}`}` : '')
  return [title, kindLabel].filter(Boolean).join('. ') + (items ? `: ${items}` : '')
}

/** Every `step`-th label so labels of `width` fit `slot` px each (the first and last always show). */
export function labelStride(count: number, slot: number, width: number): number {
  if (slot <= 0) return count
  return Math.max(1, Math.ceil((width + 6) / slot))
}

/** Folds a donut's items beyond `max` into one "Other" slice (the largest keep their colour). */
export function foldSlices(data: ChartDatum[], max: number, otherLabel: string): ChartDatum[] {
  const positive = data.filter(d => d.value > 0)
  if (positive.length <= max) return positive
  const keep = new Set([...positive].sort((a, b) => b.value - a.value).slice(0, max - 1))
  const kept = positive.filter(d => keep.has(d))
  const other = positive.filter(d => !keep.has(d)).reduce((s, d) => s + d.value, 0)
  return [...kept, { label: otherLabel, value: other }]
}
