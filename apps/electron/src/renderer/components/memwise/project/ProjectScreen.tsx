/**
 * One screen of the project shell (doc 26 §2): two cards, the chat about what's open on the left
 * (about 488px, at least 400) and the page on the right. Every MemWise route in the shell lands
 * here; the page column reuses the existing pages (an inbox item, a playbook, a run, a record,
 * a dashboard, a record type's list, a written page and its answer changes), and the chat column
 * is `AnchoredChat`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { memwiseCasesAtom, memwiseDomainsAtom, memwiseInboxAtom, memwisePlaybooksAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, waitForSession } from '@/hooks/useMemwise'
import { useMemwiseRecordPage } from '@/hooks/useMemwiseRecords'
import { useMemwiseChangeRequest } from '@/hooks/useMemwiseRegulated'
import { useMemwisePage, useMemwisePageChange } from '@/hooks/useMemwisePages'
import type { MwInboxItem } from '@memwise/shared/protocol'
import { ALL_PROJECTS, projectRoute, type ProjectView } from '../../../../shared/project-route'
import { DashboardPage } from '../domains/DomainsPages'
import { PageChangeScreen, PageScreen } from '../pages'
import { PlaybookShellPage } from './pages/PlaybookShellPage'
import { RecordShellPage, WaitingItemShellPage } from './pages/RecordShellPage'
import { RecordsShellPage } from './pages/RecordsShellPage'
import { RunShellPage } from './pages/RunShellPage'
import { inboxItemStepTitle } from '../format'
import { AnchoredChat } from './AnchoredChat'
import { HomeChatColumn, HomePinnedPage } from './ProjectHome'
import { ProjectSettingsPage } from './ProjectSettingsPage'
import { ProjectShellContext } from './shell-context'
import { chatAnchorFor, pickProject, pluralTitle, type ShellProject } from './project-model'
import { readLastProject, useProjectShellEnabled, useShellProjects, writeLastProject } from './useProjectShell'
import { WaitingPage } from './WaitingPage'
import { AppHomeScreen, NewProjectScreen, TemplateUpdateScreen, WaitingAllScreen } from '../projects/ProjectScreens'
import { MwProjectsNavProvider, type MwProjectsNav } from '../projects/nav'
import { AuditTrailScreen, ChangeRequestScreen, TmfIndexScreen, type RegulatedNavigation } from '../regulated'
import { zoneName } from '../regulated/regulated-model'
import { useProjectShell } from './shell-context'
import { PANEL_GAP, RADIUS_INNER } from '../../app-shell/panel-constants'

export const CHAT_COLUMN_WIDTH = 488
export const CHAT_COLUMN_MIN = 400

export function ProjectScreen({ view }: { view: ProjectView | null }) {
  const { t } = useTranslation()
  const store = useStore()
  const parent = useAppShellContext()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const domains = useAtomValue(memwiseDomainsAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const cases = useAtomValue(memwiseCasesAtom)
  const enabled = useProjectShellEnabled()
  const { projects, apps, stored } = useShellProjects(parent.workspaces.find(w => w.id === parent.activeWorkspaceId)?.name)
  const all = view?.projectId === ALL_PROJECTS
  const project = pickProject(projects, all ? null : view?.projectId, readLastProject(workspaceId))
  const details = view?.details ?? { type: 'home' as const }
  const domain = domains?.find(d => d.id === project?.domain) ?? null
  const routeKey = project ? projectRoute(all ? ALL_PROJECTS : project.id, details) : ''

  React.useEffect(() => { if (project && !all) writeLastProject(workspaceId, project.id) }, [workspaceId, project, all])
  // A record's chat is titled with the record (its page loads the same data).
  const recordPage = useMemwiseRecordPage(details.type === 'record' ? details.entity : null, details.type === 'record' ? details.recordId : null)
  const recordTitle = recordPage.data?.title
  // A change request's chat is titled with its label (the route may name it by id).
  const { data: openCr } = useMemwiseChangeRequest(details.type === 'cr' && project ? project.id : null, details.type === 'cr' ? details.crId : null)
  // A written page's chat is titled with the page; an answer change's with its page too.
  const writtenPage = useMemwisePage(details.type === 'page' ? details.pageId : null)
  const openChange = useMemwisePageChange(details.type === 'change' ? details.changeId : null)

  // A chat a page opened (a step's chat), shown until the person opens another page.
  const [pinned, setPinned] = React.useState<{ route: string; sessionId: string } | null>(null)
  const shellValue = React.useMemo(() => ({
    projectId: project?.id ?? '',
    ...(project?.name ? { projectName: project.name } : {}),
    showChat: (sessionId: string) => setPinned({ route: routeKey, sessionId }),
  }), [project?.id, project?.name, routeKey])
  const pinnedChat = pinned?.route === routeKey ? pinned.sessionId : null

  // Where the Stage 3 screens go: inside the shell, and a chat into the chat column.
  const known = React.useCallback((id: string | undefined) => !!id && projects.some(p => p.id === id), [projects])
  const nav = React.useMemo<Partial<MwProjectsNav>>(() => ({
    openProject: id => navigate(routes.view.project(id)),
    openAppHome: appId => navigate(routes.view.project(ALL_PROJECTS, { type: 'app', appId })),
    openItem: item => navigate(routes.view.project(known(item.project) ? item.project! : all || !project ? ALL_PROJECTS : project.id, { type: 'waiting', itemId: item.id })),
    openTemplateUpdate: (projectId, itemId) => navigate(routes.view.project(projectId, { type: 'update', itemId })),
    openSettings: projectId => navigate(routes.view.project(projectId, { type: 'settings' })),
    openChat: sessionId => shellValue.showChat(sessionId),
  }), [known, all, project, shellValue])

  // Pages inside the shell have no close button and no back arrow: the sidebar is the way around.
  const context = React.useMemo(() => ({ ...parent, rightSidebarButton: undefined, leadingAction: undefined, isFocusedPanel: true }), [parent])

  if (!project) {
    // While MemWise starts there is nothing to say yet.
    return <div className="flex h-full items-center justify-center text-label text-tertiary">{enabled ? t('memwise.shell.noProjects') : ''}</div>
  }

  const item = details.type === 'waiting' && details.itemId ? inbox?.find(i => i.id === details.itemId) ?? null : null
  const entityType = details.type === 'record' ? domain?.entities.find(e => e.key === details.entity) : undefined
  const reviewing = item ? pageChangeOf(item) : undefined
  // Stage 3: an app's home and New project talk about the app (its own project, id = app id).
  const appAnchor = details.type === 'app' || details.type === 'new' ? details.appId : null
  const anchor = appAnchor ? { kind: 'project' as const, id: appAnchor } : all ? { kind: 'waiting' as const, id: ALL_PROJECTS } : chatAnchorFor(project.id, details, item, openChange.data?.pageId, project.stored ? project.id : undefined)
  const appOf = (id: string) => apps.find(a => a.id === id)

  // "Describe it in chat" from the chat column of New project: the app's create-project chat opens here.
  const describe = async (request: string) => {
    if (details.type !== 'new') return
    const api = getMemwiseApi()
    if (!workspaceId || !api || typeof api.memwiseDescribeProject !== 'function') { toast.error(t('memwise.notAvailable')); return }
    try {
      const r = await api.memwiseDescribeProject(workspaceId, { app: details.appId, request })
      if (r.sessionId) {
        await waitForSession(store, r.sessionId)
        shellValue.showChat(r.sessionId)
      }
    } catch (err) {
      toast.error(t('memwise.projects.new.describeFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }

  const askOnHome = async (question: string) => {
    const api = getMemwiseApi()
    if (!workspaceId || !api || typeof api.memwiseAsk !== 'function') { toast.error(t('memwise.notAvailable')); return }
    try {
      const r = await api.memwiseAsk(workspaceId, { domain: project.domain, question, ...(project.stored && project.id !== project.domain ? { project: project.id } : {}) })
      await waitForSession(store, r.sessionId)
      // A project built on pages answers into a draft page (26 §4); the page's chat is the one asked.
      navigate(routes.view.project(project.id, r.pageId ? { type: 'page', pageId: r.pageId } : { type: 'record', entity: r.entity, recordId: r.recordId }))
    } catch (err) {
      toast.error(t('memwise.home.failed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }

  const title = chatTitle()
  function chatTitle(): string {
    switch (details.type) {
      case 'app': return appOf(details.appId)?.home?.title ?? appOf(details.appId)?.name ?? details.appId
      case 'new': return t('memwise.projects.new.title', { one: appOf(details.appId)?.nouns?.one ?? t('memwise.projects.project') })
      case 'update': return t('memwise.projects.update.title')
    }
    if (all) return t('memwise.shell.waitingAll')
    switch (details.type) {
      case 'home': return project!.name
      case 'waiting': return reviewing ? t('memwise.pages.change.chatTitle', { page: reviewing.pageTitle }) : item ? inboxItemStepTitle(item, t) : t('memwise.shell.waiting')
      case 'dashboard': return domain?.pages.find(p => p.id === details.pageId)?.title ?? t('memwise.dashboard.title')
      case 'playbook': return playbooks?.find(p => p.id === details.workflowId)?.title ?? details.workflowId
      case 'run': return cases?.find(c => c.caseId === details.caseId)?.title ?? t('memwise.shell.run')
      case 'record': return recordTitle ?? entityType?.title ?? t('memwise.shell.record')
      case 'records': return pluralTitle(domain?.entities.find(e => e.key === details.entity)?.title ?? details.entity)
      case 'settings': return t('memwise.shell.projectSettings')
      case 'page': return writtenPage.data?.title ?? t('memwise.shell.page')
      case 'change': return openChange.data ? t('memwise.pages.change.chatTitle', { page: openChange.data.pageTitle }) : t('memwise.pages.change.title')
      case 'cr': return openCr?.label ? t('memwise.regulated.change.title', { label: openCr.label })
        : /^cr_/.test(details.crId) ? t('memwise.inbox.kind.changeRequest') : t('memwise.regulated.change.title', { label: details.crId })
      case 'audit': return t('memwise.regulated.audit.title')
      case 'tmf': return details.zone ? zoneName({ id: details.zone, name: details.zone }, t) : t('memwise.regulated.tmf.title')
      default: return project!.name
    }
  }

  const isHome = details.type === 'home' && !all
  const chat = (
    <AnchoredChat
      key={routeKey}
      anchor={anchor}
      title={title}
      placeholder={details.type === 'new'
        ? t('memwise.projects.new.describePlaceholder', { one: appOf(details.appId)?.nouns?.one ?? t('memwise.projects.project') })
        : reviewing || details.type === 'change' ? t('memwise.pages.change.askPlaceholder') : item ? t('memwise.shell.askStep') : entityType ? t('memwise.shell.askAboutThis', { what: entityType.title.toLowerCase() }) : placeholderFor(details.type, all, t)}
      sessionId={pinnedChat ?? (details.type === 'home' ? details.chatId ?? null : null)}
      alwaysNew={isHome || details.type === 'new'}
      {...(details.type === 'new' ? { onSend: describe } : {})}
      {...(isHome ? {
        empty: (send: (m: string) => Promise<void>, busy: boolean) => (
          <HomeChatColumn project={project} domain={domain} send={send} busy={busy} />
        ),
        ...(domain?.home ? { onSend: askOnHome } : {}),
        onStarted: (sessionId: string) => navigate(routes.view.project(project.id, { type: 'home', chatId: sessionId })),
        onNewChat: () => navigate(routes.view.project(project.id)),
      } : {})}
    />
  )

  return (
    <ProjectShellContext.Provider value={shellValue}>
      <AppShellProvider value={context}>
        <div className="flex h-full min-w-0" style={{ gap: PANEL_GAP }} data-testid="project-screen" data-project={project.id} data-detail={details.type}>
          <ShellCard className="shrink-0" style={{ width: CHAT_COLUMN_WIDTH, minWidth: CHAT_COLUMN_MIN, flexShrink: 1 }} testId="shell-chat-column">
            {chat}
          </ShellCard>
          <ShellCard className="min-w-0 flex-1" testId="shell-page-column">
            <MwProjectsNavProvider nav={nav}>
              <PageColumn view={{ projectId: all ? ALL_PROJECTS : project.id, details }} project={project} projects={projects} stored={stored} />
            </MwProjectsNavProvider>
          </ShellCard>
        </div>
      </AppShellProvider>
    </ProjectShellContext.Provider>
  )
}

function placeholderFor(type: string, all: boolean, t: (k: string) => string): string {
  if (all || type === 'waiting') return t('memwise.shell.askWaiting')
  if (type === 'record') return t('memwise.shell.askRecord')
  if (type === 'playbook') return t('memwise.shell.askPlaybook')
  if (type === 'run') return t('memwise.shell.askRun')
  if (type === 'records') return t('memwise.shell.askRecords')
  if (type === 'cr') return t('memwise.regulated.shell.askChange')
  if (type === 'audit') return t('memwise.regulated.shell.askAudit')
  if (type === 'tmf') return t('memwise.regulated.shell.askTmf')
  return t('memwise.shell.askPage')
}

function ShellCard({ children, className, style, testId }: { children: React.ReactNode; className?: string; style?: React.CSSProperties; testId?: string }) {
  return (
    <div
      className={cn('shell-card relative flex h-full flex-col overflow-hidden bg-paper shadow-elev-0 @container/panel', className)}
      style={{ borderRadius: RADIUS_INNER, ...style }}
      data-testid={testId}
    >
      {children}
    </div>
  )
}

/**
 * A record opened from a classic route (Stage 3): it moves to its own project once its page says
 * which; a record every project of the app shares, or one in no listed project, shows here.
 */
