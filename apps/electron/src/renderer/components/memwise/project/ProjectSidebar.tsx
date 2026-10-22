/**
 * The project sidebar (doc 26 §2, mocks `Main`, `Sidebar`): the project switcher on top, then
 * Home, Waiting for you, PAGES (a tree), PLAYBOOKS (with how each starts), RECORDS (with counts),
 * and Project settings with the person at the bottom. It replaces the Craft-era sidebar and the
 * middle list: there is no chat list here.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { BookOpen, ChevronDown, ChevronRight, Database, FileText, FolderTree, LayoutDashboard, MessageCircle, Plus, RefreshCw, Settings, SquareCheckBig } from 'lucide-react'
import type { MwDomain, MwPageSummary, MwTreeNode } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { changesSince, memwiseInstallPluginDialogAtom, memwiseLastChangeAtom, memwiseNewPlaybookDialogAtom, memwisePeopleOnlyAtom, memwisePlaybooksAtom, memwiseStatusAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi } from '@/hooks/useMemwise'
import { useMemwiseTriggers } from '@/hooks/useMemwiseRecords'
import { useMemwisePages } from '@/hooks/useMemwisePages'
import { ALL_PROJECTS, type ProjectDetails } from '../../../../shared/project-route'
import { InstallPluginDialog } from '../plugins/PluginsList'
import { nestTree, treeNodeKey } from '../records/record-model'
import { useProjectRecordCounts } from '@/hooks/useMemwiseProjects'
import { ProjectSwitcher } from './ProjectSwitcher'
import { initials, playbookStartTag, projectPlaybooks, projectRecordTypes, writtenPagePlace, type ShellApp, type ShellProject } from './project-model'
import { useMemwiseChangeRequest } from '@/hooks/useMemwiseRegulated'
import { keepsTmf } from '../regulated/RegulatedDomainLinks'
import { TMF_ZONES, zoneName } from '../regulated/regulated-model'

/** How many playbooks show before "N more". */
const PLAYBOOKS_SHOWN = 4

export interface ProjectSidebarProps {
  apps: ShellApp[]
  project: ShellProject
  domain: MwDomain | null
  details: ProjectDetails
  totalWaiting: number
  /** Hooks for the sections Stage 2 fills (written pages); dashboards and record pages show until then. */
  extraPages?: React.ReactNode
}

