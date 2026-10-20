/**
 * The Phase 6 inbox items that have no case: a record's flag (an invariant it broke, 24 §4) and
 * a trigger's held firings (the storm guard, 24 §7).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ExternalLink, Play, Trash2, Zap } from 'lucide-react'
import type { MwInboxItem, MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { absoluteTime, humanize, relativeTime, resultMessage } from '../format'

export function FlagBody({ item, openRecord }: {
  item: Extract<MwInboxItem, { kind: 'flag' }>
  openRecord?: (entity: string, recordId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const { flag } = item
  return (
    <div className="space-y-4" data-flag={flag.id}>
      <Info_Alert variant="warning" icon={<AlertTriangle />}>
        <Info_Alert.Title>{flag.message}</Info_Alert.Title>
        <Info_Alert.Description>
          {t('memwise.inbox.flag.raised', { rule: humanize(flag.invariant), time: absoluteTime(flag.raisedAt, i18n.language) })}
        </Info_Alert.Description>
      </Info_Alert>
      <p className="text-label text-secondary">{t('memwise.inbox.flag.hint')}</p>
      {openRecord && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => openRecord(flag.entity, flag.recordId)} data-action="open-record">
            <ExternalLink />
            {t('memwise.inbox.flag.openRecord')}
          </Button>
        </div>
      )}
    </div>
  )
}

export function TriggerHoldBody({ item, release, openAutomations, now }: {
  item: Extract<MwInboxItem, { kind: 'trigger-hold' }>
  release?: (decision: 'start' | 'discard') => Promise<MwSubmitResult & { started?: number }>
  openAutomations?: () => void
  now: number
}) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = React.useState<'start' | 'discard' | null>(null)
  const [result, setResult] = React.useState<{ decision: 'start' | 'discard'; r: MwSubmitResult & { started?: number } } | null>(null)
  const done = !!result?.r.applied
  const decide = async (decision: 'start' | 'discard') => {
    if (!release) return
    setBusy(decision)
    try {
      setResult({ decision, r: await release(decision) })
    } catch (err) {
      setResult({ decision, r: { applied: false, message: err instanceof Error ? err.message : String(err) } })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-4" data-trigger-hold={item.triggerId}>
      <Info_Section title={t('memwise.inbox.triggerHold.title')}>
        <div className="space-y-2 px-3.5 py-3 text-label">
          <p className="flex items-center gap-2 text-foreground"><Zap className="size-3.5 text-tertiary" />{item.description}</p>
          <p className="text-secondary" data-held={item.held}>
            {t('memwise.inbox.triggerHold.held', { count: item.held, time: relativeTime(item.since, now, i18n.language) })}
          </p>
          <p className="text-label-sm text-tertiary">{t('memwise.automations.heldHint')}</p>
        </div>
      </Info_Section>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {openAutomations && <Button variant="ghost" className="mr-auto" onClick={openAutomations}>{t('memwise.inbox.triggerHold.openAutomations')}</Button>}
        {release && (
          <>
            <Button variant="secondary" onClick={() => void decide('discard')} disabled={!!busy || done} data-action="discard">
              <Trash2 />
              {t('memwise.automations.discard')}
            </Button>
            <Button variant="primary" onClick={() => void decide('start')} disabled={!!busy || done} data-action="start">
              <Play />
              {t('memwise.automations.start', { count: item.held })}
            </Button>
          </>
        )}
      </div>
      {result && (result.r.applied ? (
        <Info_Alert variant="success" inline icon={<CheckCircle2 />}>
          <Info_Alert.Title>
            {result.decision === 'start'
              ? t('memwise.automations.started', { count: result.r.started ?? item.held })
              : t('memwise.automations.discarded', { count: item.held })}
          </Info_Alert.Title>
        </Info_Alert>
      ) : (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.inbox.notApplied')}</Info_Alert.Title>
          {(result.r.code || result.r.message) && <Info_Alert.Description>{resultMessage(result.r, t)}</Info_Alert.Description>}
        </Info_Alert>
      ))}
    </div>
  )
}
