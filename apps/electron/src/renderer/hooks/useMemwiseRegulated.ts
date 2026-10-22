/**
 * Stage 5 data hooks (docs/memwise/26-projects-and-pages.md §7, §8): change requests, the
 * project's audit trail, inspector links and their questions, the TMF index. A project is a
 * domain for now (`projectId` is the domain id). Each refetches on the pushes that concern it:
 * `regulated` (a change request, link or question of the project), `audit` (the trail grew),
 * `records` (the TMF's documents), `definitions` and `status`.
 */

import { useMemo } from 'react'
import { useStore } from 'jotai'
import i18n from 'i18next'
import type {
  MwAuditExport, MwAuditLog, MwAuditQuery, MwAuditVerifyResult, MwChange, MwChangeRequest, MwChangeRequestSummary, MwChangeSignResult,
  MwChangeValidation, MwInspectorLink, MwInspectorLinkCreated, MwInspectorLinkInput, MwInspectorQuestion, MwOpenChangeInput,
  MwOpenChangeResult, MwTmfIndex, MwValidationSet,
} from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseQuery, type MemwiseApi, type MemwiseQuery } from './useMemwise'

/** Whether this host offers the Stage 5 calls at all (an older server has none). */
export function hasRegulatedCalls(api: MemwiseApi | null = getMemwiseApi()): boolean {
  return !!api && typeof api.memwiseGetChangeRequest === 'function'
}

const ofProject = (c: MwChange, project: string) => !c.project || c.project === project
const always = (c: MwChange) => c.kind === 'status' || c.kind === 'definitions'

