/**
 * Stage 4 of the project shell (docs/memwise/26-projects-and-pages.md §2, §5): a draft's test run
 * on one record, and the filter a list's chat put on the list.
 */

import { useCallback } from 'react'
import { useAtomValue } from 'jotai'
import i18n from 'i18next'
import type { MwRecordsChatFilter, MwTestRunDraftResult } from '@memwise/shared/protocol'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseQuery, type MemwiseQuery } from './useMemwise'

/** The filter the list's chat put on it (null when none); refetched when the list's records change. */
export function useMemwiseRecordsChatFilter(entity: string | null): MemwiseQuery<MwRecordsChatFilter | null> {
  return useMemwiseQuery<MwRecordsChatFilter | null>(
    entity ? `chat-filter:${entity}` : null,
    async (api, ws) => (typeof api.memwiseGetRecordsChatFilter === 'function' ? api.memwiseGetRecordsChatFilter(ws, { entity: entity! }) : null),
    c => c.kind === 'status' || (c.kind === 'records' && !c.id && (!c.entity || c.entity === entity)),
  )
}

export interface MemwiseShellCalls {
  testRunDraft: (draftId: string, record: { entity: string; id: string }) => Promise<MwTestRunDraftResult>
  clearChatFilter: (entity: string) => Promise<boolean>
}

export function useMemwiseShellCalls(): MemwiseShellCalls {
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const testRunDraft = useCallback(async (draftId: string, record: { entity: string; id: string }): Promise<MwTestRunDraftResult> => {
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseTestRunDraft !== 'function') return { applied: false, message: i18n.t('memwise.notAvailable') }
    return api.memwiseTestRunDraft(workspaceId, { draftId, record })
  }, [workspaceId])
  const clearChatFilter = useCallback(async (entity: string): Promise<boolean> => {
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseClearRecordsChatFilter !== 'function') return false
    return (await api.memwiseClearRecordsChatFilter(workspaceId, { entity })).applied
  }, [workspaceId])
  return { testRunDraft, clearChatFilter }
}
