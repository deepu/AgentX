/**
 * Pure helpers for the Phase 6 screens: field values and their sources in plain words, record
 * page layouts, lifecycles, review drafts, queue mode keys, table and diff review, dashboards.
 */

import type { TFunction } from 'i18next'
import type {
  MwCaseValue,
  MwChartData,
  MwDashboardBlock,
  MwInboxItem,
  MwPageBlock,
  MwPageLayout,
  MwRecordField,
  MwRecordFieldSource,
  MwRecordKpi,
  MwRecordPage,
  MwRecordReview,
  MwTextView,
  MwTransitionOption,
  MwTreeNode,
} from '@memwise/shared/protocol'
import type { KpiTile } from '@memwise/ui'
import type { TextQuote } from './quote-highlight'
import { absoluteTime, formatCell, formatMoney, formatValueInline, humanize, isDocumentValue, isMoney, isNegativeOutcome, isYearField, sortInbox } from '../format'

// ---------------------------------------------------------------- values

/** A record status in words: `in_qc` → "In QC", `activating` → "Activating". */
export function statusLabel(status: string | undefined): string {
  if (!status) return ''
  return humanize(status).replace(/\bQc\b/i, 'QC')
}

export type StatusTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'

const TONES: [RegExp, StatusTone][] = [
  [/^(open|filed|active|done|approved|complete|completed|passed|signed)$/, 'success'],
  [/^(missing|sent_back|rejected|failed|overdue|late)$/, 'destructive'],
  [/^(closed|superseded|archived|withdrawn|closing|stopped|retired)$/, 'muted'],
  [/^(selected|draft|planned|received|new)$/, 'info'],
]

/** A status's colour: done-like green, trouble red, ended grey, the rest (in progress) amber. */
export function statusTone(status: string | undefined): StatusTone {
  if (!status) return 'muted'
  for (const [re, tone] of TONES) if (re.test(status)) return tone
  return 'warning'
}

export const TONE_PILL: Record<StatusTone, string> = {
  success: 'bg-success-tint text-success',
  info: 'bg-info-tint text-info',
  warning: 'bg-accent-tint text-accent',
  destructive: 'bg-destructive-tint text-destructive',
  muted: 'bg-fill-hover text-secondary',
}

