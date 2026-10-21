/**
 * The record page containers: a record's page (memwise:records:page, its document's bytes, its
 * writes and audit export), and document review from the inbox (the same page in review mode,
 * submitting the inbox step, with "Review in a row").
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { MwInboxItem, MwRecordPage, MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { navigate, routes } from '@/lib/navigate'
import { memwiseRolesAtom, memwiseStartCaseDialogAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseOpenChat } from '@/hooks/useMemwise'
import { base64ToBytes, downloadBase64, useMemwiseFile, useMemwiseRecordCalls, useMemwiseRecordPage } from '@/hooks/useMemwiseRecords'
import { roleTitle } from '../format'
import type { RecordPageActions } from './RecordBlocks'
import type { ReviewQueue, ReviewSubmit } from './DocumentReview'
import { RecordPageView, type ViewerFile } from './RecordPageView'
import { useProjectShell } from '../project/shell-context'

/** The bytes of the page's first document viewer. */
function useViewerFiles(page: MwRecordPage | null): Record<string, ViewerFile> {
  const viewer = page ? Object.values(page.layout.areas).flat().find(b => b?.kind === 'viewer') : undefined
  const field = viewer?.kind === 'viewer' ? viewer.field : undefined
  const doc = field && page ? page.documents[field] ?? null : null
  const isPdf = !!doc && (doc.mime === 'application/pdf' || /\.pdf$/i.test(doc.name))
  const { data, loading, error } = useMemwiseFile(isPdf ? doc!.id : null)
  const bytes = React.useMemo(() => (data ? base64ToBytes(data.dataBase64) : null), [data])
  return React.useMemo(() => (field ? { [field]: { data: bytes, loading: loading || (isPdf && !data && !error), error } } : {}), [field, bytes, loading, isPdf, data, error])
}

/**
 * "Ask in chat" on a record page (doc 25 §6): opens a chat anchored to the record in a new panel
 * beside the page; the chat can read the record and its related records as this person.
 */
function useOpenRecordChat(entity: string | undefined, id: string | undefined): (() => void) | undefined {
  const { t } = useTranslation()
  const openChat = useMemwiseOpenChat()
  const opening = React.useRef(false)
  // In the project shell the record's chat is already beside its page.
  const shell = useProjectShell()
  return React.useMemo(() => {
    if (!entity || !id || shell) return undefined
    const api = getMemwiseApi()
    if (!api || typeof api.memwiseOpenChat !== 'function') return undefined
    return () => {
      if (opening.current) return
      opening.current = true
      openChat({ kind: 'record', entity, id })
        .then(sessionId => { if (sessionId) navigate(routes.view.allSessions(sessionId), { newPanel: true }) })
        .catch(err => toast.error(t('memwise.step.openChatFailed'), { description: err instanceof Error ? err.message : String(err) }))
        .finally(() => { opening.current = false })
    }
  }, [entity, id, openChat, shell, t])
}

export function useRecordActions(page: MwRecordPage | null): RecordPageActions & { openChat?: () => void } {
  const calls = useMemwiseRecordCalls()
  const setStartCase = useSetAtom(memwiseStartCaseDialogAtom)
  const entity = page?.entity
  const id = page?.id
  const domain = page?.domain
  const openChat = useOpenRecordChat(entity, id)
  return React.useMemo<RecordPageActions & { openChat?: () => void }>(() => {
    if (!entity || !id) return {}
    const api = getMemwiseApi()
    return {
      ...(openChat ? { openChat } : {}),
      openRecord: (e, r) => navigate(routes.view.record(e, r)),
      openCase: caseId => navigate(routes.view.cases(caseId)),
      openView: e => domain && navigate(routes.view.domains({ type: 'entities', domain, entity: e })),
      startPlaybook: workflowId => setStartCase({ open: true, workflowId }),
      ...(api && typeof api.memwiseUpdateRecord === 'function' ? {
        update: (values, reason) => calls.update({ entity, id, values, ...(reason ? { reason } : {}) }),
        transition: (transition, reason) => calls.transition({ entity, id, transition, ...(reason ? { reason } : {}) }),
        saveNote: (body, reason) => calls.saveNote({ entity, id, body, ...(reason ? { reason } : {}) }),
      } : {}),
      ...(api && typeof api.memwiseExportAuditTrail === 'function' ? {
        exportAudit: async format => {
          const file = await calls.exportAudit({ entity, id, format })
          downloadBase64(file.name, file.mime, file.dataBase64)
        },
      } : {}),
    }
  }, [entity, id, domain, calls, setStartCase, openChat])
}

export function RecordPage({ entity, recordId }: { entity: string; recordId: string }) {
  const { t } = useTranslation()
  const { data: page, error, loaded } = useMemwiseRecordPage(entity, recordId)
  const files = useViewerFiles(page)
  const actions = useRecordActions(page)
  return (
    <Info_Page loading={!page && !error && !loaded} error={!page && error ? error : undefined} empty={loaded && !error && !page ? t('memwise.record.missing') : undefined}>
      <Info_Page.Header title={page?.title ?? t('memwise.record.title')} />
      {page && <RecordPageView key={`${page.entity}:${page.id}`} page={page} actions={actions} files={files} />}
    </Info_Page>
  )
}

/**
 * Document review from the inbox: the reviewed record's page in review mode. After the step is
 * submitted the page shows the record as it now is (normal mode), unless the queue moves on.
 */
export function DocumentReviewPage({ item, onDone, queue }: {
  item: Extract<MwInboxItem, { kind: 'input' | 'decision' }>
  onDone?: (result: MwSubmitResult) => void
  queue?: ReviewQueue
}) {
  const { t } = useTranslation()
  const review = item.review?.kind === 'document' ? item.review : undefined
  const [submitted, setSubmitted] = React.useState(false)
  React.useEffect(() => setSubmitted(false), [item.stepRunId])
  const { data: page, error, loaded } = useMemwiseRecordPage(review?.entity ?? null, review?.recordId ?? null, submitted ? null : item.stepRunId)
  const files = useViewerFiles(page)
  const actions = useRecordActions(page)
  const roles = useAtomValue(memwiseRolesAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)

  const submit = React.useCallback(async (input: ReviewSubmit): Promise<MwSubmitResult> => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) return { applied: false, message: t('memwise.notAvailable') }
    return api.memwiseSubmitStep(workspaceId, { stepRunId: item.stepRunId, ...input })
  }, [workspaceId, item.stepRunId, t])

  const done = React.useCallback((r: MwSubmitResult) => {
    toast.success(r.message ?? t('memwise.inbox.doneWith', { title: item.caseTitle }))
    // The page returns to normal mode; in a queue the inbox then moves on to the next item.
    setSubmitted(true)
    onDone?.(r)
  }, [onDone, item.caseTitle, t])

  // Inside the inbox's own page: no second page frame, only its content.
  if (!review?.recordId) return <Message text={t('memwise.review.noRecord')} />
  if (!page) {
    if (error) return <Message text={error} error />
    return <Message text={loaded ? t('memwise.record.missing') : t('memwise.entities.loading')} />
  }
  return (
    <RecordPageView
      key={`${page.entity}:${page.id}:${submitted ? 'page' : item.stepRunId}`}
      page={page}
      actions={actions}
      files={files}
      review={submitted ? undefined : { submit, onDone: done, roleTitle: r => roleTitle(r, roles), queue }}
    />
  )
}

function Message({ text, error }: { text: string; error?: boolean }) {
  return <div className="flex flex-1 items-center justify-center p-6"><p className={error ? 'text-label text-destructive' : 'text-label text-tertiary'}>{text}</p></div>
}
