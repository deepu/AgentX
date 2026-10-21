/**
 * The sidebar's Domains section (24 §14): each domain expands, like a Notion teamspace, into
 * Pages (its record tree, loaded a level at a time from memwise:records:tree, with groups such as
 * "Sites · 7" and free pages under their record), Playbooks, Entities and House rules. Regulated
 * domains carry a "Regulated" mark. Expansion is remembered per workspace (collapsed by default).
 *
 * A project with only the default domain shows no Domains section: its sidebar stays as it was.
 */

import * as React from 'react'
import type { TFunction } from 'i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { BookOpen, Boxes, Database, FileText, Folder, LayoutDashboard, PanelsTopLeft, Scale, ShieldCheck } from 'lucide-react'
import type { MwChange, MwDomain, MwTreeNode } from '@memwise/shared/protocol'
import type { SidebarItem } from '@/components/app-shell/LeftSidebar'
import { navigate, routes } from '@/lib/navigate'
import { memwiseDomainFilterAtom, memwiseDomainsAtom, memwiseLastChangeAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi } from '@/hooks/useMemwise'
import type { NavigationState } from '../../../../shared/types'
import { nestTree, treeNodeKey, type TreeEntry } from '../records/record-model'

/** The default domain's id (24 §2). */
export const DEFAULT_DOMAIN = 'domain'

/** Whether the sidebar shows a Domains section: more than the default domain alone. */
export function showDomainsSection(domains: MwDomain[] | null | undefined): boolean {
  if (!domains || domains.length === 0) return false
  return domains.length > 1 || domains[0]!.id !== DEFAULT_DOMAIN
}

/** Whether a list spanning these domains needs a domain filter. */
export function needsDomainFilter(domains: MwDomain[] | null | undefined, itemDomains: (string | undefined)[]): boolean {
  if (!showDomainsSection(domains)) return false
  return new Set(itemDomains.map(d => d ?? DEFAULT_DOMAIN)).size > 1
}

const STORAGE_PREFIX = 'memwise.sidebar.domains.'

function readExpanded(ws: string | null): Set<string> {
  if (!ws) return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + ws)
    const list = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeExpanded(ws: string | null, set: Set<string>) {
  if (!ws) return
  try { window.localStorage.setItem(STORAGE_PREFIX + ws, JSON.stringify([...set])) } catch { /* private mode: not remembered */ }
}

type TreeCache = Record<string, MwTreeNode[] | 'loading' | { error: string }>

const treeKey = (domain: string, parent?: { entity: string; id: string }) => `${domain}|${parent ? `${parent.entity}:${parent.id}` : ''}`

function isRefetching(c: MwChange): boolean {
  return c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status'
}