/** The base of a type expression: `Ref<Person>` → "Ref", `List<Flag>` → "List". */
export function baseType(type: string): string {
  return type.replace(/[<([].*$/, '').trim()
}

/** The choices of an `Enum[a, b]` type expression, else undefined. */
export function enumChoices(type: string | undefined): string[] | undefined {
  const m = type ? /^Enum\[(.*)\]$/.exec(type.trim()) : null
  return m ? m[1]!.split(',').map(s => s.trim()).filter(Boolean) : undefined
}

/** A table review's edited cell, kept as its column's type: a number stays a number. */
export function editedCell(type: string | undefined, text: string): unknown {
  if (type && baseType(type) === 'Number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text)
  return text
}

/** A percent type: `Percentage` as the definitions write it (`Percent` is accepted too). */
export function isPercentType(base: string): boolean {
  return base === 'Percentage' || base === 'Percent'
}

/** The target of a `Ref<X>`/`List<X>` type, else undefined. */
export function typeTarget(type: string): string | undefined {
  return /<\s*([\w.]+)\s*>/.exec(type)?.[1]
}

/** A date-only value in the reader's language (no time, no time-zone shift). */
export function formatDate(value: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return absoluteTime(value, locale)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(d)
}

export function formatPercent(value: number, locale?: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
}

/** One value by its declared type: percents, dates, money, references by title, documents by name. */
export function formatTypedValue(type: string, value: unknown, t: TFunction, locale?: string, ref?: { title: string }, name?: string): string {
  if (ref) return ref.title
  if (value === null || value === undefined || value === '') return t('memwise.case.noValue')
  const base = baseType(type)
  if (typeof value === 'number' && Number.isInteger(value) && isYearField(name)) return String(value)
  if (isPercentType(base) && typeof value === 'number') return formatPercent(value, locale)
  if (base === 'Date' && typeof value === 'string') return formatDate(value, locale)
  if ((base === 'DateTime' || base === 'Timestamp') && typeof value === 'string') return absoluteTime(value, locale)
  if ((base === 'Lifecycle' || base === 'Status' || base === 'Enum') && typeof value === 'string') return statusLabel(value)
  if (base === 'Money' && isMoney(value)) return formatMoney(value, locale)
  if (base === 'Address' && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>).filter(v => typeof v === 'string' && v).join(', ')
  }
  if (isDocumentValue(value)) return value.name
  return formatValueInline(value, t, locale)
}

export function formatFieldValue(field: Pick<MwRecordField, 'type' | 'value' | 'ref'> & { name?: string }, t: TFunction, locale?: string): string {
  return formatTypedValue(field.type, field.value, t, locale, field.ref, field.name)
}

// ---------------------------------------------------------------- sources

export type SourceTone = 'memwise' | 'plugin' | 'link' | 'calculated' | 'agent' | 'person'

/** Where a field's value comes from, in plain words ("from EDC", "Calculated", "Agent, from Activate a site", "Priya Shah"). */
export function fieldSourceLabel(source: MwRecordFieldSource, t: TFunction): string {
  switch (source.kind) {
    case 'domain': return t('memwise.record.source.memwise')
    case 'plugin': return source.title ?? humanize(source.plugin)
    case 'link': return t('memwise.record.source.link', { domain: source.domainName ?? humanize(source.domain) })
    case 'calculated': return t('memwise.record.source.calculated')
    case 'step': return source.label ? t('memwise.record.source.step', { playbook: source.label }) : t('memwise.record.source.stepAny')
    case 'person': return source.name ?? t('memwise.record.source.person')
    case 'source': return humanize(source.source)
  }
}

export function fieldSourceTone(source: MwRecordFieldSource): SourceTone {
  switch (source.kind) {
    case 'domain': return 'memwise'
    case 'plugin':
    case 'source': return 'plugin'
    case 'link': return 'link'
    case 'calculated': return 'calculated'
    case 'step': return 'agent'
    case 'person': return 'person'
  }
}

export const SOURCE_TONE_CLASS: Record<SourceTone, string> = {
  memwise: 'bg-fill-hover text-secondary',
  plugin: 'bg-info-tint text-info',
  link: 'bg-info-tint text-info',
  calculated: 'bg-fill-hover text-secondary',
  agent: 'bg-accent-tint text-accent',
  person: 'bg-success-tint text-success',
}

// ---------------------------------------------------------------- layout

export type AreaName = 'main' | 'left' | 'right' | 'side' | 'below'

/** The columns a layout draws, in order, then `below` across the page. */
export function layoutColumns(layout: MwPageLayout): { columns: AreaName[]; below: boolean } {
  const columns: AreaName[] = layout.layout === 'split' ? ['left', 'right'] : layout.layout === 'sidebar' ? ['main', 'side'] : ['main']
  return { columns, below: (layout.areas.below?.length ?? 0) > 0 }
}

/** The blocks of an area; `details` is added to the first area when the layout left it out (24 §6). */
export function areaBlocks(layout: MwPageLayout, area: AreaName): MwPageBlock[] {
  const blocks = layout.areas[area] ?? []
  const first = layoutColumns(layout).columns[0]
  const all = Object.values(layout.areas).flat()
  if (area === first && !all.some(b => b?.kind === 'details')) return [...blocks, { kind: 'details' }]
  return blocks
}

/**
 * A `related` block's names: `versions` and `signatures` are the record's own history (24 §6:
 * "`related` also accepts `versions` and `signatures`"), drawn by the History block, once; the
 * rest are relationships.
 */
export function splitRelated(layout: MwPageLayout, names: string[]): { relationships: string[]; history: boolean } {
  const own = new Set(['versions', 'signatures'])
  const historyBlock = Object.values(layout.areas).flat().some(b => b?.kind === 'history')
  return { relationships: names.filter(n => !own.has(n)), history: !historyBlock && names.some(n => own.has(n)) }
}

/** The header's extra fields (not title or status), with their values. */
export function headerFields(page: MwRecordPage): MwRecordField[] {
  return page.layout.header
    .filter(name => name !== 'title' && name !== 'status')
    .map(name => page.fields.find(f => f.name === name))
    .filter((f): f is MwRecordField => !!f && !f.hidden && f.value !== null && f.value !== undefined)
}

/** The fields a `fields` block names, in its order (unknown names are skipped). */
export function blockFields(page: MwRecordPage, names: string[]): MwRecordField[] {
  return names.map(n => page.fields.find(f => f.name === n)).filter((f): f is MwRecordField => !!f)
}

/** `details`: every field not already shown by a `fields` block, the viewer or a KPI tile. */
export function detailFields(page: MwRecordPage): MwRecordField[] {
  const shown = new Set<string>(['status'])
  for (const b of Object.values(page.layout.areas).flat()) {
    if (b?.kind === 'fields') b.fields.forEach(f => shown.add(f))
    if (b?.kind === 'viewer') shown.add(b.field)
    if (b?.kind === 'kpis') b.fields.forEach(f => shown.add(f))
  }
  return page.fields.filter(f => !shown.has(f.name))
}

// ---------------------------------------------------------------- lifecycle

export interface LifecycleStep { name: string; label: string; state: 'done' | 'current' | 'todo' }

/** The lifecycle as a row of steps: the ones before the current state done, the rest to come. */
export function lifecycleSteps(states: string[], current?: string, passed?: string[]): LifecycleStep[] {
  const at = current ? states.indexOf(current) : -1
  // With the way the record took (`passed`), a state it skipped isn't ticked (kept → rejected).
  const done = (name: string, i: number) => (passed ? passed.includes(name) : i < at)
  return states.map((name, i) => ({ name, label: statusLabel(name), state: at < 0 ? 'todo' : i === at ? 'current' : done(name, i) ? 'done' : 'todo' }))
}

/** "Move to Open" for a transition button. */
export function transitionLabel(tr: Pick<MwTransitionOption, 'to' | 'label'>, t: TFunction): string {
  return t('memwise.record.moveTo', { state: statusLabel(tr.to) })
}

/** Why a transition can't be made now, in words: the server's reason, else its guard. */
export function transitionBlockedReason(tr: MwTransitionOption, t: TFunction): string | undefined {
  if (tr.allowed) return undefined
  // The kernel's reason is a sentence fragment ("only a playbook step can make …"): start it as a sentence.
  if (tr.reason) return tr.reason.charAt(0).toUpperCase() + tr.reason.slice(1)
  if (tr.guard && !tr.guard.holds) return t('memwise.record.guardNotMet', { condition: tr.guard.condition })
  return t('memwise.record.notAllowed')
}

// ---------------------------------------------------------------- checks

/**
 * The engine's own checks on an agent's answer (its outcome is declared, its required tools ran,
 * each value has its type and source: "writes.site: Ref<Site>"). Passed, they fold into one line;
 * the domain's checks, written for people, stay as they are.
 */
export function isStructuralCheck(rule: string): boolean {
  return rule === 'outcome is declared' || rule === 'required tools called' || rule.startsWith('writes.')
}

// ---------------------------------------------------------------- filter

/**
 * An example filter for the Records filter box, from the entity's own fields: its first status
 * (`status = 'draft'`) and one of its choice or number fields (`study_type = 'randomised_trial'`,
 * `year > 0`), so the hint never names a field the entity doesn't have.
 */
export function filterExample(type: { fields: { name: string; type: string }[]; lifecycle?: string[] }): string {
  const parts: string[] = []
  if (type.lifecycle?.[0]) parts.push(`status = '${type.lifecycle[0]}'`)
  const choice = type.fields.find(f => f.name !== 'status' && enumChoices(f.type)?.length)
  const number = type.fields.find(f => baseType(f.type) === 'Number')
  if (choice) parts.push(`${choice.name} = '${enumChoices(choice.type)![0]}'`)
  else if (number) parts.push(`${number.name} > 0`)
  if (parts.length === 0) {
    const text = type.fields.find(f => baseType(f.type) === 'Text')
    if (text) parts.push(`${text.name} is set`)
  }
  return parts.slice(0, 2).join(' and ')
}

// ---------------------------------------------------------------- related

/** Up to two columns for a related table: not the status (it has its pill), nor a value that only repeats the row's title. */
export function relatedColumns(rows: { title: string; values: Record<string, unknown> }[]): string[] {
  return [...new Set(rows.flatMap(r => Object.keys(r.values)))]
    .filter(c => c !== 'status' && !rows.every(r => r.values[c] === undefined || r.values[c] === r.title))
    .slice(0, 2)
}

/** A board card's lines: up to two columns, not the one it is grouped by, nor one whose value its title already shows. */
export function cardColumns<C extends { name: string }>(columns: C[], rows: { title: string; values: Record<string, unknown> }[], group: string): C[] {
  const inTitle = (r: { title: string; values: Record<string, unknown> }, c: string) => {
    const v = r.values[c]
    return v === undefined || v === null || v === '' || (typeof v === 'string' && r.title.includes(v))
  }
  return columns.filter(c => c.name !== group && !rows.every(r => inTitle(r, c.name))).slice(0, 2)
}

/** A value too long for a table cell: free text over this many characters (an abstract, a quote). */
export const LONG_VALUE_CHARS = 120

const isLongValue = (v: unknown): boolean =>
  typeof v === 'string' ? v.length > LONG_VALUE_CHARS || v.includes('\n') : Array.isArray(v) ? v.some(isLongValue) : false

/** A records table column: the query result's, or one the definition has that the result left out. */
export interface RecordColumn { name: string; label: string; type: string; calculated?: boolean; followed?: boolean }

/**
 * Every column a records table can show, in the definition's order (fields, calculated fields,
 * then the status when it has a lifecycle), whatever the last query asked for: the Columns menu
 * lists them all, so a column turned off can be turned on again.
 */
export function recordColumns(
  type: { fields: { name: string; type: string }[]; lifecycle?: string[]; definition?: { calculated?: { name: string }[] } },
  result?: RecordColumn[] | null,
): RecordColumn[] {
  const from = new Map((result ?? []).map(c => [c.name, c]))
  const out: RecordColumn[] = []
  const add = (c: RecordColumn) => { if (!out.some(x => x.name === c.name)) out.push(from.get(c.name) ?? c) }
  for (const f of type.fields) add({ name: f.name, label: humanize(f.name), type: f.type })
  for (const c of type.definition?.calculated ?? []) add({ name: c.name, label: humanize(c.name), type: 'Number', calculated: true })
  for (const c of result ?? []) if (c.name !== 'status') add(c)
  if (type.lifecycle?.length || from.has('status')) add({ name: 'status', label: humanize('status'), type: 'Lifecycle' })
  return out
}

/**
 * The columns a records table shows when nobody chose any. The entity's `list:` when it has one;
 * else up to `max` short fields in their order, leaving out long free text (any value over
 * LONG_VALUE_CHARS), fields no row has a value for, and fields the row's title already shows
 * (those in its `title:` template, or whose value is in every title), then its status. The
 * Columns menu can add the rest.
 */
export function defaultColumns<C extends { name: string }>(
  columns: C[], rows: { title: string; values: Record<string, unknown> }[], opts: { list?: string[]; title?: string; max?: number } = {},
): C[] {
  if (opts.list?.length) return opts.list.flatMap(n => columns.filter(c => c.name === n))
  const max = opts.max ?? 6
  const status = columns.filter(c => c.name === 'status')
  const fields = columns.filter(c => c.name !== 'status')
  const inTemplate = new Set(opts.title ? [...opts.title.matchAll(/\{([^{}]+)\}/g)].map(m => m[1]!.trim()) : [])
  if (rows.length === 0) return [...fields.filter(c => !inTemplate.has(c.name)).slice(0, max - status.length), ...status]
  const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  const short = fields.filter(c => {
    if (inTemplate.has(c.name)) return false
    const values = rows.map(r => r.values[c.name])
    if (values.every(empty)) return false
    if (values.some(isLongValue)) return false
    return !rows.every(r => empty(r.values[c.name]) || (typeof r.values[c.name] === 'string' && r.title.includes(r.values[c.name] as string)))
  })
  return [...short.slice(0, max - status.length), ...status]
}

/**
 * Rows in their groups, in the result's group order: the key (null: no value), its title (a
 * reference's record title), its count and rows. `group` "status" falls back to the row's status.
 */
export function groupRows<R extends { values: Record<string, unknown>; status?: string; refs?: Record<string, { title: string }> }>(
  result: { rows: R[]; groups?: { key: string | null; count: number; title?: string }[] }, group: string,
): { key: string | null; title: string | null; count: number; rows: R[] }[] {
  const keyOf = (row: R) => {
    const v = row.values[group] ?? (group === 'status' ? row.status : undefined)
    return v === null || v === undefined || v === '' ? null : String(v)
  }
  // The result's groups first (their order and counts), then any a row has that they leave out.
  const keys = [...new Set([...(result.groups?.map(g => g.key) ?? []), ...result.rows.map(keyOf)])]
  return keys.map(k => {
    const rows = result.rows.filter(r => keyOf(r) === k)
    const g = result.groups?.find(x => x.key === k)
    return { key: k, title: k === null ? null : g?.title ?? rows.find(r => r.refs?.[group])?.refs?.[group]?.title ?? k, count: g?.count ?? rows.length, rows }
  })
}

// ---------------------------------------------------------------- chart

/** Bars for a `chart` block: the related rows of `of`, counted by their `by` value (status by default). */
export function chartData(page: MwRecordPage, block: Extract<MwPageBlock, { kind: 'chart' }>): { label: string; value: number }[] {
  const related = page.related[block.of]
  if (related) {
    const by = block.by ?? 'status'
    const counts = new Map<string, number>()
    for (const row of related.rows) {
      const v = row.values[by] ?? (by === 'status' ? row.status : undefined)
      const key = v === null || v === undefined || v === '' ? '—' : String(v)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].map(([label, value]) => ({ label: by === 'status' ? statusLabel(label) : label, value }))
  }
  const f = page.fields.find(x => x.name === block.of)
  if (f && typeof f.value === 'number') return [{ label: f.label, value: f.value }]
  return []
}

/** A chart's rows as the kernel computed them (25 §5). */
export type ChartView = MwChartData

/** A KPI tile's value from the kernel (25 §5). */
export type KpiView = MwRecordKpi

/** The kit's rows for a chart: a row with its own unit (the chart has none) says it in its label. */
export function chartRows(chart: ChartView): { label: string; value: number; low?: number; high?: number }[] {
  return chart.data.map(d => {
    // A group's raw value in snake case (an enum like "phase_3") reads as words: "Phase 3".
    const label = d.key && d.label === d.key && /^[a-z0-9]+(_[a-z0-9]+)+$/.test(d.key) ? statusLabel(d.key) : d.label
    return {
      label: d.unit && !chart.unit ? `${label} (${d.unit})` : label,
      value: d.value,
      ...(d.low !== undefined && d.low !== null ? { low: d.low } : {}),
      ...(d.high !== undefined && d.high !== null ? { high: d.high } : {}),
    }
  })
}

/** A record page `chart` block the server sent no rows for: its related rows counted by `by`. */
export function fallbackChart(page: MwRecordPage, block: Extract<MwPageBlock, { kind: 'chart' }>): ChartView | null {
  const kind = block.chart
  if (kind !== 'bar' && kind !== 'line' && kind !== 'donut') return null
  const data = chartData(page, block)
  return { kind, data, total: data.reduce((s, d) => s + d.value, 0) }
}

/** The tiles of a `kpis` block: each field's label and value (the server's, else the page field's). */
export function kpiTiles(page: MwRecordPage, fields: string[], kpis: Record<string, KpiView> | undefined, t: TFunction, locale?: string): KpiTile[] {
  return fields.map(name => {
    const field = page.fields.find(f => f.name === name)
    const kpi = kpis?.[name]
    const type = kpi?.type ?? field?.type ?? 'Number'
    const raw = kpi ? kpi.value : field?.value
    const label = field?.label ?? humanize(name)
    if (field?.hidden) return { label, value: null, display: t('memwise.case.restrictedValue') }
    if (typeof raw === 'number') return { label, value: raw, format: isPercentType(baseType(type)) ? 'percent' : 'number', detail: kpi?.description }
    if (raw === null || raw === undefined || raw === '') return { label, value: null, detail: kpi?.description }
    return { label, value: null, display: formatTypedValue(type, raw, t, locale), detail: kpi?.description }
  })
}

// ---------------------------------------------------------------- text viewer (25 §4)

/** A Text viewer's quotes from the kernel's highlights: the field in words, and the value or record it backs. */
export function textQuotes(page: MwRecordPage, view: MwTextView, t: TFunction, locale?: string): TextQuote[] {
  return view.highlights.map(h => {
    const field = page.fields.find(f => f.name === h.field)
    const valueText = h.kind === 'related'
      ? h.record?.title
      : h.value !== undefined && h.value !== null ? formatTypedValue(field?.type ?? '', h.value, t, locale) : undefined
    return {
      quote: h.quote,
      label: h.label || field?.label || humanize(h.field),
      field: h.field,
      found: h.found,
      ...(h.start !== undefined ? { start: h.start } : {}),
      ...(h.end !== undefined ? { end: h.end } : {}),
      ...(valueText ? { valueText } : {}),
    }
  })
}

/** The record's values that have a quote in one of its Text viewers: field → which viewer and highlight. */
export function valueQuoteTargets(page: MwRecordPage): Map<string, { field: string; index: number }> {
  const out = new Map<string, { field: string; index: number }>()
  for (const [viewer, view] of Object.entries(page.texts ?? {})) {
    view.highlights.forEach((h, index) => {
      if (h.kind === 'value' && h.found && !out.has(h.field)) out.set(h.field, { field: viewer, index })
    })
  }
  return out
}

// ---------------------------------------------------------------- review

export type ReviewDraft = Record<string, unknown>

export function initialReviewDraft(review: MwRecordReview): ReviewDraft {
  return Object.fromEntries(review.proposed.map(p => [p.field, p.value]))
}

/** The fields the person changed from what was proposed. */
export function changedReviewFields(review: MwRecordReview, draft: ReviewDraft): string[] {
  return review.proposed.filter(p => JSON.stringify(draft[p.field] ?? null) !== JSON.stringify(p.value ?? null)).map(p => p.field)
}

/** Required proposed values left empty. */
export function missingReviewFields(review: MwRecordReview, draft: ReviewDraft): string[] {
  return review.proposed.filter(p => p.required && (draft[p.field] === null || draft[p.field] === undefined || draft[p.field] === '')).map(p => p.field)
}

/** The approving outcome of a review (the first that isn't a send-back), and the send-back one. */
export function reviewOutcomes(outcomes: string[]): { approve?: string; sendBack?: string } {
  return { approve: outcomes.find(o => !isNegativeOutcome(o)), sendBack: outcomes.find(o => isNegativeOutcome(o)) }
}

/** "very sure" / "fairly sure" / "unsure" for a 0..1 confidence. */
export function confidenceLabel(confidence: number | undefined, t: TFunction): string | undefined {
  if (confidence === undefined) return undefined
  if (confidence >= 0.9) return t('memwise.review.confidence.high')
  if (confidence >= 0.7) return t('memwise.review.confidence.medium')
  return t('memwise.review.confidence.low')
}

export type QueueKeyAction = 'approve' | 'sendBack' | 'next' | 'previous'

/** Queue mode keys: a approve, s send back, j/k next/previous, only when no field has the focus. */
export function queueKeyAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: unknown }): QueueKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return null
  switch (e.key) {
    case 'a': return 'approve'
    case 's': return 'sendBack'
    case 'j': return 'next'
    case 'k': return 'previous'
    default: return null
  }
}

