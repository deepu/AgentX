/**
 * Plugins in words, for the list, the plugin page and the Install dialog. Pure.
 */

import type { TFunction } from 'i18next'
import type {
  MwBindingState, MwClassSource, MwEntityLinkBadge, MwInboxItem, MwMappedRecord, MwPluginSummary, MwPluginTrust, MwPluginTool,
  MwWorkflowOrigin,
} from '@memwise/shared/protocol'

export type BadgeTone = 'success' | 'warning' | 'destructive' | 'default' | 'muted'

export interface BindingBadge { label: string; tone: BadgeTone }

/** "Not bound", "Being bound", "Bound v2", "Newer version available". */
export function bindingBadge(p: Pick<MwPluginSummary, 'binding' | 'upgradeAvailable'>, t: TFunction): BindingBadge {
  const b = p.binding
  if (b.status === 'binding') return { label: t('memwise.plugins.state.binding'), tone: 'warning' }
  if (b.status === 'bound') {
    if (p.upgradeAvailable) return { label: t('memwise.plugins.state.upgrade'), tone: 'warning' }
    return { label: t('memwise.plugins.state.bound', { version: b.version }), tone: 'success' }
  }
  return { label: t('memwise.plugins.state.unbound'), tone: 'default' }
}

export function trustLabel(trust: MwPluginTrust, t: TFunction): string {
  switch (trust) {
    case 'first-party': return t('memwise.plugins.trust.firstParty')
    case 'verified': return t('memwise.plugins.trust.verified')
    case 'community': return t('memwise.plugins.trust.community')
    case 'local': return t('memwise.plugins.trust.local')
  }
}

/** Where a tool's class came from, in words: declared, MCP hints, the binding (agent or person), nowhere. */
export function classSourceLabel(from: MwClassSource, t: TFunction, tool?: Pick<MwPluginTool, 'reason'>): string {
  switch (from) {
    case 'declared': return t('memwise.plugins.classFrom.declared')
    case 'annotations': return t('memwise.plugins.classFrom.annotations')
    case 'binding': return tool?.reason ? t('memwise.plugins.classFrom.agent') : t('memwise.plugins.classFrom.binding')
    case 'none': return t('memwise.plugins.classFrom.none')
  }
}

/** "from Client intake 1.0.0" (a fork: "forked from …"). */
export function originLabel(o: MwWorkflowOrigin, t: TFunction): string {
  return t(o.kind === 'fork' ? 'memwise.plugins.forkedFrom' : 'memwise.plugins.from', { title: o.pluginTitle, version: o.pluginVersion })
}

/** Plugins waiting on something first (being bound, an upgrade), then by title. */
export function sortPlugins<T extends Pick<MwPluginSummary, 'title' | 'binding' | 'upgradeAvailable'>>(plugins: T[]): T[] {
  const rank = (p: T) => (p.binding.status === 'binding' ? 0 : p.upgradeAvailable ? 1 : p.binding.status === 'unbound' ? 2 : 3)
  return [...plugins].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
}

/** The bind-plugin case of a plugin being bound, if any. */
export function bindingCase(state: MwBindingState): string | undefined {
  return state.status === 'binding' ? state.caseId : undefined
}

/** A source badge's text: "Sample CRM · contact". */
export function linkBadgeLabel(l: Pick<MwEntityLinkBadge, 'pluginTitle' | 'source'>): string {
  return `${l.pluginTitle} · ${l.source}`
}

export function matchMethodLabel(method: MwEntityLinkBadge['method'], t: TFunction): string {
  switch (method) {
    case 'key': return t('memwise.records.method.key')
    case 'fuzzy': return t('memwise.records.method.fuzzy')
    case 'person': return t('memwise.records.method.person')
    case 'created': return t('memwise.records.method.created')
  }
}

/** A 0..1 score as a whole percentage. */
export function scorePercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

/** One row of an identity card: the field, the domain's value, the outside value, and whether they agree. */
export interface IdentityRow { field: string; ours: unknown; theirs: unknown; same: boolean | null }

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, '') : JSON.stringify(v ?? null))

export function identityRows(item: Pick<Extract<MwInboxItem, { kind: 'identity' }>, 'fields' | 'record' | 'external'>): IdentityRow[] {
  return item.fields.map(field => {
    const ours = item.record[field]
    const theirs = item.external[field]
    const both = ours !== undefined && ours !== null && ours !== '' && theirs !== undefined && theirs !== null && theirs !== ''
    return { field, ours, theirs, same: both ? norm(ours) === norm(theirs) : null }
  })
}

/** Sample records of one source, for the mapping table. */
export function samplesOf(records: MwMappedRecord[] | undefined, source: string, max = 3): MwMappedRecord[] {
  return (records ?? []).filter(r => r.source === source).slice(0, max)
}

/** The value a mapping read from a sample record ("before"), when the dry run kept the record. */
export function beforeValue(record: MwMappedRecord, from: string | undefined): unknown {
  if (!from || !record.raw) return undefined
  let cur: unknown = record.raw
  for (const part of from.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
