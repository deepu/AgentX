/**
 * "Review an answer change" (docs/memwise/26-projects-and-pages.md §4; mock LChange): what the
 * page says now beside what it says after the change ("The same, plus: …"), the sections the
 * refresh added or changed, the ones a chat changed, what it left out and why, and Send back /
 * Accept change. Accepting updates the page for everyone in the project.
 *
 * `PageChangeScreen` fetches the change and mounts in the right column beside the change's chat;
 * `PageChangeView` is the screen itself.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { MwPageChange, MwSubmitResult } from '@memwise/shared/protocol'
import { Markdown, PageBlocksContext, safeHref, type PageBlocksActions } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { useMemwisePageCalls, useMemwisePageChange } from '@/hooks/useMemwisePages'
import { resultMessage } from '../format'
import { dayDate, foundByLabel } from './page-model'

export interface PageChangeScreenProps {
  projectId: string
  changeId: string
  /** Open the page the change is for. */
  onOpenPage?: (pageId: string) => void
  /** After Accept or Send back went through (e.g. back to "Waiting for you"). */
  onDone?: (decision: 'accept' | 'send_back') => void
  /** "Why" beside something left out: ask the change's chat. */
  onAskWhy?: (item: { title: string; why: string }) => void
  onOpenRecord?: (entity: string, id: string) => void
  onUrlClick?: (url: string) => void
}

