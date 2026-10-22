/**
 * Stage 3 data hooks (docs/memwise/26-projects-and-pages.md §3): apps with their projects for the
 * switcher, a project's settings, the app home, Waiting for you across every project, and a
 * template update's review. Each refetches through useMemwiseQuery on the pushes that concern it
 * (`projects`, and the inbox, runs and records where counts move). Writes go through
 * useMemwiseProjectCalls, which answers "not available" on a host without the Stage 3 calls.
 */

import { useMemo } from 'react'
import { useStore } from 'jotai'
import i18n from 'i18next'
import type {
  MwApp,
  MwAppHome,
  MwChange,
  MwCreateProjectInput,
  MwDescribeProjectInput,
  MwDescribeProjectResult,
  MwProjectDetail,
  MwSaveAsTemplateInput,
  MwSaveAsTemplateResult,
  MwTakeTemplateUpdateResult,
  MwTemplateUpdateReview,
  MwUpdateProjectInput,
  MwWaitingGroup,
} from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseQuery, type MemwiseApi, type MemwiseQuery } from './useMemwise'

/** Whether this host offers the Stage 3 project calls at all. */
export function hasProjectCalls(api: MemwiseApi | null = getMemwiseApi()): boolean {
  return !!api && typeof api.memwiseListApps === 'function'
}

/** Pushes after which project lists and counts may differ. */
export function projectsChangeMatters(c: MwChange): boolean {
  return c.kind === 'projects' || c.kind === 'status' || c.kind === 'definitions' || c.kind === 'inbox' || c.kind === 'run' || c.kind === 'case'
}

/** Waiting counts across every project of every app (the switcher's "Waiting for you, all projects"). */
export function waitingTotal(apps: MwApp[] | null | undefined): number {
  const seen = new Set<string>()
  let n = 0
  // A project that runs several apps is listed under each: count it once.
  for (const a of apps ?? []) for (const p of a.projects) if (!seen.has(p.id)) { seen.add(p.id); n += p.waiting }
  return n
}

export interface MemwiseProjects extends MemwiseQuery<MwApp[]> {
  /** Everything waiting for the person, across projects. */
  waiting: number
}

/** Apps with the projects this person sees, each with its waiting count, app first (D104). */
export function useMemwiseProjects(): MemwiseProjects {
  const q = useMemwiseQuery<MwApp[]>(
    'projects:apps',
    async (api, ws) => (hasProjectCalls(api) ? api.memwiseListApps(ws) : []),
    projectsChangeMatters,
  )
  return { ...q, waiting: waitingTotal(q.data) }
}

