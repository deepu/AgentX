/**
 * The Stage 5 inbox items (docs/memwise/26-projects-and-pages.md §8): a change request waiting for
 * a sign-off (the person who raised it sends it to QA; QA approves it), and an inspector's question
 * to the study team. Neither has a case.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FileCheck2 } from 'lucide-react'
import type { MwInboxItem } from '@memwise/shared/protocol'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { absoluteDate } from '../format'
import { QuestionCard } from './InspectorSetupView'
import { changeStatusLabel } from './regulated-model'

export function ChangeRequestBody({ item, openChangeRequest }: {
  item: Extract<MwInboxItem, { kind: 'change-request' }>
  openChangeRequest?: (project: string, crId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const cr = item.changeRequest
  const v = cr.validation
  return (
    <div className="space-y-4" data-change-request-item={cr.label} data-signoff={item.signoff}>
      <Info_Section title={`${cr.label} · ${cr.title}`}>
        <dl className="divide-y divide-separator text-label">
          <div className="flex gap-2 px-3.5 py-2"><dt className="w-36 shrink-0 text-secondary">{t('memwise.regulated.inbox.playbook')}</dt><dd className="text-foreground">{cr.playbookTitle}</dd></div>
          <div className="flex gap-2 px-3.5 py-2">
            <dt className="w-36 shrink-0 text-secondary">{t('memwise.regulated.inbox.raised')}</dt>
            <dd className="text-foreground">{`${cr.raisedBy.name} · ${absoluteDate(cr.raisedAt, i18n.language)}`}</dd>
          </div>
          <div className="flex gap-2 px-3.5 py-2">
            <dt className="w-36 shrink-0 text-secondary">{t('memwise.regulated.change.validation.title')}</dt>
            <dd className={cn(v?.status === 'passed' && v.current ? 'text-success' : 'text-info')} data-validation-summary>
              {v
                ? t('memwise.regulated.inbox.validation', { passed: v.passed, total: v.total }) + (v.current ? '' : ` · ${t('memwise.regulated.change.validation.earlierDraft')}`)
                : t('memwise.regulated.change.validation.none')}
            </dd>
          </div>
          <div className="flex gap-2 px-3.5 py-2"><dt className="w-36 shrink-0 text-secondary">{t('memwise.regulated.inbox.status')}</dt><dd className="text-foreground">{changeStatusLabel(cr.status, t)}</dd></div>
        </dl>
      </Info_Section>
      <p className="text-label text-secondary">
        {item.signoff === 'qa' ? t('memwise.regulated.inbox.qaHint') : t('memwise.regulated.inbox.raiserHint')}
      </p>
      {openChangeRequest && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => openChangeRequest(cr.project, cr.label)} data-action="open-change-request">
            {item.signoff === 'qa' ? <FileCheck2 /> : <ExternalLink />}
            {t('memwise.regulated.inbox.open')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function InspectorQuestionBody({ item, answer, openRecord, onDone, now }: {
  item: Extract<MwInboxItem, { kind: 'inspector-question' }>
  answer?: (questionId: string, answer: string) => Promise<unknown>
  openRecord?: (entity: string, recordId: string) => void
  onDone?: () => void
  now?: number
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3" data-inspector-question-item={item.question.id}>
      <p className="text-label text-secondary">{t('memwise.regulated.inbox.questionHint', { name: item.stepTitle })}</p>
      <QuestionCard
        q={item.question}
        {...(now !== undefined ? { now } : {})}
        {...(answer ? { answer: async (id: string, text: string) => { await answer(id, text); onDone?.() } } : {})}
        {...(openRecord ? { openRecord } : {})}
      />
    </div>
  )
}
