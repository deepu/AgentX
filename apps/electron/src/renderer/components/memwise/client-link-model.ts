/**
 * The case's "Client link" panel in words (Phase 5, docs/memwise/23-phase-5-interfaces.md §3, §11):
 * which external steps have links, where each link stands, and what happened to it, as i18n keys
 * with their parameters. Pure, so bun tests run it as it is.
 */

import type { MwCase, MwDelivery, MwExternalLink, MwExternalParticipant, MwStepRunSummary } from '@memwise/shared/protocol'

export type LinkState = 'open' | 'used' | 'closed' | 'expired' | 'revoked'

/** Where a link stands now: an open link past its time has expired, whatever the record says yet. */
export function linkState(link: Pick<MwExternalLink, 'status' | 'expiresAt'>, now: number = Date.now()): LinkState {
  if (link.status === 'open' && Date.parse(link.expiresAt) <= now) return 'expired'
  return link.status
}

export const LINK_STATE_COLOR = {
  open: 'default',
  used: 'success',
  closed: 'muted',
  expired: 'warning',
  revoked: 'destructive',
} as const

export interface LinkEvent {
  /** i18n key under memwise.clientLink.event. */
  key: string
  params?: Record<string, string | number>
  /** When it happened (the screen formats it). */
  at?: string
  tone?: 'default' | 'success' | 'warning' | 'destructive'
}

const channelKey = (via: MwDelivery['channel']) => (via === 'whatsapp' ? 'memwise.clientLink.byWhatsapp' : 'memwise.clientLink.byEmail')

/** Who a link is for, in one line: "Asha Rao · asha@raotraders.example". */
export function participantLine(p: MwExternalParticipant): string {
  return [p.name, p.email ?? p.phone].filter(Boolean).join(' · ')
}

/**
 * What happened to a link, oldest first: made or sent (and how each message went), opened, a
 * draft saved, submitted, closed. Deliveries are matched on the link id.
 */
