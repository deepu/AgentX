/**
 * The body of a ```chart block (25 §5):
 *
 *   { "kind": "bar" | "line" | "donut" | "interval", "title"?, "data": [ { "label", "value", "low"?, "high"? } ],
 *     "unit"?, "source"? }
 *
 * Parsed strictly enough that a wrong shape says what is wrong; numbers written as strings
 * ("12.5") are accepted.
 */

import type { ChartDatum, ChartKind } from '../charts/chart-utils'

export interface ChartSpec {
  kind: ChartKind
  title?: string
  data: ChartDatum[]
  unit?: string
  /** Where the numbers come from; markdown (links to papers, DOIs). */
  source?: string
  /** Interval charts: where "no effect" is (default 0). */
  reference?: number
}

export type ChartSpecError = 'json' | 'kind' | 'data' | 'empty'

export type ChartSpecResult = { ok: true; spec: ChartSpec } | { ok: false; error: ChartSpecError; detail?: string }

const KINDS: ChartKind[] = ['bar', 'line', 'donut', 'interval']

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number') return String(v)
  return undefined
}

export function parseChartSpec(code: string): ChartSpecResult {
  let raw: unknown
  try {
    raw = JSON.parse(code)
  } catch (err) {
    return { ok: false, error: 'json', detail: err instanceof Error ? err.message : String(err) }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'data' }
  const o = raw as Record<string, unknown>
  const kind = (str(o.kind) ?? 'bar').toLowerCase() as ChartKind
  if (!KINDS.includes(kind)) return { ok: false, error: 'kind', detail: String(o.kind) }
  if (!Array.isArray(o.data)) return { ok: false, error: 'data' }
  const data: ChartDatum[] = []
  for (const [i, item] of o.data.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'data', detail: `data[${i}]` }
    const d = item as Record<string, unknown>
    const label = str(d.label)
    const value = num(d.value)
    if (label === undefined || value === undefined) return { ok: false, error: 'data', detail: `data[${i}]` }
    const low = num(d.low)
    const high = num(d.high)
    data.push({ label, value, ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}) })
  }
  if (data.length === 0) return { ok: false, error: 'empty' }
  const reference = num(o.reference)
  return {
    ok: true,
    spec: {
      kind,
      data,
      ...(str(o.title) ? { title: str(o.title) } : {}),
      ...(str(o.unit) ? { unit: str(o.unit) } : {}),
      ...(str(o.source) ? { source: str(o.source) } : {}),
      ...(reference !== undefined ? { reference } : {}),
    },
  }
}