function RecordInItsProject({ entity, recordId, projects }: { entity: string; recordId: string; projects: ShellProject[] }) {
  const { data: page, loaded } = useMemwiseRecordPage(entity, recordId)
  const target = page?.project && projects.some(p => p.id === page.project) ? page.project : null
  React.useEffect(() => {
    if (target) navigate(routes.view.project(target, { type: 'record', entity, recordId }))
  }, [target, entity, recordId])
  if (!loaded || target) return null
  return <RecordShellPage entity={entity} recordId={recordId} />
}

/** The page column: what the route names. */
function PageColumn({ view, project, projects, stored }: { view: ProjectView; project: ShellProject; projects: ShellProject[]; stored: boolean }) {
  const domains = useAtomValue(memwiseDomainsAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const domain = domains?.find(d => d.id === project.domain) ?? null
  const d = view.details
  const regulated = useRegulatedNavigation()
  const go = (details: Parameters<typeof routes.view.project>[1]) => navigate(routes.view.project(project.id, details))
  const pageActions = {
    onOpenPage: (pageId: string) => go({ type: 'page', pageId }),
    onOpenRecord: (entity: string, recordId: string) => go({ type: 'record', entity, recordId }),
    onUrlClick: (url: string) => { void window.electronAPI?.openUrl(url) },
  }
  // An answer change opens as its review in Waiting for you when it waits for this person.
  const openChange = (changeId: string) => {
    const waiting = inbox?.find(i => pageChangeOf(i)?.changeId === changeId)
    go(waiting ? { type: 'waiting', itemId: waiting.id } : { type: 'change', changeId })
  }
  const reviewing = d.type === 'waiting' && d.itemId ? pageChangeOf(inbox?.find(i => i.id === d.itemId)) : undefined
  // Stage 3: the app home and New project belong to an app, not to one project.
  if (d.type === 'app') return <AppHomeScreen key={d.appId} appId={d.appId} />
  if (d.type === 'new') return <NewProjectScreen key={d.appId} appId={d.appId} />
  if (view.projectId === ALL_PROJECTS) {
    if (d.type === 'waiting' && d.itemId) return <WaitingItemShellPage key={d.itemId} itemId={d.itemId} />
    if (d.type === 'record') return <RecordInItsProject key={`${d.entity}:${d.recordId}`} entity={d.entity} recordId={d.recordId} projects={projects} />
    return stored ? <WaitingAllScreen /> : <WaitingPage projectId={ALL_PROJECTS} projects={projects} />
  }
  switch (d.type) {
    case 'home':
      // A draft's Home is its draft: what it will run, and Start.
      if (project.status === 'draft') return <NewProjectScreen key={project.id} appId={project.appId} draftId={project.id} />
      return <HomePinnedPage project={project} domain={domain} />
    case 'update': return <TemplateUpdateScreen key={d.itemId} projectId={project.id} inboxItemId={d.itemId} />
    case 'waiting':
      if (reviewing) {
        return (
          <PageChangeScreen
            key={reviewing.changeId}
            projectId={reviewing.projectId}
            changeId={reviewing.changeId}
            {...pageActions}
            onDone={() => go({ type: 'waiting' })}
          />
        )
      }
      return d.itemId ? <WaitingItemShellPage key={d.itemId} itemId={d.itemId} /> : <WaitingPage projectId={project.id} projects={projects} />
    case 'dashboard': return <DashboardPage key={`${project.id}:${d.domain}:${d.pageId}`} domainId={d.domain} pageId={d.pageId} {...(d.params ? { params: d.params } : {})} {...(project.stored ? { projectId: project.id } : {})} />
    case 'playbook': return <PlaybookShellPage key={d.workflowId} playbookId={d.workflowId} {...(project.stored ? { scope: project.id } : {})} />
    case 'run': return <RunShellPage key={d.caseId} caseId={d.caseId} />
    case 'record': return <RecordShellPage key={`${d.entity}:${d.recordId}`} entity={d.entity} recordId={d.recordId} />
    case 'records': return <RecordsShellPage key={`${project.id}:${d.entity}`} projectId={project.id} entity={d.entity} {...(project.stored ? { scope: project.id } : {})} />
    case 'settings': return <ProjectSettingsPage project={project} {...(d.tab ? { tab: d.tab } : {})} />
    case 'page': return <PageScreen key={d.pageId} projectId={project.id} pageId={d.pageId} {...pageActions} onOpenChange={openChange} />
    case 'change': return <PageChangeScreen key={d.changeId} projectId={project.id} changeId={d.changeId} {...pageActions} onDone={() => go({ type: 'waiting' })} />
    case 'cr': return <ChangeRequestScreen key={d.crId} projectId={project.id} crId={d.crId} navigation={regulated} />
    case 'audit': return <AuditTrailScreen key={`${d.entity ?? ''}:${d.recordId ?? ''}`} projectId={project.id} {...(d.entity && d.recordId ? { entity: d.entity, recordId: d.recordId } : {})} navigation={regulated} />
    case 'tmf': return <TmfIndexScreen projectId={project.id} zoneId={d.zone ?? null} navigation={regulated} />
  }
}

/**
 * The Stage 5 screens' way around inside the shell: the routes they would open are rewritten to the
 * project's (shell-routes), and a change request's chat shows in the chat column.
 */
function useRegulatedNavigation(): RegulatedNavigation | undefined {
  const shell = useProjectShell()
  return React.useMemo(() => (shell ? { openSession: shell.showChat } : undefined), [shell])
}

/** The answer change an inbox item reviews (26 §4), if it is one. */
function pageChangeOf(item: MwInboxItem | null | undefined) {
  return item && 'pageChange' in item ? item.pageChange : undefined
}
