/**
 * A record's page and a step that signs one, in the project shell (doc 26 §2, mocks `Site`,
 * `Document` and `Sign`). The record page is the record's own layout under the shell's header
 * (Records › Sites › Site 104, its facts, Export audit trail when regulated); a document's preview
 * sits beside the review facts. A waiting step that reviews and signs a document is the Sign page:
 * the same record page in review mode, with the signature (meaning, password, Send back / Sign)
 * in the page itself. Any other waiting step is the inbox item's own page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import type { MwInboxItem } from '@memwise/shared/protocol'
import { navigate, routes } from '@/lib/navigate'
import { memwiseDomainsAtom, memwiseInboxAtom } from '@/atoms/memwise'
import { useMemwisePlaybook, useMemwiseRefresh } from '@/hooks/useMemwise'
import { useMemwiseRecordPage } from '@/hooks/useMemwiseRecords'
import { humanize } from '../../format'
import { InboxDetailPage } from '../../MemwisePages'
import { DocumentReviewPage, useRecordActions, useViewerFiles } from '../../records/RecordPages'
import { RecordPageView } from '../../records/RecordPageView'
import { pluralTitle } from '../project-model'
import { useProjectShell } from '../shell-context'
import { stepNumber } from './every-page-model'

function Crumb({ parts }: { parts: { label: React.ReactNode; onClick?: () => void }[] }) {
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="mx-1 text-tertiary">›</span>}
          {p.onClick
            ? <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={p.onClick}>{p.label}</button>
            : <span>{p.label}</span>}
        </React.Fragment>
      ))}
    </>
  )
}

function useEntityPlural(entity: string | undefined): string {
  const domains = useAtomValue(memwiseDomainsAtom)
  if (!entity) return ''
  const type = domains?.flatMap(d => d.entities).find(e => e.key === entity)
  return pluralTitle(type?.title ?? humanize(entity.split('.').pop() ?? entity))
}

export function RecordShellPage({ entity, recordId }: { entity: string; recordId: string }) {
  const { t } = useTranslation()
  const { data: page, error, loaded } = useMemwiseRecordPage(entity, recordId)
  const files = useViewerFiles(page)
  const actions = useRecordActions(page)
  const shell = useProjectShell()
  const plural = useEntityPlural(entity)
  const project = shell?.projectId ?? ''
  if (!page) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-label text-tertiary" data-testid="shell-page">
        {error ?? (loaded ? t('memwise.record.missing') : t('memwise.entities.loading'))}
      </div>
    )
  }
  const crumb = (
    <Crumb
      parts={[
        { label: t('memwise.shell.records') },
        { label: plural, onClick: () => navigate(routes.view.project(project, { type: 'records', entity })) },
        { label: page.title },
      ]}
    />
  )
  return (
    <div className="h-full overflow-y-auto" data-testid="shell-page">
      <RecordPageView key={`${page.entity}:${page.id}`} page={page} actions={actions} files={files} shell={{ crumb }} />
    </div>
  )
}

type ReviewItem = Extract<MwInboxItem, { kind: 'input' | 'decision' }>

/** A waiting step that reviews a document and signs it. */
export function signsDocument(item: MwInboxItem | null | undefined): item is ReviewItem {
  return !!item && (item.kind === 'input' || item.kind === 'decision') && !!item.sign && item.review?.kind === 'document' && !!item.review.recordId
}

/** A waiting step in the shell: the Sign page for a signed document review, else the inbox item's page. */
export function WaitingItemShellPage({ itemId }: { itemId: string }) {
  const inbox = useAtomValue(memwiseInboxAtom)
  const found = inbox?.find(i => i.id === itemId) ?? null
  // Once signed the item leaves the inbox; the page stays on the record as it now is.
  const [kept, setKept] = React.useState<ReviewItem | null>(null)
  React.useEffect(() => { if (signsDocument(found)) setKept(found) }, [found])
  const item = found ?? (kept?.id === itemId ? kept : null)
  if (signsDocument(item)) return <SignShellPage item={item} />
  return <InboxDetailPage itemId={itemId} />
}

function SignShellPage({ item }: { item: ReviewItem }) {
  const { t } = useTranslation()
  const shell = useProjectShell()
  const refresh = useMemwiseRefresh()
  const { data: playbook } = useMemwisePlaybook(item.workflowId)
  const project = shell?.projectId ?? ''
  const state = item.stepRunId.split('/').pop() ?? ''
  const n = stepNumber(playbook, state)
  const crumb = (
    <Crumb
      parts={[
        { label: t('memwise.shell.waiting'), onClick: () => navigate(routes.view.project(project, { type: 'waiting' })) },
        { label: item.stepTitle },
      ]}
    />
  )
  const subtitle = playbook ? (
    <span data-review-from>
      <span className="mr-1.5 text-tertiary">·</span>
      {t('memwise.everyPage.fromPlaybook')}{' '}
      <button type="button" className="text-foreground underline underline-offset-2" onClick={() => navigate(routes.view.project(project, { type: 'playbook', workflowId: playbook.id }))}>{playbook.title}</button>
      {n !== undefined && <>{t('memwise.everyPage.stepSuffix', { n })}</>}
    </span>
  ) : undefined
  return (
    <div className="h-full overflow-y-auto" data-testid="shell-page" data-sign-page>
      <DocumentReviewPage item={item} inlineSignature shell={{ crumb, ...(subtitle ? { subtitle } : {}) }} onDone={() => void refresh()} />
    </div>
  )
}