export type ReviewItem = Extract<MwInboxItem, { kind: 'input' | 'decision' }>

export function isReviewItem(item: MwInboxItem | null | undefined, kind?: 'document' | 'table' | 'diff'): item is ReviewItem {
  if (!item || (item.kind !== 'input' && item.kind !== 'decision') || !item.review) return false
  return !kind || item.review.kind === kind
}

/** The inbox items of the same kind as `item` (same review kind, playbook and step), newest first. */
export function sameKindItems(inbox: MwInboxItem[], item: ReviewItem): ReviewItem[] {
  return sortInbox(inbox).filter((i): i is ReviewItem =>
    isReviewItem(i, item.review!.kind as 'document' | 'table' | 'diff') && i.workflowId === item.workflowId && i.stepTitle === item.stepTitle)
}

/** The next (or previous) item of the same kind after `itemId`; after a decision the current item is gone, so the first left. */
export function queueNeighbour(inbox: MwInboxItem[], current: ReviewItem, dir: 1 | -1 = 1): ReviewItem | undefined {
  const list = sameKindItems(inbox, current)
  const at = list.findIndex(i => i.id === current.id)
  if (at < 0) return list[0]
  return list[at + dir]
}

/** The first document review in the inbox: where "Review in a row" starts. */
export function firstDocumentReview(inbox: MwInboxItem[]): ReviewItem | undefined {
  return sortInbox(inbox).find((i): i is ReviewItem => isReviewItem(i, 'document'))
}

