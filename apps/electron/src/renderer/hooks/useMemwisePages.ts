/**
 * Pages data hooks (docs/memwise/26-projects-and-pages.md §4): a project's pages (the sidebar's
 * PAGES tree, Home's "Pages kept up to date"), one page, its versions, an answer change, and the
 * writes (keep, undo, archive, refresh now, accept or send back, ask in a project).
 *
 * Each refetches through useMemwiseQuery on the `pages` pushes that concern it (and `status`,
 * `definitions`); an answer change also follows the inbox, since deciding it ends its review.
 */

import { useMemo } from 'react'
import { useStore } from 'jotai'
import i18n from 'i18next'
import type {
  MwChange, MwPage, MwPageChange, MwPageCreateInput, MwPageChangeDecideInput, MwPageKeepInput, MwPageRefreshResult, MwPageSummary, MwPageVersion,
  MwPageWriteResult, MwProjectAskInput, MwProjectAskResult, MwSubmitResult,
} from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseQuery, type MemwiseApi, type MemwiseQuery } from './useMemwise'

/** Whether this host offers the pages calls at all. */
export function hasPageCalls(api: MemwiseApi | null = getMemwiseApi()): boolean {
  return !!api && typeof api.memwiseListPages === 'function'
}

const always = (c: MwChange) => c.kind === 'status' || c.kind === 'definitions'

/** Whether a push may change a project's page list. */
export function pagesChangeMatches(c: MwChange, projectId: string): boolean {
  if (always(c)) return true
  return c.kind === 'pages' && (!c.projectId || c.projectId === projectId || !!c.id)
}

/** Whether a push may change this page (itself, a sub-page's line, its answer change, live records in it). */
export function pageChangeMatches(c: MwChange, pageId: string, cur: MwPage | null): boolean {
  if (always(c)) return true
  if (c.kind === 'records') return !!cur && /```records/.test(cur.written)
  if (c.kind !== 'pages') return false
  if (!c.id || c.id === pageId) return true
  if (!cur) return true
  return cur.children.some(k => k.id === c.id) || cur.parent === c.id
}

/** A project's pages (not archived), parents before their sub-pages. */
export function useMemwisePages(projectId: string | null): MemwiseQuery<MwPageSummary[]> {
  return useMemwiseQuery<MwPageSummary[]>(
    projectId ? `pages:${projectId}` : null,
    async (api, ws) => (hasPageCalls(api) ? api.memwiseListPages(ws, { projectId: projectId! }) : []),
    c => pagesChangeMatches(c, projectId!),
  )
}

export function useMemwisePage(pageId: string | null): MemwiseQuery<MwPage | null> {
  return useMemwiseQuery<MwPage | null>(
    pageId ? `page:${pageId}` : null,
    async (api, ws) => {
      if (!hasPageCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetPage(ws, { pageId: pageId! })
    },
    (c, cur) => pageChangeMatches(c, pageId!, cur),
  )
}

export function useMemwisePageVersions(pageId: string | null): MemwiseQuery<MwPageVersion[]> {
  return useMemwiseQuery<MwPageVersion[]>(
    pageId ? `page-versions:${pageId}` : null,
    async (api, ws) => (hasPageCalls(api) ? api.memwisePageVersions(ws, { pageId: pageId! }) : []),
    c => always(c) || (c.kind === 'pages' && (!c.id || c.id === pageId)),
  )
}

export function useMemwisePageChange(changeId: string | null): MemwiseQuery<MwPageChange | null> {
  return useMemwiseQuery<MwPageChange | null>(
    changeId ? `page-change:${changeId}` : null,
    async (api, ws) => {
      if (!hasPageCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetPageChange(ws, { changeId: changeId! })
    },
    (c, cur) => always(c) || c.kind === 'inbox' || c.kind === 'run' || (c.kind === 'pages' && (!c.changeId || c.changeId === changeId || (!!cur && c.id === cur.pageId))),
  )
}

/** The pages writes, bound to the workspace. */
export interface MemwisePageCalls {
  keep: (input: MwPageKeepInput) => Promise<MwPageWriteResult>
  undo: (pageId: string, version?: number) => Promise<MwPageWriteResult>
  archive: (pageId: string) => Promise<MwPageWriteResult>
  refresh: (pageId: string) => Promise<MwPageRefreshResult>
  decide: (input: MwPageChangeDecideInput) => Promise<MwSubmitResult>
  ask: (input: MwProjectAskInput) => Promise<MwProjectAskResult>
  create: (input: MwPageCreateInput) => Promise<MwPageWriteResult>
}

export function useMemwisePageCalls(): MemwisePageCalls {
  const store = useStore()
  return useMemo(() => {
    const need = <K extends keyof MemwiseApi>(method: K) => {
      const ws = store.get(memwiseWorkspaceIdAtom)
      const api = getMemwiseApi()
      if (!ws || !api || typeof api[method] !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return { ws, api }
    }
    return {
      keep: async input => { const { ws, api } = need('memwiseKeepPage'); return api.memwiseKeepPage(ws, input) },
      undo: async (pageId, version) => { const { ws, api } = need('memwiseUndoPage'); return api.memwiseUndoPage(ws, { pageId, ...(version !== undefined ? { version } : {}) }) },
      archive: async pageId => { const { ws, api } = need('memwiseArchivePage'); return api.memwiseArchivePage(ws, { pageId }) },
      refresh: async pageId => { const { ws, api } = need('memwiseRefreshPage'); return api.memwiseRefreshPage(ws, { pageId }) },
      decide: async input => { const { ws, api } = need('memwiseDecidePageChange'); return api.memwiseDecidePageChange(ws, input) },
      ask: async input => { const { ws, api } = need('memwiseProjectAsk'); return api.memwiseProjectAsk(ws, input) },
      create: async input => { const { ws, api } = need('memwiseCreatePage'); return api.memwiseCreatePage(ws, input) },
    }
  }, [store])
}
