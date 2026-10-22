/**
 * The fenced blocks of a MemWise page (docs/memwise/26-projects-and-pages.md §4), read leniently:
 * a page is written by a model, so a block that is mostly right still draws, and one that can't
 * be read says so instead of breaking the page. The same blocks draw in chat messages.
 *
 * Written blocks (frozen when the page is written):
 * - ```tiles    { "tiles": [{ "label": "Trials", "value": "9", "note": "since 2021" }] } (or the array)
 * - ```table    { "title"?, "columns": [{ "key", "label", "changed"? }], "rows": [{ <key>: Cell }], "note"? }
 *               Cell = text | number | { "text", "href"?, "quote"?: { "text", "cite"?, "href"? }, "muted"? }
 * Live blocks (the server fills them in each time the page opens):
 * - ```records  { "entity", "filter"?, "columns"?, "sort"?, "limit"?, "title"? } + "result": { entity, total, columns, rows }
 * - ```subpages { "changes"? } + "pages": [...], "changes": [...]
 */

import { defaultUrlTransform } from 'react-markdown'

export const PAGE_BLOCK_LANGS = new Set(['tiles', 'table', 'records', 'subpages'])

export interface PageTile { label: string; value: string; note?: string }
/**
 * A link a page block (a table cell, a quote, a left-out paper) may carry, through the same
 * `defaultUrlTransform` as Markdown links: javascript:, data:, vbscript: and file: links drop.
 */
export function safeHref(href: unknown): string | undefined {
  const v = typeof href === 'string' ? href.trim() : ''
  return (v && defaultUrlTransform(v)) || undefined
}

export interface PageQuote { text: string; cite?: string; href?: string }
export interface PageCell { text: string; href?: string; quote?: PageQuote; muted?: boolean }
export interface PageTableColumn { key: string; label: string; changed?: boolean }
export interface PageTable { title?: string; columns: PageTableColumn[]; rows: Record<string, PageCell>[]; note?: string }

export interface PageRecordsResult {
  entity: string
  total: number
  columns: { name: string; type: string }[]
  rows: { id: string; title: string; status?: string; values: Record<string, unknown>; refs?: Record<string, string> }[]
}
export interface PageRecords {
  entity: string
  title?: string
  columns?: string[]
  result?: PageRecordsResult
  error?: string
  computedAt?: string
}

export interface PageSubpage {
  id: string
  title: string
  status: 'draft' | 'kept' | 'archived'
  headline: string
  inSummary: boolean
  every?: string
  last?: { kind: string; at: string; byName?: string; text?: string }
}
export interface PageRecentChange { pageId: string; title: string; kind: 'accepted' | 'nothing_new' | 'made' | 'chat'; text?: string; byName?: string; at: string }
export interface PageSubpages { pages?: PageSubpage[]; changes?: PageRecentChange[]; computedAt?: string }

export type ParsedBlock<T> = { ok: true; value: T } | { ok: false; error: 'json' | 'shape' }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined)

function json(code: string): unknown {
  try { return JSON.parse(code) } catch { return undefined }
}

export function parseTiles(code: string): ParsedBlock<PageTile[]> {
  const raw = json(code)
  if (raw === undefined) return { ok: false, error: 'json' }
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.tiles) ? raw.tiles : undefined
  if (!list) return { ok: false, error: 'shape' }
  const tiles: PageTile[] = []
  for (const t of list) {
    if (!isObj(t)) continue
    const label = str(t.label)
    const value = str(t.value)
    if (!label || value === undefined) continue
    const note = str(t.note ?? t.detail)
    tiles.push({ label, value, ...(note ? { note } : {}) })
  }
  return tiles.length ? { ok: true, value: tiles } : { ok: false, error: 'shape' }
}

function cellOf(v: unknown): PageCell | undefined {
  const plain = str(v)
  if (plain !== undefined) return { text: plain }
  if (!isObj(v)) return undefined
  const text = str(v.text ?? v.value)
  if (text === undefined) return undefined
  const href = safeHref(v.href)
  const q = v.quote
  const quote: PageQuote | undefined = typeof q === 'string' ? { text: q }
    : isObj(q) && str(q.text) ? { text: str(q.text)!, ...(str(q.cite) ? { cite: str(q.cite)! } : {}), ...(safeHref(q.href) ? { href: safeHref(q.href)! } : {}) }
      : undefined
  return { text, ...(href ? { href } : {}), ...(quote ? { quote } : {}), ...(v.muted === true ? { muted: true } : {}) }
}

export function parseTable(code: string): ParsedBlock<PageTable> {
  const raw = json(code)
  if (raw === undefined) return { ok: false, error: 'json' }
  if (!isObj(raw) || !Array.isArray(raw.rows)) return { ok: false, error: 'shape' }
  let columns: PageTableColumn[] = Array.isArray(raw.columns)
    ? raw.columns.flatMap((c) => {
      if (typeof c === 'string') return [{ key: c, label: c }]
      if (!isObj(c) || !str(c.key)) return []
      return [{ key: str(c.key)!, label: str(c.label) ?? str(c.key)!, ...(c.changed === true ? { changed: true } : {}) }]
    })
    : []
  const rows = raw.rows.filter(isObj).map((r) => Object.fromEntries(Object.entries(r).flatMap(([k, v]) => {
    const cell = cellOf(v)
    return cell ? [[k, cell]] : []
  })))
  // No columns given: the keys of the rows, in order of first appearance.
  if (!columns.length) columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((k) => ({ key: k, label: k }))
  if (!columns.length) return { ok: false, error: 'shape' }
  return { ok: true, value: { ...(str(raw.title) ? { title: str(raw.title)! } : {}), columns, rows, ...(str(raw.note) ? { note: str(raw.note)! } : {}) } }
}

export function parseRecords(code: string): ParsedBlock<PageRecords> {
  const raw = json(code)
  if (raw === undefined) return { ok: false, error: 'json' }
  if (!isObj(raw)) return { ok: false, error: 'shape' }
  const result = isObj(raw.result) && Array.isArray(raw.result.rows) ? raw.result as unknown as PageRecordsResult : undefined
  return {
    ok: true,
    value: {
      entity: str(raw.entity) ?? '', ...(str(raw.title) ? { title: str(raw.title)! } : {}),
      ...(Array.isArray(raw.columns) ? { columns: raw.columns.filter((c): c is string => typeof c === 'string') } : {}),
      ...(result ? { result } : {}), ...(str(raw.error) ? { error: str(raw.error)! } : {}), ...(str(raw.computedAt) ? { computedAt: str(raw.computedAt)! } : {}),
    },
  }
}

export function parseSubpages(code: string): ParsedBlock<PageSubpages> {
  const raw = json(code.trim() || '{}')
  if (raw === undefined) return { ok: false, error: 'json' }
  if (!isObj(raw)) return { ok: false, error: 'shape' }
  return {
    ok: true,
    value: {
      ...(Array.isArray(raw.pages) ? { pages: raw.pages.filter(isObj) as unknown as PageSubpage[] } : {}),
      ...(Array.isArray(raw.changes) ? { changes: raw.changes.filter(isObj) as unknown as PageRecentChange[] } : {}),
      ...(str(raw.computedAt) ? { computedAt: str(raw.computedAt)! } : {}),
    },
  }
}

/** A record value as one short line of text. */
export function recordValueText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(recordValueText).filter(Boolean).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