export function useMemwiseProject(projectId: string | null): MemwiseQuery<MwProjectDetail | null> {
  return useMemwiseQuery<MwProjectDetail | null>(
    projectId ? `project:${projectId}` : null,
    async (api, ws) => {
      if (!hasProjectCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetProject(ws, projectId!)
    },
    c => c.kind === 'projects' || c.kind === 'status' || c.kind === 'definitions' || c.kind === 'inbox',
  )
}

export function useMemwiseAppHome(appId: string | null): MemwiseQuery<MwAppHome> {
  return useMemwiseQuery<MwAppHome>(
    appId ? `app-home:${appId}` : null,
    async (api, ws) => {
      if (!hasProjectCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetAppHome(ws, appId!)
    },
    c => projectsChangeMatters(c) || c.kind === 'records',
  )
}

export function useMemwiseWaitingAll(): MemwiseQuery<MwWaitingGroup[]> {
  return useMemwiseQuery<MwWaitingGroup[]>(
    'waiting:all',
    async (api, ws) => (hasProjectCalls(api) ? api.memwiseWaitingAll(ws) : []),
    c => projectsChangeMatters(c) || c.kind === 'records' || c.kind === 'drafts' || c.kind === 'plugins' || c.kind === 'external' || c.kind === 'triggers',
  )
}

/** The review of a project's pending template update; `test` also replays one of its past cases (slow). */
export function useMemwiseTemplateReview(projectId: string | null, test = false): MemwiseQuery<MwTemplateUpdateReview | null> {
  return useMemwiseQuery<MwTemplateUpdateReview | null>(
    projectId ? `template-review:${projectId}:${test ? 'test' : ''}` : null,
    async (api, ws) => {
      if (!hasProjectCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseReviewTemplateUpdate(ws, { projectId: projectId!, ...(test ? { test: true } : {}) })
    },
    c => c.kind === 'projects' || c.kind === 'definitions',
  )
}

export interface MemwiseProjectCalls {
  create(input: MwCreateProjectInput): Promise<MwProjectDetail>
  update(input: MwUpdateProjectInput): Promise<MwProjectDetail>
  start(projectId: string): Promise<MwProjectDetail>
  archive(projectId: string): Promise<MwProjectDetail>
  discard(projectId: string): Promise<void>
  describe(input: MwDescribeProjectInput): Promise<MwDescribeProjectResult>
  saveAsTemplate(input: MwSaveAsTemplateInput): Promise<MwSaveAsTemplateResult>
  takeUpdate(projectId: string): Promise<MwTakeTemplateUpdateResult>
  skipUpdate(projectId: string): Promise<void>
}

export function useMemwiseProjectCalls(): MemwiseProjectCalls {
  const store = useStore()
  return useMemo(() => {
    const need = <K extends keyof MemwiseApi>(method: K) => {
      const ws = store.get(memwiseWorkspaceIdAtom)
      const api = getMemwiseApi()
      if (!ws || !api || typeof api[method] !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return { ws, api }
    }
    return {
      create: async input => { const { ws, api } = need('memwiseCreateProject'); return api.memwiseCreateProject(ws, input) },
      update: async input => { const { ws, api } = need('memwiseUpdateProject'); return api.memwiseUpdateProject(ws, input) },
      start: async id => { const { ws, api } = need('memwiseStartProject'); return api.memwiseStartProject(ws, id) },
      archive: async id => { const { ws, api } = need('memwiseArchiveProject'); return api.memwiseArchiveProject(ws, id) },
      discard: async id => { const { ws, api } = need('memwiseDiscardProject'); return api.memwiseDiscardProject(ws, id) },
      describe: async input => { const { ws, api } = need('memwiseDescribeProject'); return api.memwiseDescribeProject(ws, input) },
      saveAsTemplate: async input => { const { ws, api } = need('memwiseSaveAsTemplate'); return api.memwiseSaveAsTemplate(ws, input) },
      takeUpdate: async projectId => { const { ws, api } = need('memwiseTakeTemplateUpdate'); return api.memwiseTakeTemplateUpdate(ws, { projectId }) },
      skipUpdate: async projectId => { const { ws, api } = need('memwiseSkipTemplateUpdate'); return api.memwiseSkipTemplateUpdate(ws, { projectId }) },
    }
  }, [store])
}

/**
 * How many records of each type one project holds (the sidebar's RECORDS counts; a domain's own
 * counts are across every project). Null for a project that isn't stored: the domain's counts serve.
 */
export function useProjectRecordCounts(project: { id: string; domain: string; stored?: boolean } | null, entities: string[]): MemwiseQuery<Record<string, number>> {
  const key = project?.stored && entities.length ? `record-counts:${project.id}:${entities.join(',')}` : null
  return useMemwiseQuery<Record<string, number>>(
    key,
    async (api, ws) => {
      if (typeof api.memwiseQueryRecords !== 'function') return {}
      const out: Record<string, number> = {}
      for (const entity of entities) {
        try {
          out[entity] = (await api.memwiseQueryRecords(ws, { entity, domain: project!.domain, project: project!.id, limit: 1 })).total
        } catch { /* a type this person can't read: no count */ }
      }
      return out
    },
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'projects',
  )
}
