/**
 * The case's "Client link" panel (Phase 5): for each external step, the links sent to the client
 * and what happened to them (sent, opened, a draft saved, submitted, expired or revoked), with
 * Copy link, Send again (after seeing the message) and Revoke. Presentational: the case page
 * passes the calls in `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { AlertTriangle, Ban, Copy, Link2, Send, Settings2 } from 'lucide-react'
import type { MwCase, MwExternalLink, MwIssuedLink, MwIssueLinkInput, MwResendInput, MwResendPreview, MwResendResult, MwSubmitResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  canSendAgain,
  clientLinkGroups,
  LINK_STATE_COLOR,
  linkEvents,
  linkState,
  participantFor,
  participantLine,
  resendVia,
  type ClientLinkGroup,
  type LinkEvent,
} from './client-link-model'
import { MessagePreview } from './MessagePreview'
import { absoluteTime, personName, resultMessage, type PeopleById } from './format'

export interface ClientLinkActions {
  issue: (input: MwIssueLinkInput) => Promise<MwIssuedLink>
  previewResend: (input: MwResendInput) => Promise<MwResendPreview | { message: string }>
  resend: (input: MwResendInput) => Promise<MwResendResult>
  revoke: (linkId: string) => Promise<MwSubmitResult>
  /** Put text on the clipboard (default: navigator.clipboard). */
  copy?: (text: string) => Promise<void>
  /** Open Settings → Public address. */
  openSettings?: () => void
  /** After a change, so the case reloads. */
  onChanged?: () => void
}

