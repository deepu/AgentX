/**
 * Automations (24 §7, §14): every playbook trigger, in plain words. For each: the playbook, what
 * starts it, when it last fired, when it is next due (and for which record), and the firings the
 * storm guard is holding, to start or discard. Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CalendarClock, Clock, Mail, PlusCircle, Repeat, Workflow, Zap } from 'lucide-react'
import type { MwDomain, MwSubmitResult, MwTrigger, MwTriggerKind } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { absoluteTime, relativeTime, resultMessage } from '../format'

const KIND_ICON: Record<MwTriggerKind, React.ReactNode> = {
  entered: <Workflow className="size-4" />,
  created: <PlusCircle className="size-4" />,
  changed: <Zap className="size-4" />,
  date: <CalendarClock className="size-4" />,
  every: <Repeat className="size-4" />,
  message: <Mail className="size-4" />,
}

export interface AutomationsViewProps {
  triggers: MwTrigger[]
  domains?: MwDomain[] | null
  /** Only this domain's triggers. */
  domain?: string | null
  onOpenPlaybook?: (workflowId: string) => void
  onOpenRecord?: (entity: string, id: string) => void
  /** Start or discard held firings (absent: the buttons are not shown). */
  release?: (trigger: string, decision: 'start' | 'discard') => Promise<MwSubmitResult & { started?: number }>
  now?: number
}

export function AutomationsView({ triggers, domains, domain, onOpenPlaybook, onOpenRecord, release, now }: AutomationsViewProps) {
  const { t } = useTranslation()
  const shown = domain ? triggers.filter(tr => tr.domain === domain) : triggers
  const byDomain = new Map<string, MwTrigger[]>()
  for (const tr of shown) byDomain.set(tr.domain, [...(byDomain.get(tr.domain) ?? []), tr])
  const domainName = (id: string) => domains?.find(d => d.id === id)?.name ?? id
  const held = shown.reduce((n, tr) => n + tr.held, 0)
  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Clock className="size-4" /></div>}
        title={domain ? t('memwise.automations.titleIn', { domain: domainName(domain) }) : t('memwise.automations.title')}
        tagline={t('memwise.automations.description')}
        meta={held > 0 ? <Info_Badge color="warning" dot>{t('memwise.automations.heldTotal', { count: held })}</Info_Badge> : undefined}
      />
      {shown.length === 0 ? (
        <EntityListEmptyScreen icon={<Clock />} title={t('memwise.automations.emptyTitle')} description={t('memwise.automations.emptyDescription')} />
      ) : (
        [...byDomain.entries()].map(([d, list]) => (
          <Info_Section key={d} title={byDomain.size > 1 || !domain ? domainName(d) : t('memwise.automations.triggers')} count={list.length}>
            <ul className="divide-y divide-separator" data-automations={d}>
              {list.map(tr => <TriggerRow key={tr.id} trigger={tr} onOpenPlaybook={onOpenPlaybook} onOpenRecord={onOpenRecord} release={release} now={now} />)}
            </ul>
          </Info_Section>
        ))
      )}
    </Info_Page.Content>
  )
}

function TriggerRow({ trigger: tr, onOpenPlaybook, onOpenRecord, release, now }: {
  trigger: MwTrigger
  onOpenPlaybook?: (workflowId: string) => void
  onOpenRecord?: (entity: string, id: string) => void
  release?: AutomationsViewProps['release']
  now?: number
}) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = React.useState<'start' | 'discard' | null>(null)
  const [result, setResult] = React.useState<(MwSubmitResult & { started?: number }) | null>(null)
  const [decided, setDecided] = React.useState<'start' | 'discard' | null>(null)
  const decide = async (decision: 'start' | 'discard') => {
    if (!release) return
    setBusy(decision)
    setResult(null)
    setDecided(decision)
    try { setResult(await release(tr.id, decision)) } catch (err) { setResult({ applied: false, message: err instanceof Error ? err.message : String(err) }) } finally { setBusy(null) }
  }
  return (
    <li className="px-3.5 py-3" data-trigger={tr.id}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-secondary">{KIND_ICON[tr.kind]}</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2">
            {onOpenPlaybook
              ? <button type="button" className="text-label font-medium text-foreground hover:underline" onClick={() => onOpenPlaybook(tr.workflowId)}>{tr.workflowTitle}</button>
              : <span className="text-label font-medium text-foreground">{tr.workflowTitle}</span>}
            {tr.held > 0 && <Info_Badge color="warning" data-held={tr.held}>{t('memwise.automations.held', { count: tr.held })}</Info_Badge>}
          </div>
          <p className="text-label text-secondary" data-trigger-description>{tr.description}</p>
          <p className="flex flex-wrap gap-x-3 text-label-sm text-tertiary">
            <span title={tr.lastFiredAt ? absoluteTime(tr.lastFiredAt, i18n.language) : undefined}>
              {tr.lastFiredAt ? t('memwise.automations.lastFired', { time: relativeTime(tr.lastFiredAt, now, i18n.language) }) : t('memwise.automations.neverFired')}
            </span>
            {tr.nextDue && (
              <span data-next-due>
                {t('memwise.automations.nextDue', { time: absoluteTime(tr.nextDue.at, i18n.language) })}
                {tr.nextDue.record && (
                  <>
                    {' · '}
                    {onOpenRecord
                      ? <button type="button" className="hover:underline" onClick={() => onOpenRecord(tr.nextDue!.record!.entity, tr.nextDue!.record!.id)}>{tr.nextDue.record.title}</button>
                      : tr.nextDue.record.title}
                  </>
                )}
              </span>
            )}
            <span>{t('memwise.automations.firings', { count: tr.firings })}</span>
          </p>
        </div>
      </div>
      {tr.held > 0 && release && !result?.applied && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-7">
          <p className="min-w-0 flex-1 text-label-sm text-secondary">{t('memwise.automations.heldHint', { count: tr.held })}</p>
          <Button size="sm" variant="secondary" onClick={() => void decide('discard')} disabled={!!busy} data-action="discard">{t('memwise.automations.discard')}</Button>
          <Button size="sm" variant="primary" onClick={() => void decide('start')} disabled={!!busy} data-action="start">{t('memwise.automations.start', { count: tr.held })}</Button>
        </div>
      )}
      {result && (
        <div className="mt-2 pl-7">
          {result.applied ? (
            <p className="text-label-sm text-success" role="status">{decided === 'start' ? t('memwise.automations.started', { count: result.started ?? tr.held }) : t('memwise.automations.discarded', { count: tr.held })}</p>
          ) : (
            <Info_Alert variant="error" inline icon={<AlertTriangle />}><Info_Alert.Title>{resultMessage(result, t) ?? t('memwise.inbox.notApplied')}</Info_Alert.Title></Info_Alert>
          )}
        </div>
      )}
    </li>
  )
}