// ---------------------------------------------------------------- table review

export interface TableRow { index: number; value: Record<string, unknown>; confidence?: number; why?: string }
export type RowDecision = 'accept' | 'reject' | 'pending'

const META_KEYS = new Set(['confidence', 'why', 'rationale', 'reason'])

/** The rows a table review shows, from the List field's prefill. */
export function tableRows(prefill: MwCaseValue | undefined): TableRow[] {
  const list = Array.isArray(prefill?.value) ? prefill!.value as unknown[] : []
  const fallbackWhy = prefill?.provenance.kind === 'judgement' ? prefill.provenance.rationale : undefined
  return list.map((v, index) => {
    const value = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : { value: v }) as Record<string, unknown>
    const confidence = typeof value.confidence === 'number' ? value.confidence : undefined
    const why = ['why', 'rationale', 'reason'].map(k => value[k]).find((x): x is string => typeof x === 'string' && !!x) ?? fallbackWhy
    return { index, value, confidence, why }
  })
}

/** The columns of a table review: every key of the rows except confidence and why. */
export function tableColumns(rows: TableRow[]): string[] {
  const keys: string[] = []
  for (const r of rows) for (const k of Object.keys(r.value)) if (!META_KEYS.has(k) && !keys.includes(k)) keys.push(k)
  return keys
}

