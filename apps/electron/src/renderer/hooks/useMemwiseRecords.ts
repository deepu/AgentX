/**
 * Phase 6 data hooks: record pages, the domain page tree, record queries, dashboards, views,
 * automations (triggers), audit trails and file bytes (docs/memwise/24-phase-6-interfaces.md §13).
 *
 * Each detail hook refetches through useMemwiseQuery on the pushes that concern it: `records`
 * (a record was written), `triggers`, `definitions` and `status`. Writes go through
 * useMemwiseRecordCalls, which answers "not available" on a host without the Phase 6 calls.
 */

import { useMemo } from 'react'
import { useStore } from 'jotai'
import i18n from 'i18next'
import type {
  MwAuditExport,
  MwAuditExportInput,
  MwAuditTrail,
  MwChange,
  MwDashboard,
  MwFileData,
  MwRecordCreateInput,
  MwRecordPage,
  MwRecordQueryInput,
  MwRecordQueryResult,
  MwRecordTransitionInput,
  MwRecordUpdateInput,
  MwRecordWriteResult,
  MwReleaseTriggerInput,
  MwSaveNoteInput,
  MwSaveViewInput,
  MwSubmitResult,
  MwTreeNode,
  MwTrigger,
  MwView,
} from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseQuery, type MemwiseApi, type MemwiseQuery } from './useMemwise'

/** Whether this host offers the Phase 6 record calls at all. */
export function hasRecordCalls(api: MemwiseApi | null = getMemwiseApi()): boolean {
  return !!api && typeof api.memwiseGetRecordPage === 'function'
}

/** Whether a push may change this record's page: the record itself, or any record (related rows, rollups, flags), its cases, the definitions. */
export function recordChangeMatches(c: MwChange, entity: string, id: string, cur: MwRecordPage | null): boolean {
  if (c.kind === 'status' || c.kind === 'definitions') return true
  if (c.kind === 'records') {
    // Rollups and related tables follow other records too; refetch on any write in the same domain's entities.
    if (!c.entity || !c.id) return true
    if (c.entity === entity && c.id === id) return true
    if (!cur) return true
    return Object.values(cur.related).some(r => r.entity === c.entity) || cur.parents.some(p => p.entity === c.entity && p.id === c.id)
  }
  if (c.kind === 'run' || c.kind === 'case' || c.kind === 'inbox') {
    if (!cur) return true
    if (cur.review && (c.caseId === cur.review.caseId || c.id === cur.review.runId)) return true
    return cur.cases.some(k => k.caseId === c.caseId || k.runId === c.id)
  }
  return false
}