export interface ClientLinkPanelProps {
  kase: Pick<MwCase, 'links' | 'deliveries' | 'timeline' | 'status' | 'values' | 'runId'>
  actions?: ClientLinkActions
  people?: PeopleById
  now?: number
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ClientLinkPanel({ kase, actions, people = {}, now }: ClientLinkPanelProps) {
  const groups = clientLinkGroups(kase)
  if (groups.length === 0) return null
  return (
    <>
      {groups.map(g => (
        <ClientLinkGroupView key={g.stepId} kase={kase} group={g} actions={actions} people={people} now={now} single={groups.length === 1} />
      ))}
    </>
  )
}

function ClientLinkGroupView({ kase, group, actions, people, now, single }: {
  kase: ClientLinkPanelProps['kase']
  group: ClientLinkGroup
  actions?: ClientLinkActions
  people: PeopleById
  now?: number
  single: boolean
}) {
  const { t } = useTranslation()
  const [issued, setIssued] = React.useState<MwIssuedLink | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [resending, setResending] = React.useState<MwExternalLink | null>(null)
  const [revoking, setRevoking] = React.useState<MwExternalLink | null>(null)
  const [showOlder, setShowOlder] = React.useState(false)
  const [latest, ...older] = group.links

  const copyLink = async () => {
    if (!actions) return
    setBusy('copy')
    try {
      const r = await actions.issue({ runId: kase.runId, stepId: group.stepId, participant: participantFor(kase, group) })
      setIssued(r)
      if (r.url) {
        try {
          await (actions.copy ?? (s => navigator.clipboard.writeText(s)))(r.url)
          toast.success(t('memwise.clientLink.copied'), { description: t('memwise.clientLink.copiedDescription', { until: absoluteTime(r.link.expiresAt) }) })
        } catch {
          toast.message(t('memwise.clientLink.copyYourself'))
        }
      }
      actions.onChanged?.()
    } catch (err) {
      toast.error(t('memwise.clientLink.issueFailed'), { description: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Info_Section
      title={single ? t('memwise.clientLink.title') : t('memwise.clientLink.titleFor', { step: group.title })}
      description={group.waiting && !latest ? t('memwise.clientLink.noLinkYet') : undefined}
      actions={actions && group.waiting ? (
        <Button variant="secondary" size="sm" onClick={() => void copyLink()} disabled={busy !== null} data-action="copy-link">
          <Copy />
          {busy === 'copy' ? t('memwise.clientLink.making') : t('memwise.clientLink.copyLink')}
        </Button>
      ) : undefined}
    >
      <div className="divide-y divide-separator" data-client-links={group.stepId}>
        {issued && <IssuedNotice issued={issued} onSettings={actions?.openSettings} onClose={() => setIssued(null)} />}
        {latest && (
          <LinkRow
            link={latest}
            kase={kase}
            people={people}
            now={now}
            actions={actions}
            onSendAgain={() => setResending(latest)}
            onRevoke={() => setRevoking(latest)}
          />
        )}
        {older.length > 0 && (
          <div className="px-3.5 py-2">
            <button type="button" className="text-label-sm text-secondary hover:text-foreground hover:underline" onClick={() => setShowOlder(s => !s)} aria-expanded={showOlder}>
              {showOlder ? t('memwise.clientLink.hideOlder') : t('memwise.clientLink.showOlder', { count: older.length })}
            </button>
          </div>
        )}
        {showOlder && older.map(l => (
          <LinkRow key={l.id} link={l} kase={kase} people={people} now={now} actions={actions} onSendAgain={() => setResending(l)} onRevoke={() => setRevoking(l)} older />
        ))}
      </div>
      {actions && (
        <>
          <ResendDialog link={resending} actions={actions} onClose={() => setResending(null)} />
          <RevokeDialog link={revoking} actions={actions} onClose={() => setRevoking(null)} />
        </>
      )}
    </Info_Section>
  )
}

/** A link staff just made: its address to copy, or why there is none (no public address). */
function IssuedNotice({ issued, onSettings, onClose }: { issued: MwIssuedLink; onSettings?: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  if (!issued.url) {
    return (
      <div className="p-3">
        <Info_Alert variant="warning" inline icon={<AlertTriangle />} data-no-public-address>
          <Info_Alert.Title>{t('memwise.clientLink.noAddressTitle')}</Info_Alert.Title>
          <Info_Alert.Description>{issued.message ?? t('memwise.clientLink.noAddressDescription')}</Info_Alert.Description>
          {onSettings && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={onSettings} data-action="open-public-address">
              <Settings2 />
              {t('memwise.clientLink.openSettings')}
            </Button>
          )}
        </Info_Alert>
      </div>
    )
  }
  return (
    <div className="space-y-1.5 px-3.5 py-3" data-issued-link>
      <p className="text-label-sm text-secondary">{t('memwise.clientLink.issuedHint')}</p>
      <div className="flex gap-2">
        <Input readOnly value={issued.url} className="font-mono text-label-sm" onFocus={e => e.currentTarget.select()} aria-label={t('memwise.clientLink.linkAddress')} />
        <Button variant="ghost" size="md" onClick={onClose}>{t('memwise.clientLink.done')}</Button>
      </div>
    </div>
  )
}

function eventText(e: LinkEvent, t: TFunction, people: PeopleById, locale?: string): string {
  const params: Record<string, string | number> = { ...(e.params ?? {}) }
  if (typeof params.channel === 'string') params.channel = t(params.channel)
  if (typeof params.by === 'string') params.by = personName(params.by, people) ?? params.by
  if (typeof params.until === 'string') params.until = absoluteTime(params.until, locale)
  if (e.key === 'memwise.clientLink.event.copied' && !params.by) return t('memwise.clientLink.event.copiedNoOne')
  if (e.key === 'memwise.clientLink.event.failed' && !params.error) return t('memwise.clientLink.event.failedNoReason', params)
  return t(e.key, params)
}

const TONE_CLASS: Record<NonNullable<LinkEvent['tone']>, string> = {
  default: 'text-secondary',
  success: 'text-success',
  warning: 'text-info',
  destructive: 'text-destructive',
}

function LinkRow({ link, kase, people, now, actions, onSendAgain, onRevoke, older }: {
  link: MwExternalLink
  kase: ClientLinkPanelProps['kase']
  people: PeopleById
  now?: number
  actions?: ClientLinkActions
  onSendAgain: () => void
  onRevoke: () => void
  older?: boolean
}) {
  const { t, i18n } = useTranslation()
  const state = linkState(link, now)
  const events = linkEvents(link, kase.deliveries ?? [], now)
  const who = participantLine(link.participant)
  return (
    <div className={cn('space-y-2 px-3.5 py-3', older && 'bg-fill-hover/40')} data-link={link.id} data-link-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <Link2 className="size-4 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-foreground">{who || t('memwise.clientLink.noParticipant')}</span>
        <Info_Badge color={LINK_STATE_COLOR[state]} dot>{t(`memwise.clientLink.state.${state}`)}</Info_Badge>
      </div>
      <ol className="space-y-0.5 pl-6">
        {events.map((e, i) => (
          <li key={i} className={cn('flex flex-wrap gap-x-2 text-label-sm', TONE_CLASS[e.tone ?? 'default'])} data-event={e.key.split('.').pop()}>
            <span className="[overflow-wrap:anywhere]">{eventText(e, t, people, i18n.language)}</span>
            {e.at && <span className="text-tertiary tabular-nums">{absoluteTime(e.at, i18n.language)}</span>}
          </li>
        ))}
      </ol>
      {actions && state === 'open' && (
        <div className="flex flex-wrap gap-2 pl-6">
          {canSendAgain(link, now) && (
            <Button variant="secondary" size="sm" onClick={onSendAgain} data-action="send-again">
              <Send />
              {t('memwise.clientLink.sendAgain')}
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={onRevoke} data-action="revoke">
            <Ban />
            {t('memwise.clientLink.revoke')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** "Send again": the exact message first, then a confirming click (recorded as the person's approval). */
function ResendDialog({ link, actions, onClose }: { link: MwExternalLink | null; actions: ClientLinkActions; onClose: () => void }) {
  const { t } = useTranslation()
  const [preview, setPreview] = React.useState<MwResendPreview | null>(null)
  const [problem, setProblem] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const via = link ? resendVia(link) : undefined

  React.useEffect(() => {
    setPreview(null)
    setProblem(null)
    if (!link) return
    let stale = false
    actions.previewResend({ linkId: link.id, ...(via && via !== link.via ? { via } : {}) })
      .then(p => { if (!stale) { if ('body' in p) setPreview(p); else setProblem(p.message) } })
      .catch(err => { if (!stale) setProblem(errorText(err)) })
    return () => { stale = true }
  }, [link, via, actions])

  const send = async () => {
    if (!link) return
    setSending(true)
    try {
      const r = await actions.resend({ linkId: link.id, ...(via && via !== link.via ? { via } : {}) })
      if (r.applied) {
        toast.success(t('memwise.clientLink.sentAgain', { to: preview?.to ?? participantLine(link.participant) }))
        actions.onChanged?.()
        onClose()
      } else {
        setProblem(resultMessage(r, t) ?? t('memwise.inbox.notApplied'))
      }
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={!!link} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('memwise.clientLink.sendAgainTitle')}</DialogTitle>
          <DialogDescription>{t('memwise.clientLink.sendAgainDescription')}</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="overflow-hidden rounded-md border border-separator" data-resend-preview>
            <MessagePreview channel={preview.via} to={preview.to} subject={preview.subject} body={preview.body} />
          </div>
        )}
        {!preview && !problem && <p className="text-label text-tertiary">{t('memwise.clientLink.loadingPreview')}</p>}
        {problem && (
          <Info_Alert variant="error" inline icon={<AlertTriangle />}>
            <Info_Alert.Title>{t('memwise.clientLink.cantSend')}</Info_Alert.Title>
            <Info_Alert.Description>{problem}</Info_Alert.Description>
          </Info_Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" variant="primary" disabled={!preview || sending} onClick={() => void send()} data-action="confirm-send">
            <Send />
            {sending ? t('memwise.inbox.sending') : t('memwise.clientLink.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RevokeDialog({ link, actions, onClose }: { link: MwExternalLink | null; actions: ClientLinkActions; onClose: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState<string | null>(null)
  React.useEffect(() => setProblem(null), [link])
  const revoke = async () => {
    if (!link) return
    setBusy(true)
    try {
      const r = await actions.revoke(link.id)
      if (r.applied) {
        toast.success(t('memwise.clientLink.revoked'))
        actions.onChanged?.()
        onClose()
      } else {
        setProblem(resultMessage(r, t) ?? t('memwise.inbox.notApplied'))
      }
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!link} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('memwise.clientLink.revokeTitle')}</DialogTitle>
          <DialogDescription>{t('memwise.clientLink.revokeDescription', { name: link?.participant.name ?? t('memwise.clientLink.theClient') })}</DialogDescription>
        </DialogHeader>
        {problem && (
          <Info_Alert variant="error" inline icon={<AlertTriangle />}>
            <Info_Alert.Description>{problem}</Info_Alert.Description>
          </Info_Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" variant="danger-solid" disabled={busy} onClick={() => void revoke()} data-action="confirm-revoke">
            {busy ? t('memwise.inbox.sending') : t('memwise.clientLink.revoke')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