export function linkEvents(link: MwExternalLink, deliveries: MwDelivery[] = [], now: number = Date.now()): LinkEvent[] {
  const events: LinkEvent[] = []
  const mine = deliveries.filter(d => d.linkId === link.id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  if (link.via === 'copy' || (!link.via && mine.length === 0)) {
    events.push({ key: 'memwise.clientLink.event.copied', at: link.createdAt, params: link.createdBy ? { by: link.createdBy } : undefined })
  } else if (mine.length === 0 && link.via) {
    events.push({ key: 'memwise.clientLink.event.sent', at: link.sentAt ?? link.createdAt, params: { channel: channelKey(link.via), to: participantLine(link.participant) } })
  }
  for (const [i, d] of mine.entries()) {
    const again = i > 0 || d.purpose === 'reminder'
    if (d.status === 'failed') {
      events.push({ key: 'memwise.clientLink.event.failed', at: d.at, params: { channel: channelKey(d.channel), to: d.to, error: d.error ?? '' }, tone: 'destructive' })
      continue
    }
    if (d.status === 'pending') {
      events.push({ key: 'memwise.clientLink.event.sending', at: d.at, params: { channel: channelKey(d.channel), to: d.to } })
      continue
    }
    events.push({ key: again ? 'memwise.clientLink.event.sentAgain' : 'memwise.clientLink.event.sent', at: d.at, params: { channel: channelKey(d.channel), to: d.to } })
    if (d.status === 'delivered') events.push({ key: 'memwise.clientLink.event.delivered', params: { channel: channelKey(d.channel) } })
    if (d.status === 'read') events.push({ key: 'memwise.clientLink.event.read', params: { channel: channelKey(d.channel) } })
  }
  if (link.note) events.push({ key: 'memwise.clientLink.event.note', params: { note: link.note } })
  if (link.firstOpenedAt) {
    events.push({ key: 'memwise.clientLink.event.opened', at: link.firstOpenedAt })
    if (link.lastOpenedAt && link.lastOpenedAt !== link.firstOpenedAt) events.push({ key: 'memwise.clientLink.event.lastOpened', at: link.lastOpenedAt })
  } else if (linkState(link, now) === 'open') {
    events.push({ key: 'memwise.clientLink.event.notOpened' })
  }
  if (link.draftSavedAt) events.push({ key: 'memwise.clientLink.event.draftSaved', at: link.draftSavedAt })

  switch (linkState(link, now)) {
    case 'used':
      events.push({ key: 'memwise.clientLink.event.submitted', at: link.usedAt ?? link.closedAt, tone: 'success' })
      break
    case 'revoked':
      events.push({ key: 'memwise.clientLink.event.revoked', at: link.closedAt, tone: 'destructive' })
      break
    case 'expired':
      events.push({ key: 'memwise.clientLink.event.expired', at: link.closedAt ?? link.expiresAt, tone: 'warning' })
      break
    case 'closed':
      events.push({ key: link.closedReason === 'answered' ? 'memwise.clientLink.event.answered' : 'memwise.clientLink.event.closed', at: link.closedAt })
      break
    case 'open':
      events.push({ key: 'memwise.clientLink.event.worksUntil', params: { until: link.expiresAt } })
      break
  }
  return events
}

export interface ClientLinkGroup {
  stepId: string
  title: string
  /** The step is waiting now (a link can be made for it). */
  waiting?: MwStepRunSummary
  /** Newest first. */
  links: MwExternalLink[]
}

/**
 * The external steps to show: each step with step links on the case, and the external step the
 * case waits at now (even with no link yet), in timeline order.
 */
export function clientLinkGroups(kase: Pick<MwCase, 'links' | 'timeline' | 'status'>): ClientLinkGroup[] {
  const stepLinks = (kase.links ?? []).filter(l => l.kind === 'step' && l.stepId)
  const waitingRuns = kase.status === 'active' ? kase.timeline.filter(s => s.performer === 'external' && s.status === 'waiting') : []
  const ids: string[] = []
  for (const s of kase.timeline) if (s.performer === 'external' && !ids.includes(s.stepId)) ids.push(s.stepId)
  for (const l of stepLinks) if (!ids.includes(l.stepId!)) ids.push(l.stepId!)
  return ids
    .map(stepId => {
      const runs = kase.timeline.filter(s => s.stepId === stepId)
      const links = stepLinks.filter(l => l.stepId === stepId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      return {
        stepId,
        title: runs[runs.length - 1]?.title ?? stepId,
        waiting: waitingRuns.filter(s => s.stepId === stepId).pop(),
        links,
      }
    })
    .filter(g => g.links.length > 0 || g.waiting)
}

/** The link the case waits on now: the newest open one of a waiting external step. */
export function openClientLink(kase: Pick<MwCase, 'links' | 'timeline' | 'status'>, now: number = Date.now()): MwExternalLink | undefined {
  for (const g of clientLinkGroups(kase)) {
    if (!g.waiting) continue
    const open = g.links.find(l => linkState(l, now) === 'open')
    if (open) return open
  }
  return undefined
}

const asText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * Who a new link is for: the person the newest link was for, else the client's name and contact
 * from the case's values (`client_name`, `client_email`, `client_phone`).
 */
export function participantFor(kase: Pick<MwCase, 'values'>, group: Pick<ClientLinkGroup, 'links'>): MwExternalParticipant {
  const last = group.links[0]?.participant
  if (last && (last.name || last.email || last.phone)) return last
  const v = (name: string) => asText(kase.values[name]?.hidden ? undefined : kase.values[name]?.value)
  const out: MwExternalParticipant = {}
  const name = v('client_name') ?? v('name')
  const email = v('client_email') ?? v('email')
  const phone = v('client_phone') ?? v('phone')
  if (name) out.name = name
  if (email) out.email = email
  if (phone) out.phone = phone
  return out
}

/**
 * The channel "Send again" uses: the one the link went out by, else (a copied link) email when
 * the client has an address, else WhatsApp when they have a number.
 */
export function resendVia(link: MwExternalLink): MwDelivery['channel'] | undefined {
  if (link.via === 'email' || link.via === 'whatsapp') return link.via
  if (link.participant.email) return 'email'
  if (link.participant.phone) return 'whatsapp'
  return undefined
}

/** Send again is offered for an open link there is a way to send. */
export function canSendAgain(link: MwExternalLink, now: number = Date.now()): boolean {
  return linkState(link, now) === 'open' && resendVia(link) !== undefined
}