export function useMemwiseChangeRequest(projectId: string | null, crId: string | null): MemwiseQuery<MwChangeRequest | null> {
  return useMemwiseQuery<MwChangeRequest | null>(
    projectId && crId ? `change-request:${projectId}:${crId}` : null,
    async (api, ws) => {
      if (!hasRegulatedCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetChangeRequest(ws, { crId: crId!, project: projectId! })
    },
    // The draft's edits come as `drafts` pushes; a publish as `definitions`.
    (c, cur) => always(c) || (c.kind === 'regulated' && ofProject(c, projectId!)) || (c.kind === 'drafts' && (!cur || !c.id || c.id === cur.draftId)),
  )
}

export function useMemwiseChangeRequests(projectId: string | null, workflowId?: string | null): MemwiseQuery<MwChangeRequestSummary[]> {
  return useMemwiseQuery<MwChangeRequestSummary[]>(
    projectId ? `change-requests:${projectId}:${workflowId ?? ''}` : null,
    async (api, ws) => (hasRegulatedCalls(api) ? api.memwiseListChangeRequests(ws, { project: projectId!, ...(workflowId ? { workflowId } : {}) }) : []),
    c => always(c) || (c.kind === 'regulated' && ofProject(c, projectId!)),
  )
}

export function useMemwiseAuditLog(query: MwAuditQuery | null): MemwiseQuery<MwAuditLog> {
  const key = query ? `audit-log:${JSON.stringify(query)}` : null
  return useMemwiseQuery<MwAuditLog>(
    key,
    async (api, ws) => {
      if (!hasRegulatedCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetAuditLog(ws, query!)
    },
    c => c.kind === 'status' || (c.kind === 'audit' && ofProject(c, query!.project)),
  )
}

export function useMemwiseInspectorLinks(projectId: string | null): MemwiseQuery<MwInspectorLink[]> {
  return useMemwiseQuery<MwInspectorLink[]>(
    projectId ? `inspector-links:${projectId}` : null,
    async (api, ws) => (hasRegulatedCalls(api) ? api.memwiseListInspectorLinks(ws, { project: projectId! }) : []),
    // Views and downloads move the counts: they are audit entries.
    c => always(c) || ((c.kind === 'regulated' || c.kind === 'audit') && ofProject(c, projectId!)),
  )
}

export function useMemwiseInspectorQuestions(projectId: string | null): MemwiseQuery<MwInspectorQuestion[]> {
  return useMemwiseQuery<MwInspectorQuestion[]>(
    projectId ? `inspector-questions:${projectId}` : null,
    async (api, ws) => (hasRegulatedCalls(api) ? api.memwiseListInspectorQuestions(ws, { project: projectId! }) : []),
    c => always(c) || (c.kind === 'regulated' && ofProject(c, projectId!)),
  )
}

export function useMemwiseTmfIndex(projectId: string | null, zone?: string | null): MemwiseQuery<MwTmfIndex> {
  return useMemwiseQuery<MwTmfIndex>(
    projectId ? `tmf:${projectId}:${zone ?? ''}` : null,
    async (api, ws) => {
      if (!hasRegulatedCalls(api)) throw new Error(i18n.t('memwise.notAvailable'))
      return api.memwiseGetTmfIndex(ws, { project: projectId!, ...(zone ? { zone } : {}) })
    },
    // Computed on read: any record write may move it.
    c => always(c) || c.kind === 'records',
  )
}

/** The Stage 5 writes, bound to the workspace. */
export interface MemwiseRegulatedCalls {
  openChange: (input: MwOpenChangeInput) => Promise<MwOpenChangeResult>
  updateChange: (input: { crId: string; title?: string; reason?: string; validationSet?: MwValidationSet }) => Promise<MwChangeRequest>
  validateChange: (input: { crId: string; set?: MwValidationSet }) => Promise<MwChangeValidation>
  signChange: (input: { crId: string; password: string }) => Promise<MwChangeSignResult>
  withdrawChange: (input: { crId: string; reason?: string }) => Promise<MwChangeRequest>
  changeChat: (input: { crId: string }) => Promise<{ sessionId: string }>
  exportAuditLog: (query: MwAuditQuery) => Promise<MwAuditExport>
  verifyAuditLog: (input: { project: string } | { exportJson: string }) => Promise<MwAuditVerifyResult>
  createInspectorLink: (input: MwInspectorLinkInput) => Promise<MwInspectorLinkCreated>
  revokeInspectorLink: (input: { linkId: string }) => Promise<MwInspectorLink>
  extendInspectorLink: (input: { linkId: string; expiresAt: string }) => Promise<MwInspectorLink>
  answerInspectorQuestion: (input: { questionId: string; answer: string }) => Promise<MwInspectorQuestion>
}

export function useMemwiseRegulatedCalls(): MemwiseRegulatedCalls {
  const store = useStore()
  return useMemo(() => {
    const need = <K extends keyof MemwiseApi>(method: K) => {
      const ws = store.get(memwiseWorkspaceIdAtom)
      const api = getMemwiseApi()
      if (!ws || !api || typeof api[method] !== 'function') throw new Error(i18n.t('memwise.notAvailable'))
      return { ws, api }
    }
    return {
      openChange: async input => { const { ws, api } = need('memwiseOpenChangeRequest'); return api.memwiseOpenChangeRequest(ws, input) },
      updateChange: async input => { const { ws, api } = need('memwiseUpdateChangeRequest'); return api.memwiseUpdateChangeRequest(ws, input) },
      validateChange: async input => { const { ws, api } = need('memwiseValidateChangeRequest'); return api.memwiseValidateChangeRequest(ws, input) },
      signChange: async input => { const { ws, api } = need('memwiseSignChangeRequest'); return api.memwiseSignChangeRequest(ws, input) },
      withdrawChange: async input => { const { ws, api } = need('memwiseWithdrawChangeRequest'); return api.memwiseWithdrawChangeRequest(ws, input) },
      changeChat: async input => { const { ws, api } = need('memwiseOpenChangeChat'); return api.memwiseOpenChangeChat(ws, input) },
      exportAuditLog: async query => { const { ws, api } = need('memwiseExportAuditLog'); return api.memwiseExportAuditLog(ws, query) },
      verifyAuditLog: async input => { const { ws, api } = need('memwiseVerifyAuditLog'); return api.memwiseVerifyAuditLog(ws, input) },
      createInspectorLink: async input => { const { ws, api } = need('memwiseCreateInspectorLink'); return api.memwiseCreateInspectorLink(ws, input) },
      revokeInspectorLink: async input => { const { ws, api } = need('memwiseRevokeInspectorLink'); return api.memwiseRevokeInspectorLink(ws, input) },
      extendInspectorLink: async input => { const { ws, api } = need('memwiseExtendInspectorLink'); return api.memwiseExtendInspectorLink(ws, input) },
      answerInspectorQuestion: async input => { const { ws, api } = need('memwiseAnswerInspectorQuestion'); return api.memwiseAnswerInspectorQuestion(ws, input) },
    }
  }, [store])
}
