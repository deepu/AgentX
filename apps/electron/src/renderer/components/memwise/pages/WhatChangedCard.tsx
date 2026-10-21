/**
 * Home's "What changed this week" (docs/memwise/26-projects-and-pages.md §4; mock LHome): one
 * card per answer change ("GLP-1 › Weight loss: one new finding", "Needs your review", what the
 * page will say, "Found by Monday's refresh · nothing else on the page moved"), and the changes
 * accepted in the last seven days.
 *
 * `WhatChangedCard` is one card, given the change; `WhatChangedThisWeek` lists a project's.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwPageChange, MwPageSummary } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { useMemwisePageChange, useMemwisePages } from '@/hooks/useMemwisePages'
import { foundByShort, pathTitle, shortDate } from './page-model'

export interface WhatChangedCardProps {
  change: MwPageChange
  /** The page's parents' titles ("GLP-1"). */
  parents?: string[]
  onOpen?: () => void
}

/** Whether the change leaves everything but its own sections as they were. */
export function nothingElseMoved(change: MwPageChange): boolean {
  return change.removed.length === 0 && (change.plus !== undefined || change.before === change.after)
}

export function WhatChangedCard({ change, parents = [], onOpen }: WhatChangedCardProps) {
  const { t, i18n } = useTranslation()
  const pending = change.status === 'pending'
  const text = change.plus ?? change.after ?? change.title ?? ''
  const foot = [foundByShort(change.from, t, i18n.language), pending && nothingElseMoved(change) ? t('memwise.pages.whatChanged.nothingElse') : null].filter(Boolean).join(' · ')
  const badge = pending
    ? (change.mayDecide ? t('memwise.pages.whatChanged.needsReview') : t('memwise.pages.whatChanged.waitingReview'))
    : change.status === 'accepted' ? t('memwise.pages.whatChanged.accepted') : null
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag
      {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})}
      className={cn(
        'block w-full rounded-lg border px-4 py-3 text-left',
        pending ? 'border-accent/40 bg-accent-tint/40' : 'border-border',
        onOpen && 'hover:bg-foreground/[0.02]',
      )}
      data-what-changed={change.id}
      data-status={change.status}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-label font-semibold text-foreground">
          {parents.map(p => <React.Fragment key={p}>{p}<span aria-hidden> › </span></React.Fragment>)}
          {change.pageTitle}{change.label ? `: ${change.label}` : ''}
        </span>
        {badge && (
          <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-label-sm', pending && change.mayDecide ? 'bg-info-tint text-info' : 'bg-foreground/[0.06] text-secondary')} data-badge>
            {badge}
          </span>
        )}
      </div>
      {text && <p className="mb-0 mt-1 text-label leading-relaxed text-foreground">{text}</p>}
      <p className="mb-0 mt-1.5 text-label-sm text-secondary">{foot}</p>
    </Tag>
  )
}

/** A change accepted this week, from the page list alone ("Type 2 diabetes: ATTAIN-2 added · Accepted 2 June"). */
function AcceptedCard({ page, parents, onOpen }: { page: MwPageSummary; parents: string[]; onOpen?: () => void }) {
  const { t, i18n } = useTranslation()
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})} className={cn('block w-full rounded-lg border border-border px-4 py-3 text-left', onOpen && 'hover:bg-foreground/[0.02]')} data-what-changed-page={page.id}>
      <span className="text-label font-semibold text-foreground">
        {parents.map(p => <React.Fragment key={p}>{p}<span aria-hidden> › </span></React.Fragment>)}
        {page.title}{page.lastRefresh?.title ? `: ${page.lastRefresh.title}` : ''}
      </span>
      <p className="mb-0 mt-1 text-label text-foreground">{page.headline}</p>
      <p className="mb-0 mt-1.5 text-label-sm text-secondary">{t('memwise.pages.whatChanged.acceptedOn', { when: shortDate(page.lastRefresh!.at, i18n.language) })}</p>
    </Tag>
  )
}

function PendingCard({ page, parents, onOpenChange }: { page: MwPageSummary; parents: string[]; onOpenChange?: (changeId: string) => void }) {
  const change = useMemwisePageChange(page.pendingChange!.id)
  if (!change.data) return null
  return <WhatChangedCard change={change.data} parents={parents} onOpen={onOpenChange ? () => onOpenChange(change.data!.id) : undefined} />
}

/** The pages with a change this week: waiting for review, or accepted in the last seven days. */
export function changedThisWeek(pages: MwPageSummary[], now = new Date()): { pending: MwPageSummary[]; accepted: MwPageSummary[] } {
  const weekAgo = now.getTime() - 7 * 86_400_000
  return {
    pending: pages.filter(p => p.pendingChange),
    accepted: pages.filter(p => !p.pendingChange && p.lastRefresh?.status === 'accepted' && new Date(p.lastRefresh.at).getTime() >= weekAgo),
  }
}

export interface WhatChangedThisWeekProps {
  projectId: string
  onOpenChange?: (changeId: string) => void
  onOpenPage?: (pageId: string) => void
  /** Show the "What changed this week" heading (default true). */
  heading?: boolean
}

/** Renders nothing when no page changed this week. */
export function WhatChangedThisWeek({ projectId, onOpenChange, onOpenPage, heading = true }: WhatChangedThisWeekProps) {
  const { t } = useTranslation()
  const pages = useMemwisePages(projectId)
  const all = pages.data ?? []
  const { pending, accepted } = changedThisWeek(all)
  if (!pending.length && !accepted.length) return null
  return (
    <section className="space-y-2" data-what-changed-this-week>
      {heading && <h2 className="text-label font-semibold text-foreground">{t('memwise.pages.whatChanged.title')}</h2>}
      {pending.map(p => <PendingCard key={p.id} page={p} parents={pathTitle(p, all).parents} onOpenChange={onOpenChange} />)}
      {accepted.map(p => <AcceptedCard key={p.id} page={p} parents={pathTitle(p, all).parents} onOpen={onOpenPage ? () => onOpenPage(p.id) : undefined} />)}
    </section>
  )
}
