/**
 * The project shell's state (doc 26 §2): whether it is on, the projects, the open one, and the
 * rules that keep navigation inside it. The shell is on when MemWise runs with at least one
 * domain and the person hasn't switched to the classic layout (Settings › Advanced).
 */

import * as React from 'react'
import { atom, useAtomValue } from 'jotai'
import type { MwDomain } from '@memwise/shared/protocol'
import {
  memwiseDomainsAtom,
  memwiseInboxAtom,
  memwisePlaybooksAtom,
  memwiseStatusAtom,
  memwiseWorkspaceIdAtom,
} from '@/atoms/memwise'
import { hasProjectCalls, useMemwiseProjects } from '@/hooks/useMemwiseProjects'
import { groupByApp, pickProject, shellProjects, storedShellApps, storedShellProjects, type ShellApp, type ShellProject } from './project-model'

const LAYOUT_KEY = 'memwise-layout'
const LAST_PROJECT_KEY = 'memwise-last-project.'

export type ShellLayout = 'projects' | 'classic'

function readLayout(): ShellLayout {
  try { return window.localStorage.getItem(LAYOUT_KEY) === 'classic' ? 'classic' : 'projects' } catch { return 'projects' }
}

/** The person's choice of layout (kept on this device). */
export const shellLayoutAtom = atom<ShellLayout>(readLayout())

export function saveShellLayout(layout: ShellLayout): void {
  try { window.localStorage.setItem(LAYOUT_KEY, layout) } catch { /* not remembered */ }
}

export function readLastProject(workspaceId: string | null): string | null {
  if (!workspaceId) return null
  try { return window.localStorage.getItem(LAST_PROJECT_KEY + workspaceId) } catch { return null }
}

export function writeLastProject(workspaceId: string | null, projectId: string): void {
  if (!workspaceId || projectId === '*') return
  try { window.localStorage.setItem(LAST_PROJECT_KEY + workspaceId, projectId) } catch { /* not remembered */ }
}

/**
 * Whether the shell is on: MemWise is running here with domains loaded, and the classic layout
 * wasn't chosen. Null while it can't tell yet (the kernel is starting).
 */
export function useProjectShellEnabled(): boolean | null {
  const layout = useAtomValue(shellLayoutAtom)
  const domains = useAtomValue(memwiseDomainsAtom)
  const status = useAtomValue(memwiseStatusAtom)
  if (layout === 'classic') return false
  if (!status) return null
  if (!status.ready) return null
  if (domains === null) return null
  return domains.length > 0
}

export interface ProjectShellData {
  projects: ShellProject[]
  apps: ShellApp[]
  domains: MwDomain[]
  totalWaiting: number
  /** Stage 3: the projects are stored ones (not one per domain). */
  stored: boolean
}

/**
 * The shell's projects: as stored (Stage 3) when the host has the project calls and lists any,
 * else one per domain (Stage 1).
 */
export function useShellProjects(workspaceName?: string): ProjectShellData {
  const domains = useAtomValue(memwiseDomainsAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const stored = useMemwiseProjects()
  return React.useMemo(() => {
    if (stored.data && stored.data.some(a => a.projects.length > 0)) {
      const projects = storedShellProjects(stored.data, domains, workspaceName)
      // Everything waiting: the inbox, plus each template update (the inbox doesn't hold those).
      const updates = projects.filter(p => p.update).length
      return { projects, apps: storedShellApps(stored.data, projects), domains: domains ?? [], totalWaiting: (inbox?.length ?? 0) + updates, stored: true }
    }
    // Still asking for the stored ones: no projects yet, so no route is taken for a missing one.
    if (hasProjectCalls() && !stored.data && !stored.error) return { projects: [], apps: [], domains: domains ?? [], totalWaiting: inbox?.length ?? 0, stored: false }
    const projects = shellProjects(domains, inbox, playbooks, workspaceName)
    return { projects, apps: groupByApp(projects), domains: domains ?? [], totalWaiting: inbox?.length ?? 0, stored: false }
  }, [domains, inbox, playbooks, workspaceName, stored.data, stored.error])
}

/** The project to land on when the shell opens with no project in the route. */
export function useLandingProject(projects: ShellProject[]): ShellProject | null {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  return pickProject(projects, null, readLastProject(workspaceId))
}
