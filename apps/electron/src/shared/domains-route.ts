/**
 * The `domains` navigator (Phase 6, docs/memwise/24-phase-6-interfaces.md §14): record pages,
 * a domain's entities, dashboards (free pages), automations and the domain page. Like `pages`,
 * it has no middle list: the sidebar's Domains section is its navigator.
 *
 * Routes are `domains` (the cross-domain Pages overview) or `domains/{type}/{id}`, where `id`
 * is one URI-encoded segment that packs the detail's parts:
 *   record      `{entity}:{recordId}`                 (entity keys never hold a colon)
 *   entities    `{domain}` or `{domain}:{entity}`
 *   dashboard   `{domain}:{pageId}` plus `?{params}`  (the params a tree page node carries)
 *   automations `*` or `{domain}`
 *   domain      `{domain}` or `{domain}:rules`
 *   regulated   `{domain}:{screen}` or `{domain}:{screen}:{id}` (Stage 5: a change request, the audit
 *               trail (id `{entity}:{recordId}` for one record's), inspector access, the TMF index
 *               (id: a zone)). Interim: the shell mounts these under `mw/{projectId}/…` later.
 */

export type DomainsDetails =
  | { type: 'record'; entity: string; recordId: string }
  | { type: 'entities'; domain: string; entity?: string }
  | { type: 'dashboard'; domain: string; pageId: string; params?: Record<string, string> }
  | { type: 'automations'; domain?: string }
  | { type: 'domain'; domain: string; tab?: 'rules' }
  | { type: 'regulated'; domain: string; screen: RegulatedScreen; id?: string }

export type RegulatedScreen = 'change' | 'audit' | 'inspectors' | 'tmf'
const REGULATED_SCREENS: readonly string[] = ['change', 'audit', 'inspectors', 'tmf']

export const DOMAINS_DETAIL_TYPES = ['record', 'entities', 'dashboard', 'automations', 'domain', 'regulated'] as const

function splitFirst(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep)
  return i < 0 ? [value, undefined] : [value.slice(0, i), value.slice(i + sep.length)]
}

/** The packed id of a detail (not yet URI-encoded). */
export function packDomainsDetail(d: DomainsDetails): { type: DomainsDetails['type']; id: string } {
  switch (d.type) {
    case 'record': return { type: 'record', id: `${d.entity}:${d.recordId}` }
    case 'entities': return { type: 'entities', id: d.entity ? `${d.domain}:${d.entity}` : d.domain }
    case 'dashboard': {
      const params = d.params && Object.keys(d.params).length
        ? `?${new URLSearchParams(Object.entries(d.params).sort(([a], [b]) => a.localeCompare(b))).toString()}`
        : ''
      return { type: 'dashboard', id: `${d.domain}:${d.pageId}${params}` }
    }
    case 'automations': return { type: 'automations', id: d.domain ?? '*' }
    case 'domain': return { type: 'domain', id: d.tab ? `${d.domain}:${d.tab}` : d.domain }
    case 'regulated': return { type: 'regulated', id: `${d.domain}:${d.screen}${d.id ? `:${d.id}` : ''}` }
  }
}

/** The detail a packed id names, or null when it is malformed. */
export function unpackDomainsDetail(type: string, id: string): DomainsDetails | null {
  if (!id) return null
  switch (type) {
    case 'record': {
      const [entity, recordId] = splitFirst(id, ':')
      return entity && recordId ? { type: 'record', entity, recordId } : null
    }
    case 'entities': {
      const [domain, entity] = splitFirst(id, ':')
      return domain ? { type: 'entities', domain, ...(entity ? { entity } : {}) } : null
    }
    case 'dashboard': {
      const [head, query] = splitFirst(id, '?')
      const [domain, pageId] = splitFirst(head, ':')
      if (!domain || !pageId) return null
      const params = query ? Object.fromEntries(new URLSearchParams(query)) : undefined
      return { type: 'dashboard', domain, pageId, ...(params && Object.keys(params).length ? { params } : {}) }
    }
    case 'automations':
      return id === '*' ? { type: 'automations' } : { type: 'automations', domain: id }
    case 'domain': {
      const [domain, tab] = splitFirst(id, ':')
      if (!domain) return null
      return tab === 'rules' ? { type: 'domain', domain, tab: 'rules' } : { type: 'domain', domain }
    }
    case 'regulated': {
      const [domain, rest] = splitFirst(id, ':')
      if (!domain || !rest) return null
      const [screen, sub] = splitFirst(rest, ':')
      if (!REGULATED_SCREENS.includes(screen)) return null
      // A change request's screen needs its id.
      if (screen === 'change' && !sub) return null
      return { type: 'regulated', domain, screen: screen as RegulatedScreen, ...(sub ? { id: sub } : {}) }
    }
    default:
      return null
  }
}

/** The route of a detail (or of the Pages overview). */
export function domainsRoute(d?: DomainsDetails | null): string {
  if (!d) return 'domains'
  const { type, id } = packDomainsDetail(d)
  return `domains/${type}/${encodeURIComponent(id)}`
}