/**
 * A list of records' columns for display: the row type's order when known (`itemTypes`; stored rows
 * come back with their keys reordered), without a Ref column whose record titles the row's own
 * `title` already shows (a screening's paper beside its title).
 */
export function orderRowColumns(keys: string[], rows: Record<string, unknown>[], itemTypes?: Record<string, string>, titles?: Record<string, string>): string[] {
  const ordered = itemTypes ? [...Object.keys(itemTypes).filter(c => keys.includes(c)), ...keys.filter(c => !(c in itemTypes))] : keys
  return ordered.filter(c => !(itemTypes?.[c]?.startsWith('Ref<') && keys.includes('title') && rows.length > 0
    && rows.every(r => typeof r[c] === 'string' && !!titles?.[r[c] as string] && titles[r[c] as string] === r.title)))
}

/** One cell of a list of records: by its column's type when known, a Ref by its record's title, a year as a year. */
export function formatRowCell(column: string, cell: unknown, t: TFunction, locale: string | undefined, itemTypes?: Record<string, string>, titles?: Record<string, string>): string {
  const title = typeof cell === 'string' ? titles?.[cell] : undefined
  if (itemTypes?.[column]) return formatTypedValue(itemTypes[column]!, cell, t, locale, title ? { title } : undefined, column)
  return formatCell(column, title ?? cell, t, locale)
}

