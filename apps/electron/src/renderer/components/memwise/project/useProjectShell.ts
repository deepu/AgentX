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
import { groupByApp, pickProject, shellProjects, type ShellApp, type ShellProject } from './project-model'

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
}

export function useShellProjects(workspaceName?: string): ProjectShellData {
  const domains = useAtomValue(memwiseDomainsAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  return React.useMemo(() => {
    const projects = shellProjects(domains, inbox, playbooks, workspaceName)
    return { projects, apps: groupByApp(projects), domains: domains ?? [], totalWaiting: inbox?.length ?? 0 }
  }, [domains, inbox, playbooks, workspaceName])
}

/** The project to land on when the shell opens with no project in the route. */
export function useLandingProject(projects: ShellProject[]): ShellProject | null {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  return pickProject(projects, null, readLastProject(workspaceId))
}