export function useMemwiseRecordPage(entity: string | null, id: string | null, reviewStepRunId?: string | null): MemwiseQuery<MwRecordPage | null> {
  return useMemwiseQuery<MwRecordPage | null>(
    entity && id ? `record-page:${entity}:${id}:${reviewStepRunId ?? ''}` : null,
    async (api, ws) => {
      if (!hasRecordCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetRecordPage(ws, { entity: entity!, id: id!, ...(reviewStepRunId ? { review: { stepRunId: reviewStepRunId } } : {}) })
    },
    (c, cur) => recordChangeMatches(c, entity!, id!, cur),
  )
}

/** One level of a domain's page tree (records:tree); `parent` absent is the domain's top level. */
export function useMemwiseRecordTree(domain: string | null, parent?: { entity: string; id: string } | null): MemwiseQuery<MwTreeNode[]> {
  return useMemwiseQuery<MwTreeNode[]>(
    domain ? `tree:${domain}:${parent ? `${parent.entity}:${parent.id}` : ''}` : null,
    async (api, ws) => (typeof api.memwiseRecordTree === 'function' ? api.memwiseRecordTree(ws, { domain: domain!, ...(parent ? { parent } : {}) }) : []),
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useMemwiseRecordQuery(input: MwRecordQueryInput | null): MemwiseQuery<MwRecordQueryResult> {
  const key = input ? `query:${JSON.stringify(input)}` : null
  return useMemwiseQuery<MwRecordQueryResult>(
    key,
    async (api, ws) => {
      if (typeof api.memwiseQueryRecords !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseQueryRecords(ws, input!)
    },
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useMemwiseDashboard(domain: string | null, pageId: string | null, params?: Record<string, string>): MemwiseQuery<MwDashboard> {
  const key = domain && pageId ? `dashboard:${domain}:${pageId}:${JSON.stringify(params ?? {})}` : null
  return useMemwiseQuery<MwDashboard>(
    key,
    async (api, ws) => {
      if (typeof api.memwiseGetDashboard !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetDashboard(ws, { domain: domain!, pageId: pageId!, ...(params && Object.keys(params).length ? { params } : {}) })
    },
    // A dashboard is computed on read: any record write may move it.
    c => c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useMemwiseViews(domain: string | null, entity?: string | null): MemwiseQuery<MwView[]> {
  return useMemwiseQuery<MwView[]>(
    domain ? `views:${domain}:${entity ?? ''}` : null,
    async (api, ws) => (typeof api.memwiseListViews === 'function' ? api.memwiseListViews(ws, { domain: domain!, ...(entity ? { entity } : {}) }) : []),
    c => c.kind === 'definitions' || c.kind === 'status',
  )
}

export function useMemwiseTriggers(): MemwiseQuery<MwTrigger[]> {
  return useMemwiseQuery<MwTrigger[]>(
    'triggers',
    async (api, ws) => (typeof api.memwiseListTriggers === 'function' ? api.memwiseListTriggers(ws) : []),
    // "Next due" follows record dates; firings start cases.
    c => c.kind === 'triggers' || c.kind === 'records' || c.kind === 'definitions' || c.kind === 'status' || c.kind === 'case',
  )
}

export function useMemwiseAuditTrail(entity: string | null, id: string | null): MemwiseQuery<MwAuditTrail | null> {
  return useMemwiseQuery<MwAuditTrail | null>(
    entity && id ? `audit:${entity}:${id}` : null,
    async (api, ws) => (typeof api.memwiseGetAuditTrail === 'function' ? api.memwiseGetAuditTrail(ws, { entity: entity!, id: id! }) : null),
    c => c.kind === 'records' && (!c.entity || (c.entity === entity && (!c.id || c.id === id))),
  )
}

/** A stored file's bytes (the record page's viewer). */
export function useMemwiseFile(fileId: string | null): MemwiseQuery<MwFileData> {
  return useMemwiseQuery<MwFileData>(
    fileId ? `file:${fileId}` : null,
    async (api, ws) => {
      if (typeof api.memwiseReadFile !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseReadFile(ws, fileId!)
    },
    () => false,
  )
}

/** The Phase 6 writes, bound to the workspace. */
export interface MemwiseRecordCalls {
  create: (input: MwRecordCreateInput) => Promise<MwRecordWriteResult>
  update: (input: MwRecordUpdateInput) => Promise<MwRecordWriteResult>
  transition: (input: MwRecordTransitionInput) => Promise<MwRecordWriteResult>
  saveNote: (input: MwSaveNoteInput) => Promise<MwRecordWriteResult>
  saveView: (input: MwSaveViewInput) => Promise<MwView>
  releaseTrigger: (input: MwReleaseTriggerInput) => Promise<MwSubmitResult & { started?: number }>
  exportAudit: (input: MwAuditExportInput) => Promise<MwAuditExport>
}

export function useMemwiseRecordCalls(): MemwiseRecordCalls {
  const store = useStore()
  return useMemo(() => {
    const need = <K extends keyof MemwiseApi>(method: K) => {
      const ws = store.get(memwiseWorkspaceIdAtom)
      const api = getMemwiseApi()
      if (!ws || !api || typeof api[method] !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return { ws, api }
    }
    return {
      create: async input => { const { ws, api } = need('memwiseCreateRecord'); return api.memwiseCreateRecord(ws, input) },
      update: async input => { const { ws, api } = need('memwiseUpdateRecord'); return api.memwiseUpdateRecord(ws, input) },
      transition: async input => { const { ws, api } = need('memwiseTransitionRecord'); return api.memwiseTransitionRecord(ws, input) },
      saveNote: async input => { const { ws, api } = need('memwiseSaveNote'); return api.memwiseSaveNote(ws, input) },
      saveView: async input => { const { ws, api } = need('memwiseSaveView'); return api.memwiseSaveView(ws, input) },
      releaseTrigger: async input => { const { ws, api } = need('memwiseReleaseTrigger'); return api.memwiseReleaseTrigger(ws, input) },
      exportAudit: async input => { const { ws, api } = need('memwiseExportAuditTrail'); return api.memwiseExportAuditTrail(ws, input) },
    }
  }, [store])
}

/** Save base64 bytes as a download in the browser (audit export). */
export function downloadBase64(name: string, mime: string, dataBase64: string): void {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Base64 to bytes (the viewer hands these to react-pdf). */
export function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