/** "Accept all at 90% or higher": accept every pending row at or above the threshold. */
export function acceptAllAbove(rows: TableRow[], decisions: Record<number, RowDecision>, threshold = 0.9): Record<number, RowDecision> {
  const next = { ...decisions }
  for (const r of rows) if ((next[r.index] ?? 'pending') === 'pending' && (r.confidence ?? 0) >= threshold) next[r.index] = 'accept'
  return next
}

/** The list to submit: accepted rows (with their edits), rejected ones left out. Pending rows block approval. */
export function tableSubmission(rows: TableRow[], decisions: Record<number, RowDecision>, edits: Record<number, Record<string, unknown>>): { pending: number; values: Record<string, unknown>[] } {
  let pending = 0
  const values: Record<string, unknown>[] = []
  for (const r of rows) {
    const d = decisions[r.index] ?? 'pending'
    if (d === 'pending') pending++
    if (d === 'accept') values.push({ ...r.value, ...(edits[r.index] ?? {}) })
  }
  return { pending, values }
}

// ---------------------------------------------------------------- diff review

export interface DiffRow { field: string; before: unknown; after: unknown; changed: boolean }

export function diffRows(before: Record<string, unknown>, after: Record<string, unknown>): DiffRow[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return fields.map(field => ({
    field,
    before: before[field],
    after: after[field],
    changed: JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  })).sort((a, b) => Number(b.changed) - Number(a.changed))
}