/** The Domains section's items, ready for the sidebar (a section heading, then one item per domain). */
export function useDomainSidebarItems(navState: NavigationState, t: TFunction): SidebarItem[] {
  const domains = useAtomValue(memwiseDomainsAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const lastChange = useAtomValue(memwiseLastChangeAtom)
  const setDomainFilter = useSetAtom(memwiseDomainFilterAtom)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => readExpanded(workspaceId))
  const [cache, setCache] = React.useState<TreeCache>({})
  const cacheRef = React.useRef(cache)
  cacheRef.current = cache

  React.useEffect(() => { setExpanded(readExpanded(workspaceId)); setCache({}) }, [workspaceId])

  const load = React.useCallback(async (domain: string, parent?: { entity: string; id: string }, force = false) => {
    const key = treeKey(domain, parent)
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseRecordTree !== 'function') return
    if (!force && cacheRef.current[key] !== undefined) return
    if (!force) setCache(c => ({ ...c, [key]: 'loading' }))
    try {
      const nodes = await api.memwiseRecordTree(workspaceId, { domain, ...(parent ? { parent } : {}) })
      setCache(c => ({ ...c, [key]: nodes }))
    } catch (err) {
      setCache(c => ({ ...c, [key]: { error: err instanceof Error ? err.message : String(err) } }))
    }
  }, [workspaceId])

  // Record writes can add or move records: reload the levels already open.
  const handled = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (!lastChange || handled.current === lastChange.seq) return
    handled.current = lastChange.seq
    if (!isRefetching(lastChange.change)) return
    for (const key of Object.keys(cacheRef.current)) {
      const [domain, parent] = key.split('|') as [string, string]
      const i = parent.indexOf(':')
      void load(domain, parent ? { entity: parent.slice(0, i), id: parent.slice(i + 1) } : undefined, true)
    }
  }, [lastChange, load])

  const isOpen = (id: string) => expanded.has(id)
  const toggle = React.useCallback((id: string, onOpen?: () => void) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else { next.add(id); onOpen?.() }
      writeExpanded(workspaceId, next)
      return next
    })
  }, [workspaceId])

  // Open levels load when shown (after a restart the remembered ones load again).
  React.useEffect(() => {
    if (!domains) return
    for (const id of expanded) {
      const m = /^nav:dom:([^:]+):pages$/.exec(id)
      if (m) void load(m[1]!)
      const r = /^nav:dom:([^:]+):r:([^:]+):(.+)$/.exec(id)
      if (r) void load(r[1]!, { entity: r[2]!, id: r[3]! })
    }
  }, [expanded, domains, load])

  if (!showDomainsSection(domains)) return []
  const details = navState.navigator === 'domains' ? navState.details : null
  const active = (match: boolean) => (match ? 'default' as const : 'ghost' as const)

  const loadingItem = (id: string): SidebarItem => ({ id: `${id}:loading`, title: t('memwise.domains.loading'), icon: Folder, variant: 'ghost', compact: true })

  const levelItems = (domain: MwDomain, parent?: { entity: string; id: string }): SidebarItem[] => {
    const level = cache[treeKey(domain.id, parent)]
    const base = `nav:dom:${domain.id}`
    if (level === undefined || level === 'loading') return [loadingItem(`${base}:${parent ? `${parent.entity}:${parent.id}` : 'top'}`)]
    if (!Array.isArray(level)) return [{ id: `${base}:error:${parent?.id ?? 'top'}`, title: t('memwise.domains.treeFailed'), icon: Folder, variant: 'ghost', compact: true }]
    if (level.length === 0) return [{ id: `${base}:empty:${parent?.id ?? 'top'}`, title: t('memwise.domains.treeEmpty'), icon: Folder, variant: 'ghost', compact: true }]
    return nestTree(level).map(entry => entryItem(domain, entry))
  }

  const recordItem = (domain: MwDomain, node: Extract<MwTreeNode, { kind: 'record' }>): SidebarItem => {
    const id = `nav:dom:${domain.id}:r:${node.entity}:${node.id}`
    return {
      id,
      title: node.title,
      icon: FileText,
      compact: true,
      variant: active(details?.type === 'record' && details.entity === node.entity && details.recordId === node.id),
      onClick: () => navigate(routes.view.record(node.entity, node.id)),
      ...(node.hasChildren ? {
        expandable: true,
        expanded: isOpen(id),
        onToggle: () => toggle(id, () => void load(domain.id, { entity: node.entity, id: node.id })),
        items: isOpen(id) ? levelItems(domain, { entity: node.entity, id: node.id }) : [],
      } : {}),
    }
  }

  const entryItem = (domain: MwDomain, entry: TreeEntry): SidebarItem => {
    const node = entry.node
    if (node.kind === 'record') return recordItem(domain, node)
    if (node.kind === 'page') {
      return {
        id: `nav:dom:${domain.id}:${treeNodeKey(node)}`,
        title: node.title,
        icon: LayoutDashboard,
        compact: true,
        variant: active(details?.type === 'dashboard' && details.domain === domain.id && details.pageId === node.pageId && JSON.stringify(details.params ?? {}) === JSON.stringify(node.params)),
        onClick: () => navigate(routes.view.domains({ type: 'dashboard', domain: domain.id, pageId: node.pageId, ...(Object.keys(node.params).length ? { params: node.params } : {}) })),
      }
    }
    const id = `nav:dom:${domain.id}:${treeNodeKey(node)}`
    const children = 'children' in entry ? entry.children : []
    const openEntities = () => navigate(routes.view.domains({ type: 'entities', domain: domain.id, entity: node.entity }))
    const more = node.count - children.length
    return {
      id,
      title: node.title,
      label: String(node.count),
      icon: Database,
      compact: true,
      variant: 'ghost',
      onClick: children.length ? () => toggle(id) : openEntities,
      ...(children.length ? {
        expandable: true,
        expanded: isOpen(id),
        onToggle: () => toggle(id),
        items: [
          ...children.map(c => recordItem(domain, c)),
          ...(more > 0 ? [{ id: `${id}:more`, title: t('memwise.domains.more', { count: more }), icon: Database, compact: true, variant: 'ghost' as const, onClick: openEntities }] : []),
        ],
      } : {}),
    }
  }

  const items: SidebarItem[] = [{ id: 'section:domains', type: 'section', title: t('memwise.nav.domains') }]
  for (const d of domains!) {
    const id = `nav:dom:${d.id}`
    const pagesId = `${id}:pages`
    const entitiesId = `${id}:entities`
    const total = d.entities.length
    items.push({
      id,
      title: d.name,
      icon: d.regulated ? ShieldCheck : Boxes,
      label: d.regulated ? t('memwise.domains.regulated') : undefined,
      variant: active(details?.type === 'domain' && details.domain === d.id && !details.tab),
      onClick: () => navigate(routes.view.domains({ type: 'domain', domain: d.id })),
      expandable: true,
      expanded: isOpen(id),
      onToggle: () => toggle(id),
      items: [
        {
          id: pagesId,
          title: t('memwise.domains.pages'),
          icon: PanelsTopLeft,
          compact: true,
          variant: 'ghost',
          onClick: () => toggle(pagesId, () => void load(d.id)),
          expandable: true,
          expanded: isOpen(pagesId),
          onToggle: () => toggle(pagesId, () => void load(d.id)),
          items: isOpen(pagesId) ? levelItems(d) : [],
        },
        {
          id: `${id}:playbooks`,
          title: t('memwise.nav.playbooks'),
          label: d.workflows.length ? String(d.workflows.length) : undefined,
          icon: BookOpen,
          compact: true,
          variant: 'ghost',
          onClick: () => { setDomainFilter(d.id); navigate(routes.view.playbooks()) },
        },
        {
          id: entitiesId,
          title: t('memwise.entities.title'),
          label: total ? String(total) : undefined,
          icon: Database,
          compact: true,
          variant: active(details?.type === 'entities' && details.domain === d.id && !details.entity),
          onClick: () => navigate(routes.view.domains({ type: 'entities', domain: d.id })),
          expandable: total > 0,
          expanded: isOpen(entitiesId),
          onToggle: () => toggle(entitiesId),
          items: d.entities.map(e => ({
            id: `${entitiesId}:${e.key}`,
            title: e.title,
            icon: Database,
            compact: true,
            variant: active(details?.type === 'entities' && details.domain === d.id && details.entity === e.key),
            onClick: () => navigate(routes.view.domains({ type: 'entities', domain: d.id, entity: e.key })),
          })),
        },
        {
          id: `${id}:rules`,
          title: t('memwise.domains.houseRules'),
          icon: Scale,
          compact: true,
          variant: active(details?.type === 'domain' && details.domain === d.id && details.tab === 'rules'),
          onClick: () => navigate(routes.view.domains({ type: 'domain', domain: d.id, tab: 'rules' })),
        },
      ],
    })
  }
  return items
}
