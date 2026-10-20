/**
 * A thin typed wrapper over window.electronAPI.memwise*: each call fills in the window's active
 * workspace (the same id the pages and sessions APIs take), so remote workspaces reach their own
 * server's kernel. Screens call `memwise.listInbox()` and so on.
 */

import { getDefaultStore } from 'jotai'
import { useEffect, useRef } from 'react'
import type {
  MwCase,
  MwCaseSummary,
  MwChange,
  MwDecideApprovalInput,
  MwDocument,
  MwEntityRow,
  MwEntityType,
  MwExplainInput,
  MwExplanation,
  MwInboxItem,
  MwLiveCounts,
  MwOpenChatInput,
  MwPerson,
  MwPlaybook,
  MwPlaybookSummary,
  MwRole,
  MwRunStatus,
  MwSendEventInput,
  MwStartCaseInput,
  MwStatus,
  MwStepRecord,
  MwSubmitResult,
  MwSubmitStepInput,
  MwUploadInput,
} from '@memwise/shared/protocol'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'

/** The window's active workspace; throws when none is open yet. */
export function activeWorkspaceId(): string {
  const id = getDefaultStore().get(windowWorkspaceIdAtom)
  if (!id) throw new Error('No workspace is open.')
  return id
}

const api = () => window.electronAPI

/** Base64 of a browser File, for memwise.uploadFile. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export const memwise = {
  status: (): Promise<MwStatus> => api().memwiseStatus(activeWorkspaceId()),
  listPeople: (): Promise<MwPerson[]> => api().memwiseListPeople(activeWorkspaceId()),
  actAs: (personId: string): Promise<MwStatus> => api().memwiseActAs(activeWorkspaceId(), personId),
  createPerson: (input: { name: string; email: string; roles: string[] }): Promise<MwPerson> =>
    api().memwiseCreatePerson(activeWorkspaceId(), input),
  listRoles: (): Promise<MwRole[]> => api().memwiseListRoles(activeWorkspaceId()),
  listPlaybooks: (): Promise<MwPlaybookSummary[]> => api().memwiseListPlaybooks(activeWorkspaceId()),
  getPlaybook: (id: string): Promise<MwPlaybook> => api().memwiseGetPlaybook(activeWorkspaceId(), id),
  getLiveCounts: (id: string): Promise<MwLiveCounts> => api().memwiseGetLiveCounts(activeWorkspaceId(), id),
  listCases: (filter: { workflowId?: string; status?: MwRunStatus } = {}): Promise<MwCaseSummary[]> =>
    api().memwiseListCases(activeWorkspaceId(), filter),
  getCase: (caseId: string): Promise<MwCase> => api().memwiseGetCase(activeWorkspaceId(), caseId),
  startCase: (input: MwStartCaseInput): Promise<MwCaseSummary> => api().memwiseStartCase(activeWorkspaceId(), input),
  getStepRecord: (stepRunId: string): Promise<MwStepRecord> => api().memwiseGetStepRecord(activeWorkspaceId(), stepRunId),
  explainStep: (input: MwExplainInput): Promise<MwExplanation> => api().memwiseExplainStep(activeWorkspaceId(), input),
  listInbox: (): Promise<MwInboxItem[]> => api().memwiseListInbox(activeWorkspaceId()),
  submitStep: (input: MwSubmitStepInput): Promise<MwSubmitResult> => api().memwiseSubmitStep(activeWorkspaceId(), input),
  decideApproval: (input: MwDecideApprovalInput): Promise<MwSubmitResult> =>
    api().memwiseDecideApproval(activeWorkspaceId(), input),
  sendEvent: (input: MwSendEventInput): Promise<MwSubmitResult> => api().memwiseSendEvent(activeWorkspaceId(), input),
  listEntities: (entity: string): Promise<MwEntityRow[]> => api().memwiseListEntities(activeWorkspaceId(), entity),
  listEntityTypes: (): Promise<MwEntityType[]> => api().memwiseListEntityTypes(activeWorkspaceId()),
  uploadFile: (input: MwUploadInput): Promise<MwDocument> => api().memwiseUploadFile(activeWorkspaceId(), input),
  /** Uploads a File picked or dropped in the browser. */
  uploadBrowserFile: async (file: File): Promise<MwDocument> =>
    api().memwiseUploadFile(activeWorkspaceId(), {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      data: await fileToBase64(file),
    }),
  openChat: (input: MwOpenChatInput): Promise<{ sessionId: string }> => api().memwiseOpenChat(activeWorkspaceId(), input),
  /** Something the screens show changed; refetch what it names. */
  onChanged: (callback: (change: MwChange) => void): (() => void) => api().onMemwiseChanged(callback),
}

/** Calls `callback` on every `memwise:changed` push while the component is mounted. */
export function useMemwiseChanged(callback: (change: MwChange) => void): void {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => memwise.onChanged((change) => ref.current(change)), [])
}