// ---------------------------------------------------------------- dashboard

export type HeatBucket = 'top' | 'good' | 'fair' | 'low' | 'none'

/** Heatmap buckets on a 0..100 scale: 95–100, 85–94, 70–84, below 70, no value. */
export function heatBucket(value: number | null): HeatBucket {
  if (value === null || value === undefined || Number.isNaN(value)) return 'none'
  if (value >= 95) return 'top'
  if (value >= 85) return 'good'
  if (value >= 70) return 'fair'
  return 'low'
}

export const HEAT_CLASS: Record<HeatBucket, string> = {
  top: 'bg-success-solid/45 text-foreground',
  good: 'bg-success-solid/20 text-foreground',
  fair: 'bg-accent-solid/20 text-foreground',
  low: 'bg-destructive-solid/35 text-foreground',
  none: 'bg-fill-hover text-tertiary',
}

export function kpiValue(block: Extract<MwDashboardBlock, { kind: 'kpi' }>, t: TFunction, locale?: string): string {
  if (block.value === null) return t('memwise.dashboard.noValue')
  return block.format === 'percent' ? formatPercent(block.value, locale) : new Intl.NumberFormat(locale).format(block.value)
}

/** Whether a KPI with a target is below it. */
export function kpiBelowTarget(block: Extract<MwDashboardBlock, { kind: 'kpi' }>): boolean {
  return block.target !== undefined && block.value !== null && block.value < block.target
}