export function PageChangeScreen({ projectId, changeId, onOpenPage, onDone, onAskWhy, onOpenRecord, onUrlClick }: PageChangeScreenProps) {
  const { t } = useTranslation()
  const change = useMemwisePageChange(changeId)
  const calls = useMemwisePageCalls()
  const [busy, setBusy] = React.useState<'accept' | 'send_back' | null>(null)

  const decide = async (decision: 'accept' | 'send_back', comment?: string) => {
    setBusy(decision)
    try {
      const r: MwSubmitResult = await calls.decide({ changeId, decision, ...(comment ? { comment } : {}) })
      if (!r.applied) {
        toast.error(t('memwise.pages.failed'), { description: resultMessage(r, t) })
        return
      }
      toast.success(decision === 'accept' ? t('memwise.pages.change.acceptedToast') : t('memwise.pages.change.sentBackToast'))
      change.reload()
      onDone?.(decision)
    } catch (err) {
      toast.error(t('memwise.pages.failed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  if (!change.data || change.data.projectId !== projectId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-label text-tertiary" data-page-change-loading>
        {change.error ? change.error : change.loaded ? t('memwise.pages.change.missing') : <Loader2 className="size-4 animate-spin" />}
      </div>
    )
  }
  return (
    <PageChangeView
      change={change.data}
      busy={busy}
      actions={{ onOpenPage, onOpenRecord, onUrlClick }}
      onAccept={() => decide('accept')}
      onSendBack={comment => decide('send_back', comment)}
      onAskWhy={onAskWhy}
    />
  )
}

export interface PageChangeViewProps {
  change: MwPageChange
  busy?: 'accept' | 'send_back' | null
  actions?: PageBlocksActions
  onAccept?: () => void
  onSendBack?: (comment?: string) => void
  onAskWhy?: (item: { title: string; why: string }) => void
}

export function PageChangeView({ change, busy, actions = {}, onAccept, onSendBack, onAskWhy }: PageChangeViewProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const [comment, setComment] = React.useState<string | null>(null)
  const md = (text: string) => <Markdown mode="minimal" onUrlClick={actions.onUrlClick}>{text}</Markdown>
  const pending = change.status === 'pending'
  const canDecide = pending && change.mayDecide && !!onAccept && !!onSendBack

  return (
    <PageBlocksContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col" data-page-change={change.id} data-status={change.status}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[44rem] px-7 pb-8 pt-5">
            <nav className="mb-2 text-label-sm text-secondary" data-breadcrumb>
              {t('memwise.pages.change.breadcrumbRoot')}<span aria-hidden> › </span>{t('memwise.pages.change.title')}
            </nav>
            <h1 className="text-[1.6rem] font-semibold leading-tight text-foreground">{t('memwise.pages.change.title')}</h1>
            <p className="mt-1 text-label text-secondary" data-found-by>
              {actions.onOpenPage
                ? <button type="button" className="text-foreground underline underline-offset-2" onClick={() => actions.onOpenPage!(change.pageId)} data-action="open-page">{change.pageTitle}</button>
                : <span className="text-foreground">{change.pageTitle}</span>}
              {' · '}{foundByLabel(change.from, change.at, t, lang)}
            </p>

            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border px-3.5 py-3" data-box="now">
                <div className="mb-1.5 text-label-sm font-medium uppercase tracking-wide text-secondary">{t('memwise.pages.change.saysNow')}</div>
                <div className="text-label leading-relaxed [&_p]:my-0">{change.before ? md(change.before) : <span className="text-tertiary">{t('memwise.pages.change.nothingYet')}</span>}</div>
              </div>
              <div className="rounded-lg border border-accent/40 bg-accent-tint/40 px-3.5 py-3" data-box="after">
                <div className="mb-1.5 text-label-sm font-medium uppercase tracking-wide text-accent">{t('memwise.pages.change.afterChange')}</div>
                <div className="text-label leading-relaxed [&_p]:my-0">
                  {change.plus !== undefined
                    ? (
                        <p className="my-0">
                          {t('memwise.pages.change.samePlus')}{' '}
                          <mark className="rounded-sm bg-accent/15 px-0.5 text-accent" data-plus>{change.plus}</mark>
                        </p>
                      )
                    : change.after ? md(change.after) : <span className="text-tertiary">{t('memwise.pages.change.headlineSame')}</span>}
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-5">
              {change.sections.map((s, i) => (
                <section key={`${s.heading}:${i}`} className="border-l-2 border-accent pl-3.5" data-change-section={s.heading} data-origin={s.origin}>
                  <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-label-lg font-semibold text-foreground">
                    <span>{s.changed === 'added' ? t('memwise.pages.change.newSection', { heading: s.heading }) : s.heading}</span>
                    <span className="text-label-sm font-normal text-accent">
                      {s.origin === 'chat' ? t('memwise.pages.changedFromChat') : t('memwise.pages.change.fromRefresh')}
                    </span>
                  </h2>
                  <div className="text-[14px] leading-relaxed">{s.markdown ? md(s.markdown) : <span className="text-tertiary">{t('memwise.pages.change.sectionEmpty')}</span>}</div>
                </section>
              ))}
              {change.sections.length === 0 && change.plus === undefined && change.before === change.after && (
                <p className="text-label text-tertiary" data-no-sections>{t('memwise.pages.change.noSections')}</p>
              )}
            </div>

            {change.removed.length > 0 && (
              <p className="mt-5 text-label-sm text-secondary" data-removed>
                <span className="font-medium text-foreground">{t('memwise.pages.change.removed')}</span>{' '}{change.removed.join(', ')}
              </p>
            )}

            {change.leftOut.length > 0 && (
              <div className="mt-5 space-y-1 text-label-sm text-secondary" data-left-out>
                {change.leftOut.map((l, i) => { const href = safeHref(l.href); return (
                  <p key={`${l.title}:${i}`} className="my-0">
                    {t('memwise.pages.change.leftOut')}{' '}
                    {href
                      ? <a className="text-foreground underline underline-offset-2" href={href} onClick={e => { if (actions.onUrlClick) { e.preventDefault(); actions.onUrlClick(href) } }}>{l.title}</a>
                      : <span className="text-foreground">{l.title}</span>}
                    {l.why ? `, ${l.why}` : ''}
                    {onAskWhy && (
                      <>
                        {' '}
                        <button type="button" className="text-foreground underline underline-offset-2" onClick={() => onAskWhy(l)} data-action="ask-why">{t('memwise.pages.change.why')}</button>
                      </>
                    )}
                  </p>
                ) })}
              </div>
            )}

            {change.chatNote && <p className="mt-5 text-label-sm text-secondary" data-chat-note>{change.chatNote}</p>}
          </div>
        </div>

        <footer className="shrink-0 border-t border-border px-7 py-3" data-change-footer>
          {canDecide ? (
            comment === null ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                {change.stale
                  ? <span className="text-label-sm text-destructive" data-stale>{t('memwise.pages.change.stale')}</span>
                  : <span className="text-label-sm text-secondary">{t('memwise.pages.change.acceptNote')}</span>}
                <span className="flex items-center gap-2">
                  <button type="button" className="rounded-md border border-border px-3 py-1.5 text-label font-medium text-foreground disabled:opacity-60" disabled={!!busy} onClick={() => setComment('')} data-action="send-back">
                    {t('memwise.pages.change.sendBack')}
                  </button>
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-label font-medium text-background disabled:opacity-60" disabled={!!busy || !!change.stale} onClick={onAccept} data-action="accept-change">
                    {busy === 'accept' && <Loader2 className="size-3.5 animate-spin" />}
                    {t('memwise.pages.change.accept')}
                  </button>
                </span>
              </div>
            ) : (
              <div className="space-y-2" data-send-back-form>
                <label className="block text-label-sm text-secondary" htmlFor={`send-back-${change.id}`}>{t('memwise.pages.change.sendBackWhy')}</label>
                <textarea
                  id={`send-back-${change.id}`}
                  className="min-h-[4rem] w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-label text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder={t('memwise.pages.change.sendBackPlaceholder')}
                />
                <div className="flex justify-end gap-2">
                  <button type="button" className="rounded-md px-3 py-1.5 text-label text-secondary hover:text-foreground" onClick={() => setComment(null)}>{t('memwise.pages.change.cancel')}</button>
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-label font-medium text-background disabled:opacity-60" disabled={!!busy} onClick={() => onSendBack!(comment.trim() || undefined)} data-action="confirm-send-back">
                    {busy === 'send_back' && <Loader2 className="size-3.5 animate-spin" />}
                    {t('memwise.pages.change.sendBack')}
                  </button>
                </div>
              </div>
            )
          ) : (
            <p className={cn('my-0 text-label-sm text-secondary')} data-decided={change.status}>{decidedLine(change, t, lang)}</p>
          )}
        </footer>
      </div>
    </PageBlocksContext.Provider>
  )
}

/** "Accepted by Leah, Mon 1 June", "Sent back by Leah: …", or why this person can't decide it. */
export function decidedLine(change: MwPageChange, t: (k: string, o?: Record<string, unknown>) => string, lang: string): string {
  const when = dayDate(change.at, lang)
  const by = change.reviewedByName
  switch (change.status) {
    case 'accepted': return by ? t('memwise.pages.change.acceptedBy', { name: by, when }) : t('memwise.pages.change.accepted', { when })
    case 'sent_back': {
      const line = by ? t('memwise.pages.change.sentBackBy', { name: by, when }) : t('memwise.pages.change.sentBack', { when })
      return change.comment ? `${line}: ${change.comment}` : line
    }
    case 'nothing_new': return t('memwise.pages.change.nothingNew', { when })
    default: return t('memwise.pages.change.notYours')
  }
}
