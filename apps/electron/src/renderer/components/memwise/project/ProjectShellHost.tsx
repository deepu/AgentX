/**
 * Wires the project shell into the app shell: the project sidebar in the sidebar slot, the route
 * rewriter (older MemWise routes open inside a project), and one screen at a time (the shell's
 * two columns live inside one panel).
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import type { NavigationState } from '../../../../shared/types'
import { parseRouteToNavigationState } from '../../../../shared/route-parser'
import type { ViewRoute } from '../../../../shared/routes'
import { ALL_PROJECTS, projectRoute } from '../../../../shared/project-route'
import { memwiseCasesAtom, memwiseDomainsAtom, memwiseInboxAtom, memwisePlaybooksAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { focusedPanelIndexAtom, panelStackAtom, reconcilePanelStackAtom } from '@/atoms/panel-stack'
import { ProjectSidebar } from './ProjectSidebar'
import { pickProject, projectLookups } from './project-model'
import { readLastProject, useProjectShellEnabled, useShellProjects } from './useProjectShell'
import { setShellRouteRewriter, shellRouteFor } from './shell-routes'

/**
 * Whether the shell is on (null: not known yet, MemWise is starting), and keeps routes and
 * panels in its shape while it is.
 */
export function useProjectShellRouting(navState: NavigationState, workspaceName?: string): boolean | null {
  const state = useProjectShellEnabled()
  const enabled = state === true
  const store = useStore()
  const { projects } = useShellProjects(workspaceName)
  const stack = useAtomValue(panelStackAtom)
  const focusedIndex = useAtomValue(focusedPanelIndexAtom)
  const reconcile = useSetAtom(reconcilePanelStackAtom)

  // The rewriter reads the latest data each time it runs.
  const projectsRef = React.useRef(projects)
  projectsRef.current = projects
  const rewrite = React.useCallback((route: string): string | null => {
    const state = parseRouteToNavigationState(route)
    if (!state || state.navigator === 'mw') return null
    const list = projectsRef.current
    if (list.length === 0) return null
    const ws = store.get(memwiseWorkspaceIdAtom)
    const open = stack.length ? parseRouteToNavigationState((stack[focusedIndex] ?? stack[0])!.route) : null
    const openProject = open?.navigator === 'mw' && open.view && open.view.projectId !== ALL_PROJECTS ? open.view.projectId : null
    const current = pickProject(list, openProject, readLastProject(ws))
    if (!current) return null
    const l = projectLookups({ playbooks: store.get(memwisePlaybooksAtom), domains: store.get(memwiseDomainsAtom) })
    return shellRouteFor(state, {
      currentProject: current.id,
      workflowDomain: l.workflowDomain,
      entityDomain: l.entityDomain,
      inbox: store.get(memwiseInboxAtom),
      cases: store.get(memwiseCasesAtom),
      hasProject: id => list.some(p => p.id === id),
      // Stage 3: only once projects are stored does an app id stop being a project id.
      ...(list.some(p => p.stored) ? {
        projectForApp: (app: string) => {
          if (current.apps.includes(app)) return current.id
          const running = list.filter(p => p.apps.includes(app) && p.status !== 'archived')
          return running.length === 1 ? running[0]!.id : undefined
        },
      } : {}),
    })
  }, [store, stack, focusedIndex])

  React.useEffect(() => {
    if (!enabled) return
    setShellRouteRewriter(rewrite)
    return () => setShellRouteRewriter(null)
  }, [enabled, rewrite])

  // One screen at a time: an older route (a restored window, a link) becomes its shell route, and
  // extra panels close. Settings and the other app screens keep their own layout.
  React.useEffect(() => {
    if (!enabled || stack.length === 0) return
    const focused = (stack[focusedIndex] ?? stack[0])!.route
    // A route naming a project that isn't here (a restored route from another workspace) opens in
    // the landing project: a waiting item keeps its item, anything else lands on Home.
    const view = navState.navigator === 'mw' ? navState.view : null
    if (view && view.projectId !== ALL_PROJECTS && projects.length > 0 && !projects.some(p => p.id === view.projectId)) {
      const landing = pickProject(projects, null, readLastProject(store.get(memwiseWorkspaceIdAtom)))
      const details = view.details?.type === 'waiting' ? view.details : { type: 'home' as const }
      if (landing) reconcile({ entries: [{ route: projectRoute(landing.id, details) as ViewRoute, proportion: 1 }], focusedIndex: 0 })
      return
    }
    const target = stack.length === 1 && navState.navigator === 'mw' ? null : rewrite(focused)
    if (target && target !== focused) {
      reconcile({ entries: [{ route: target as ViewRoute, proportion: 1 }], focusedIndex: 0 })
    } else if (stack.length > 1 && stack.some(p => p.route.startsWith('mw/'))) {
      const keep = stack.find(p => p.route.startsWith('mw/'))!.route
      reconcile({ entries: [{ route: keep, proportion: 1 }], focusedIndex: 0 })
    }
  }, [enabled, stack, focusedIndex, navState, projects, store, rewrite, reconcile])

  return state
}

/** The project sidebar for the route that is open. */
export function ProjectShellSidebar({ navState, workspaceName }: { navState: NavigationState; workspaceName?: string }) {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const domains = useAtomValue(memwiseDomainsAtom)
  const { projects, apps, totalWaiting } = useShellProjects(workspaceName)
  const view = navState.navigator === 'mw' ? navState.view : null
  const all = view?.projectId === ALL_PROJECTS
  const project = pickProject(projects, all ? null : view?.projectId, readLastProject(workspaceId))
  if (!project) return null
  // Across all projects nothing in one project's sidebar is open.
  const details = all ? { type: 'page' as const, pageId: '' } : view?.details ?? { type: 'home' as const }
  return (
    <ProjectSidebar
      apps={apps}
      project={project}
      domain={domains?.find(d => d.id === project.domain) ?? null}
      details={details}
      totalWaiting={totalWaiting}
    />
  )
}
