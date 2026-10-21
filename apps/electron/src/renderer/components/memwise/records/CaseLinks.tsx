/**
 * Phase 6 on the case view (24 §8): the cases this one was started or called by, the cases it
 * started or called, and what a `wait_until` state waits for, with the record's values now.
 */

import { useTranslation } from 'react-i18next'
import { CheckCircle2, Clock, CornerDownRight, CornerLeftUp } from 'lucide-react'
import type { MwCaseLink, MwWaitingCondition } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { caseStatusLabel, humanize } from '../format'
import { formatTypedValue } from './record-model'

const LINK_ORDER: MwCaseLink['kind'][] = ['started_by', 'called_by', 'called', 'started']
const STATUS_COLOR = { active: 'default', done: 'success', stopped: 'destructive' } as const

export function CaseLinksPanel({ links, onOpenCase }: { links?: MwCaseLink[]; onOpenCase?: (caseId: string) => void }) {
  const { t } = useTranslation()
  if (!links?.length) return null
  const sorted = [...links].sort((a, b) => LINK_ORDER.indexOf(a.kind) - LINK_ORDER.indexOf(b.kind))
  return (
    <Info_Section title={t('memwise.case.links.title')} count={links.length} description={t('memwise.case.links.hint')}>
      <ul className="divide-y divide-separator" data-case-links>
        {sorted.map(l => {
          const parent = l.kind === 'started_by' || l.kind === 'called_by'
          const Icon = parent ? CornerLeftUp : CornerDownRight
          return (
            <li key={`${l.kind}:${l.caseId}`} data-case-link={l.kind}>
              <button
                type="button"
                disabled={!onOpenCase}
                onClick={() => onOpenCase?.(l.caseId)}
                className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left enabled:hover:bg-fill-hover transition-[background-color] duration-micro"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-foreground">
                    <span className="text-secondary">{t(`memwise.case.links.${l.kind}`)} </span>
                    <span className="font-medium">{l.title}</span>
                  </span>
                  {l.status === 'active' && <span className="mt-0.5 block text-label-sm text-tertiary">{t('memwise.record.now', { step: l.state })}</span>}
                </span>
                <Info_Badge color={STATUS_COLOR[l.status]} dot>{caseStatusLabel(l.status, t)}</Info_Badge>
              </button>
            </li>
          )
        })}
      </ul>
    </Info_Section>
  )
}

export function WaitingPanel({ waiting, onOpenRecord }: { waiting?: MwWaitingCondition; onOpenRecord?: (entity: string, id: string) => void }) {
  const { t, i18n } = useTranslation()
  if (!waiting) return null
  const values = Object.entries(waiting.values)
  return (
    <Info_Section title={t('memwise.case.waiting.title')} description={t('memwise.case.waiting.hint')}>
      <div className="space-y-2 px-3.5 py-3 text-label" data-waiting={waiting.holds ? 'holds' : 'waits'}>
        <div className="flex flex-wrap items-center gap-2">
          {waiting.holds
            ? <Info_Badge color="success" icon={<CheckCircle2 className="size-3" />}>{t('memwise.case.waiting.holds')}</Info_Badge>
            : <Info_Badge color="default" icon={<Clock className="size-3" />}>{t('memwise.case.waiting.waits')}</Info_Badge>}
          <span className="text-foreground">
            {t('memwise.case.waiting.until')}{' '}
            <code className="rounded bg-fill-hover px-1 py-0.5 text-label-sm">{waiting.condition}</code>
          </span>
        </div>
        <p className="text-secondary">
          {t('memwise.case.waiting.on')}{' '}
          {onOpenRecord
            ? <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onOpenRecord(waiting.record.entity, waiting.record.id)}>{waiting.record.title}</button>
            : <span className="font-medium text-foreground">{waiting.record.title}</span>}
        </p>
        {values.length > 0 && (
          <p className="text-label-sm text-tertiary" data-waiting-values>
            {t('memwise.case.waiting.valuesNow', {
              values: values.map(([k, v]) => `${humanize(k)}: ${formatTypedValue(waiting.types?.[k] ?? '', v, t, i18n.language)}`).join(' · '),
            })}
          </p>
        )}
      </div>
    </Info_Section>
  )
}