export function ProjectSidebar({ apps, project, domain, details, totalWaiting, extraPages }: ProjectSidebarProps) {
  const { t } = useTranslation()
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const { data: triggers } = useMemwiseTriggers()
  const status = useAtomValue(memwiseStatusAtom)
  const [showAllPlaybooks, setShowAllPlaybooks] = React.useState(false)
  // A new playbook is built by chat, so not from a person's own sign-in.
  const openNewPlaybook = useSetAtom(memwiseNewPlaybookDialogAtom)
  const peopleOnly = useAtomValue(memwisePeopleOnlyAtom)
  const go = (d?: ProjectDetails) => navigate(routes.view.project(project.id, d))

  const ownPlaybooks = projectPlaybooks(project, playbooks)
  const shownPlaybooks = showAllPlaybooks ? ownPlaybooks : ownPlaybooks.slice(0, PLAYBOOKS_SHOWN)
  const typeCounts = projectRecordTypes(domain)
  // Stage 3: a study's own counts, not every study's.
  const { data: own } = useProjectRecordCounts(project, typeCounts.map(r => r.key))
  const records = own ? typeCounts.map(r => ({ ...r, count: own[r.key] ?? 0 })) : typeCounts
  // Written pages list above as pages (26 §4); one written under a record stays in the record tree.
  const pageList = useMemwisePages(project.id).data
  const written = React.useMemo(() => new Map((pageList ?? []).map(p => [p.id, p])), [pageList])
  const me = status?.me
  // Stage 3: "+ New project" makes one in this project's app, else in the first app that allows it;
  // "+ Add an app" installs a plugin (doc 26 §2: Plugins go to "+ Add an app").
  const newProjectApp = apps.find(a => a.id === project.appId && a.canCreate) ?? apps.find(a => a.canCreate)
  const openAddApp = useSetAtom(memwiseInstallPluginDialogAtom)
  const canAddApp = !peopleOnly && typeof getMemwiseApi()?.memwiseListInstallChoices === 'function'
  // Stage 5: a change request is under its playbook; the TMF index is a live page with a sub-page per zone.
  const { data: openChange } = useMemwiseChangeRequest(details.type === 'cr' ? project.id : null, details.type === 'cr' ? details.crId : null)
  const [tmfOpen, setTmfOpen] = React.useState(details.type === 'tmf' && !!details.zone)
  const tmf = !!domain && keepsTmf(domain)

  return (
    <div className="flex h-full flex-col select-none font-sans" data-testid="project-sidebar">
      <div className="px-2 pt-1.5 pb-2 shrink-0">
        <ProjectSwitcher
          apps={apps}
          current={project}
          totalWaiting={totalWaiting}
          {...(newProjectApp ? { onNewProject: () => navigate(routes.view.project(ALL_PROJECTS, { type: 'new', appId: newProjectApp.id })) } : {})}
          {...(canAddApp ? { onAddApp: () => openAddApp(true) } : {})}
        />
        {canAddApp && <InstallPluginDialog />}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-4 scrollbar-hide mask-fade-bottom">
        <Row icon={MessageCircle} label={t('memwise.shell.home')} active={details.type === 'home'} onClick={() => go()} />
        <Row
          icon={SquareCheckBig}
          label={t('memwise.shell.waiting')}
          active={details.type === 'waiting'}
          badge={project.waiting > 0 ? project.waiting : undefined}
          onClick={() => go({ type: 'waiting' })}
        />

        <Section title={t('memwise.shell.pages')} />
        {extraPages}
        {tmf && (
          <>
            <Row
              icon={FolderTree}
              label={t('memwise.regulated.tmf.title')}
              refresh
              inTree
              caret={tmfOpen ? 'open' : 'closed'}
              onCaret={() => setTmfOpen(o => !o)}
              active={details.type === 'tmf' && !details.zone}
              onClick={() => go({ type: 'tmf' })}
            />
            {tmfOpen && TMF_ZONES.map(z => (
              <Row
                key={z.id}
                icon={FileText}
                label={`${z.number} · ${zoneName(z, t)}`}
                depth={1}
                inTree
                active={details.type === 'tmf' && details.zone === z.id}
                onClick={() => go({ type: 'tmf', zone: z.id })}
              />
            ))}
          </>
        )}
        <WrittenPages projectId={project.id} details={details} />
        {domain && <PageTree domain={domain} projectId={project.id} {...(project.stored ? { scope: project.id } : {})} details={details} written={written} />}

        {ownPlaybooks.length > 0 && <Section title={t('memwise.shell.playbooks')} {...(peopleOnly ? {} : { onAdd: () => openNewPlaybook(true) })} addLabel={t('memwise.shell.newPlaybook')} />}
        {shownPlaybooks.map(p => (
          <Row
            key={p.id}
            icon={BookOpen}
            label={p.title}
            tag={playbookStartTag(p.id, triggers)}
            active={(details.type === 'playbook' && details.workflowId === p.id) || (details.type === 'cr' && openChange?.workflowId === p.id)}
            onClick={() => go({ type: 'playbook', workflowId: p.id })}
          />
        ))}
        {ownPlaybooks.length > PLAYBOOKS_SHOWN && !showAllPlaybooks && (
          <Row icon={BookOpen} label={t('memwise.shell.morePlaybooks', { count: ownPlaybooks.length - PLAYBOOKS_SHOWN })} muted onClick={() => setShowAllPlaybooks(true)} />
        )}

        {records.length > 0 && <Section title={t('memwise.shell.records')} />}
        {records.map(r => (
          <Row
            key={r.key}
            icon={Database}
            label={r.title}
            tag={r.count.toLocaleString()}
            active={(details.type === 'records' && details.entity === r.key) || (details.type === 'record' && details.entity === r.key)}
            onClick={() => go({ type: 'records', entity: r.key })}
          />
        ))}
      </div>
      <div className="shrink-0 border-t border-foreground/5 mx-2 pt-2 pb-2">
        <button
          type="button"
          onClick={() => go({ type: 'settings' })}
          className={cn('flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-fill-hover', (details.type === 'settings' || details.type === 'audit') && 'bg-fill-selected')}
        >
          <Settings className="mt-0.5 size-4 shrink-0 text-secondary" />
          <span className="min-w-0">
            <span className="block text-label text-foreground">{t('memwise.shell.projectSettings')}</span>
            <span className="block truncate text-label-sm text-tertiary">{t('memwise.shell.projectSettingsHint')}</span>
          </span>
        </button>
        {me && (
          <div className="mt-1 flex items-center gap-2.5 px-2 py-1.5" data-testid="shell-person">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-caption font-semibold text-secondary">{initials(me.name)}</span>
            <span className="truncate text-label text-foreground">{me.name}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, onAdd, addLabel }: { title: string; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2">
      <span className="text-label-sm font-medium uppercase tracking-wide text-tertiary">{title}</span>
      {onAdd && (
        <button type="button" aria-label={addLabel} title={addLabel} onClick={onAdd} className="rounded-sm p-0.5 text-tertiary hover:bg-fill-hover hover:text-foreground">
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function Row({ icon: Icon, label, active, badge, tag, refresh, draft, depth = 0, caret, muted, inTree, onClick, onCaret }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  badge?: number
  tag?: string
  refresh?: boolean
  draft?: boolean
  depth?: number
  caret?: 'open' | 'closed'
  muted?: boolean
  /** A row of the pages tree: leaves a gutter for the carets. */
  inTree?: boolean
  onClick: () => void
  onCaret?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={cn(
        'group relative flex h-row-sidebar w-full cursor-default items-center gap-2.5 rounded-sm pr-2 text-label transition-[background-color] duration-micro hover:bg-fill-hover',
        active ? 'bg-fill-selected text-foreground' : muted ? 'text-secondary' : 'text-foreground',
      )}
      style={{ paddingLeft: 8 + depth * 16 + (inTree ? 6 : 0) }}
      data-active={active || undefined}
    >
      {caret && (
        <button
          type="button"
          aria-label={caret === 'open' ? t('memwise.shell.collapse') : t('memwise.shell.expand')}
          onClick={e => { e.stopPropagation(); onCaret?.() }}
          className="absolute flex size-3.5 items-center justify-center text-tertiary hover:text-foreground"
          style={{ left: depth * 16 }}
        >
          {caret === 'open' ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
      )}
      <Icon className="size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {draft && <span className="rounded-sm bg-foreground/5 px-1.5 text-label-sm text-secondary">{t('memwise.shell.draft')}</span>}
      {refresh && <RefreshCw className="size-3.5 shrink-0 text-accent" aria-label={t('memwise.shell.keptUpToDate')} />}
      {tag && <span className="shrink-0 text-label-sm text-tertiary tabular-nums">{tag}</span>}
      {badge !== undefined && (
        <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-caption font-semibold text-white tabular-nums">{badge}</span>
      )}
    </div>
  )
}

export { Row as ProjectSidebarRow }

// ---------------------------------------------------------------- written pages

/**
 * The project's written pages (26 §4; mock `LHome`): kept pages and drafts, sub-pages under their
 * parent. A kept page that refreshes shows the refresh mark; a draft says so. A parent opens when
 * the page open is under it, and the first one with sub-pages starts open.
 */
function WrittenPages({ projectId, details }: { projectId: string; details: ProjectDetails }) {
  // A page written under a record (`under`) shows in the record tree, under that record.
  const all = useMemwisePages(projectId).data
  const pages = React.useMemo(() => (all ?? []).filter(p => writtenPagePlace(p) === 'top'), [all])
  const activeId = details.type === 'page' ? details.pageId : undefined
  const byParent = React.useMemo(() => {
    const m = new Map<string, MwPageSummary[]>()
    const ids = new Set(pages.map(p => p.id))
    for (const p of pages) {
      const k = p.parent && ids.has(p.parent) ? p.parent : ''
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return m
  }, [pages])
  const ancestors = React.useMemo(() => {
    const out = new Set<string>()
    const parentOf = new Map(pages.map(p => [p.id, p.parent]))
    let cur = activeId ? parentOf.get(activeId) : undefined
    while (cur && !out.has(cur)) { out.add(cur); cur = parentOf.get(cur) }
    return out
  }, [pages, activeId])
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({})
  const firstParent = (byParent.get('') ?? []).find(p => byParent.has(p.id))?.id
  const isOpen = (id: string) => toggled[id] ?? (ancestors.has(id) || id === firstParent)
  const go = (pageId: string) => navigate(routes.view.project(projectId, { type: 'page', pageId }))

  const render = (list: MwPageSummary[], depth: number): React.ReactNode => list.map(p => {
    const kids = byParent.get(p.id)
    const open = !!kids && isOpen(p.id)
    return (
      <React.Fragment key={p.id}>
        <Row
          icon={FileText}
          label={p.title}
          depth={depth}
          inTree
          draft={p.status === 'draft'}
          refresh={p.status === 'kept' && !!p.refresh && !p.refreshEnded}
          caret={kids ? (open ? 'open' : 'closed') : undefined}
          onCaret={() => setToggled(t => ({ ...t, [p.id]: !open }))}
          active={activeId === p.id}
          onClick={() => go(p.id)}
        />
        {open && kids && render(kids, depth + 1)}
      </React.Fragment>
    )
  })
  return <div data-testid="shell-written-pages">{render(byParent.get('') ?? [], 0)}</div>
}

// ---------------------------------------------------------------- pages tree

type TreeCache = Record<string, MwTreeNode[] | 'loading'>

/**
 * PAGES after the written pages (Stage 2): the project's dashboards, then its record tree
 * (records that have pages of their own, a level at a time, from memwise:records:tree).
 */
function PageTree({ domain, projectId, scope, details, written }: { domain: MwDomain; projectId: string; scope?: string; details: ProjectDetails; written: Map<string, MwPageSummary> }) {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const lastChange = useAtomValue(memwiseLastChangeAtom)
  const [cache, setCache] = React.useState<TreeCache>({})
  const [open, setOpen] = React.useState<Set<string>>(new Set())
  const cacheRef = React.useRef(cache)
  cacheRef.current = cache

  const load = React.useCallback(async (parent?: { entity: string; id: string }, force = false) => {
    const key = parent ? `${parent.entity}:${parent.id}` : ''
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseRecordTree !== 'function') return
    if (!force && cacheRef.current[key] !== undefined) return
    if (!force) setCache(c => ({ ...c, [key]: 'loading' }))
    try {
      // A project's own records (Stage 3): EDC's Study MW-301 lists MW-301's sites, not MW-207's.
      const nodes = await api.memwiseRecordTree(workspaceId, { domain: domain.id, ...(parent ? { parent } : {}), ...(scope ? { project: scope } : {}) })
      setCache(c => ({ ...c, [key]: nodes }))
    } catch {
      setCache(c => ({ ...c, [key]: [] }))
    }
  }, [workspaceId, domain.id, scope])

  React.useEffect(() => { cacheRef.current = {}; setCache({}); setOpen(new Set()) }, [domain.id, projectId])
  React.useEffect(() => { void load() }, [load])
  const seen = React.useRef<number | null>(null)
  React.useEffect(() => {
    const changes = changesSince(lastChange, seen.current)
    if (!changes.length) return
    seen.current = lastChange!.seq
    if (!changes.some(c => c.kind === 'records' || c.kind === 'definitions')) return
    for (const key of Object.keys(cacheRef.current)) {
      if (!key) { void load(undefined, true); continue }
      const i = key.indexOf(':')
      void load({ entity: key.slice(0, i), id: key.slice(i + 1) }, true)
    }
  }, [lastChange, load])

  const toggle = (key: string, parent: { entity: string; id: string }) => {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else { next.add(key); void load(parent) }
      return next
    })
  }

  const go = (d: ProjectDetails) => navigate(routes.view.project(projectId, d))
  const roots = cache[''] === 'loading' ? [] : cache[''] ?? []

  const renderRecord = (n: Extract<MwTreeNode, { kind: 'record' }>, depth: number): React.ReactNode => {
    const key = `${n.entity}:${n.id}`
    const isOpen = open.has(key)
    const children = cache[key]
    return (
      <React.Fragment key={`rec:${key}`}>
        <Row
          icon={FileText}
          label={n.title}
          depth={depth}
          inTree
          caret={n.hasChildren ? (isOpen ? 'open' : 'closed') : undefined}
          onCaret={() => toggle(key, { entity: n.entity, id: n.id })}
          active={details.type === 'record' && details.entity === n.entity && details.recordId === n.id}
          onClick={() => go({ type: 'record', entity: n.entity, recordId: n.id })}
        />
        {isOpen && Array.isArray(children) && renderNodes(children, depth + 1)}
      </React.Fragment>
    )
  }

  // A group the server lists its records after ("Studies") nests nothing: its records show at
  // its level. A group with a view ("Sites · 12") opens the record type's list.
  const renderNodes = (nodes: MwTreeNode[], depth: number): React.ReactNode => nestTree(nodes).map(e => {
    const n = e.node
    if (n.kind === 'page') {
      const w = written.get(n.pageId)
      if (w && writtenPagePlace(w) === 'top') return null
      if (w) {
        return (
          <Row
            key={`written:${n.pageId}`}
            icon={FileText}
            label={w.title}
            depth={depth}
            inTree
            draft={w.status === 'draft'}
            refresh={w.status === 'kept' && !!w.refresh && !w.refreshEnded}
            active={details.type === 'page' && details.pageId === n.pageId}
            onClick={() => go({ type: 'page', pageId: n.pageId })}
          />
        )
      }
      return (
        <Row
          key={`page:${n.pageId}:${JSON.stringify(n.params)}`}
          icon={LayoutDashboard}
          label={n.title}
          depth={depth}
          inTree
          active={details.type === 'dashboard' && details.pageId === n.pageId && details.domain === domain.id}
          onClick={() => go({ type: 'dashboard', domain: domain.id, pageId: n.pageId, ...(n.params && Object.keys(n.params).length ? { params: n.params } : {}) })}
        />
      )
    }
    if (n.kind === 'group') {
      if ('children' in e && n.viewFilter === undefined) return <React.Fragment key={treeNodeKey(n)}>{e.children.map(c => renderRecord(c, depth))}</React.Fragment>
      return (
        <Row
          key={treeNodeKey(n)}
          icon={Database}
          label={n.title}
          tag={String(n.count)}
          depth={depth}
          inTree
          onClick={() => go({ type: 'records', entity: n.entity })}
        />
      )
    }
    return renderRecord(n, depth)
  })

  return <>{renderNodes(roots, 0)}</>
}