// ---------------------------------------------------------------- tree

export type TreeEntry =
  | { node: Extract<MwTreeNode, { kind: 'record' }> }
  | { node: Extract<MwTreeNode, { kind: 'page' }> }
  | { node: Extract<MwTreeNode, { kind: 'group' }>; children: Extract<MwTreeNode, { kind: 'record' }>[] }

/**
 * One tree level as the sidebar draws it: a group without a `viewFilter` is followed by its
 * records (the server lists them after it), so they nest under it; a group with one opens a view.
 */
export function nestTree(nodes: MwTreeNode[]): TreeEntry[] {
  const out: TreeEntry[] = []
  let open: Extract<TreeEntry, { children: unknown[] }> | null = null
  for (const node of nodes) {
    if (node.kind === 'group') {
      const entry = { node, children: [] as Extract<MwTreeNode, { kind: 'record' }>[] }
      out.push(entry)
      open = node.viewFilter === undefined ? entry : null
      continue
    }
    if (node.kind === 'record' && open && node.entity === open.node.entity) {
      open.children.push(node)
      continue
    }
    open = null
    out.push({ node } as TreeEntry)
  }
  return out
}

/** A stable key for a tree node (sidebar ids and expansion state). */
export function treeNodeKey(node: MwTreeNode): string {
  switch (node.kind) {
    case 'record': return `r:${node.entity}:${node.id}`
    case 'group': return `g:${node.entity}:${node.parent ? `${node.parent.entity}:${node.parent.id}` : ''}`
    case 'page': return `p:${node.pageId}:${JSON.stringify(node.params)}`
  }
}

/** The entity's display name in a domain (its plural title when the domain lists it). */
export function entityTitle(entities: { key: string; title: string }[] | undefined, key: string): string {
  return entities?.find(e => e.key === key)?.title ?? humanize(key.split('.').pop() ?? key)
}

/** A lock-out until `retryAfter`, in words. */
export function lockedMessage(retryAfter: string | undefined, t: TFunction, locale?: string): string {
  if (!retryAfter) return t('memwise.sign.lockedNoTime')
  const at = Date.parse(retryAfter)
  const time = Number.isNaN(at) ? retryAfter : new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at)
  return t('memwise.sign.locked', { time })
}

/** Retention in words ("Kept 25 years"). */
export function retentionLabel(days: number | undefined, t: TFunction): string | undefined {
  if (!days) return undefined
  if (days % 365 === 0) return t('memwise.domains.keptYears', { count: days / 365 })
  return t('memwise.domains.keptDays', { count: days })
}
