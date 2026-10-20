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
  MwStartCaseRefusal,
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
  startCase: (input: MwStartCaseInput): Promise<MwCaseSummary | MwStartCaseRefusal> => api().memwiseStartCase(activeWorkspaceId(), input),
  getStepRecord: (stepRunId: string): Promise<MwStepRecord> => api().memwiseGetStepRecord(activeWorkspaceId(), stepRunId),
  explainStep: (input: MwExplainInput): Promise<MwExplanation> => api().memwiseExplainStep(activeWorkspaceId(), input),
  listInbox: (): Promise<MwInboxItem[]> => api().memwiseListInbox(activeWorkspaceId()),
  submitStep: (input: MwSubmitStepInput): Promise<MwSubmitResult> => api().memwiseSubmitStep(activeWorkspaceId(), input),
  decideApproval: (input: MwDecideApprovalInput): Promise<MwSubmitResult> =>
    api().memwiseDecideApproval(activeWorkspaceId(), input),
  sendEvent: (input: MwSendEventInput): Promise<MwSubmitResult> => api().memwiseSendEvent(activeWorkspaceId(), input),
  dismissInboxItem: (itemId: string): Promise<MwSubmitResult> => api().memwiseDismissInboxItem(activeWorkspaceId(), itemId),
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
  // Phase 6: domains, records, pages, views, automations, audit (24 §13)
  listDomains: (): Promise<import('@memwise/shared/protocol').MwDomain[]> => api().memwiseListDomains(activeWorkspaceId()),
  getRecordPage: (input: import('@memwise/shared/protocol').MwRecordPageInput): Promise<import('@memwise/shared/protocol').MwRecordPage | null> => api().memwiseGetRecordPage(activeWorkspaceId(), input),
  createRecord: (input: import('@memwise/shared/protocol').MwRecordCreateInput): Promise<import('@memwise/shared/protocol').MwRecordWriteResult> => api().memwiseCreateRecord(activeWorkspaceId(), input),
  updateRecord: (input: import('@memwise/shared/protocol').MwRecordUpdateInput): Promise<import('@memwise/shared/protocol').MwRecordWriteResult> => api().memwiseUpdateRecord(activeWorkspaceId(), input),
  transitionRecord: (input: import('@memwise/shared/protocol').MwRecordTransitionInput): Promise<import('@memwise/shared/protocol').MwRecordWriteResult> => api().memwiseTransitionRecord(activeWorkspaceId(), input),
  queryRecords: (input: import('@memwise/shared/protocol').MwRecordQueryInput): Promise<import('@memwise/shared/protocol').MwRecordQueryResult> => api().memwiseQueryRecords(activeWorkspaceId(), input),
  recordTree: (input: import('@memwise/shared/protocol').MwTreeInput): Promise<import('@memwise/shared/protocol').MwTreeNode[]> => api().memwiseRecordTree(activeWorkspaceId(), input),
  saveNote: (input: import('@memwise/shared/protocol').MwSaveNoteInput): Promise<import('@memwise/shared/protocol').MwRecordWriteResult> => api().memwiseSaveNote(activeWorkspaceId(), input),
  getDashboard: (input: import('@memwise/shared/protocol').MwDashboardInput): Promise<import('@memwise/shared/protocol').MwDashboard> => api().memwiseGetDashboard(activeWorkspaceId(), input),
  listViews: (input: { domain: string; entity?: string }): Promise<import('@memwise/shared/protocol').MwView[]> => api().memwiseListViews(activeWorkspaceId(), input),
  saveView: (input: import('@memwise/shared/protocol').MwSaveViewInput): Promise<import('@memwise/shared/protocol').MwView> => api().memwiseSaveView(activeWorkspaceId(), input),
  listTriggers: (): Promise<import('@memwise/shared/protocol').MwTrigger[]> => api().memwiseListTriggers(activeWorkspaceId()),
  releaseTrigger: (input: import('@memwise/shared/protocol').MwReleaseTriggerInput): Promise<MwSubmitResult & { started?: number }> => api().memwiseReleaseTrigger(activeWorkspaceId(), input),
  getAuditTrail: (input: { entity: string; id: string }): Promise<import('@memwise/shared/protocol').MwAuditTrail | null> => api().memwiseGetAuditTrail(activeWorkspaceId(), input),
  exportAuditTrail: (input: import('@memwise/shared/protocol').MwAuditExportInput): Promise<import('@memwise/shared/protocol').MwAuditExport> => api().memwiseExportAuditTrail(activeWorkspaceId(), input),
  readFile: (fileId: string): Promise<import('@memwise/shared/protocol').MwFileData> => api().memwiseReadFile(activeWorkspaceId(), fileId),
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
