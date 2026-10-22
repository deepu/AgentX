/**
 * One page (docs/memwise/26-projects-and-pages.md §4; mocks LAsk, LBoard, LTopic, Ask, TmfBoard):
 * the breadcrumb, the title, a Draft pill or how it is kept ("Refreshes every Monday", "Sums up
 * its sub-pages"), "Keep this page" with where it goes and how often for a draft, the body with
 * "Changed from chat · Undo", the answer change waiting for review, and the history line.
 *
 * `PageScreen` fetches the page and mounts in the right column beside its chat; `PageView` is
 * the screen itself, given the page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Archive, Loader2, RefreshCw } from 'lucide-react'
import type { MwPage, MwPageSummary, MwPageVersion, MwPageWriteResult } from '@memwise/shared/protocol'
import type { PageBlocksActions } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { useMemwisePage, useMemwisePageCalls, useMemwisePages, useMemwisePageVersions } from '@/hooks/useMemwisePages'
import { PageBody } from './PageBody'
import { dayDate, EVERY_CHOICES, historyText, parentChoices, refreshLabel, shortDate } from './page-model'

export interface PageScreenProps {
  projectId: string
  pageId: string
  /** Open another page (breadcrumb, sub-pages, "What changed this week"). */
  onOpenPage?: (pageId: string) => void
  /** Open a record (a `records` block's row). */
  onOpenRecord?: (entity: string, id: string) => void
  /** Open "Review an answer change". */
  onOpenChange?: (changeId: string) => void
  onUrlClick?: (url: string) => void
}

export function PageScreen({ projectId, pageId, onOpenPage, onOpenRecord, onOpenChange, onUrlClick }: PageScreenProps) {
  const { t } = useTranslation()
  const page = useMemwisePage(pageId)
  const pages = useMemwisePages(projectId)
  const calls = useMemwisePageCalls()
  const [showAll, setShowAll] = React.useState(false)
  const versions = useMemwisePageVersions(showAll ? pageId : null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const run = async (what: string, fn: () => Promise<MwPageWriteResult | { started: boolean; message?: string }>) => {
    setBusy(what)
    try {
      const r = await fn()
      const ok = 'applied' in r ? r.applied : r.started
      if (!ok) toast.error(t('memwise.pages.failed'), { description: r.message })
      else if (what === 'refresh') toast.success(t('memwise.pages.refreshStarted'))
      page.reload()
      pages.reload()
    } catch (err) {
      toast.error(t('memwise.pages.failed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  if (!page.data) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-label text-tertiary" data-page-loading>
        {page.error ? page.error : page.loaded ? t('memwise.pages.missing') : <Loader2 className="size-4 animate-spin" />}
      </div>
    )
  }
  // The page column clips its card, so a long page scrolls here.
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-page-scroll>
      <PageView
        page={page.data}
        pages={pages.data ?? []}
        versions={showAll ? versions.data ?? [] : undefined}
        busy={busy}
        actions={{ onOpenPage, onOpenRecord, onUrlClick }}
        onKeep={(input) => run('keep', () => calls.keep({ pageId, ...input }))}
        onUndo={() => run('undo', () => calls.undo(pageId, page.data!.version))}
        onArchive={() => run('archive', () => calls.archive(pageId))}
        onRefresh={() => run('refresh', () => calls.refresh(pageId))}
        onOpenChange={onOpenChange}
        onShowAll={() => setShowAll(v => !v)}
      />
    </div>
  )
}

export interface PageViewProps {
  page: MwPage
  /** The project's pages (where a draft may go). */
  pages: MwPageSummary[]
  /** All versions, once "All changes" is open. */
  versions?: MwPageVersion[]
  busy?: string | null
  actions?: PageBlocksActions
  onKeep?: (input: { every: string; parent: string | null }) => void
  onUndo?: () => void
  onArchive?: () => void
  onRefresh?: () => void
  onOpenChange?: (changeId: string) => void
  onShowAll?: () => void
}

export function PageView({ page, pages, versions, busy, actions = {}, onKeep, onUndo, onArchive, onRefresh, onOpenChange, onShowAll }: PageViewProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const kids = page.children
  const keptKids = kids.filter(k => k.status === 'kept').length
  const subtitle = page.status === 'draft'
    ? (page.question ? t('memwise.pages.builtForQuestion') : t('memwise.pages.draftSubtitle'))
    : page.sumsChildren && kids.length
      ? t('memwise.pages.subpagesKept', { count: kids.length, kept: keptKids })
      : page.question ?? ''
  const last = page.history.find(h => h.kind === 'accepted' || h.kind === 'nothing_new' || h.kind === 'sent_back')
  const lastLine = page.refresh?.last || last
    ? [
        page.sumsChildren ? t('memwise.pages.afterEachRefresh') : null,
        last ? t(page.sumsChildren ? 'memwise.pages.lastShort' : 'memwise.pages.last', { when: dayDate(last.at, lang) }) + (last.kind === 'accepted' && last.byName ? ` · ${t('memwise.pages.acceptedBy', { name: last.byName })}` : '') : null,
      ].filter(Boolean).join(' · ')
    : ''
  return (
    <div className="mx-auto w-full max-w-[44rem] px-7 pb-10 pt-5" data-page={page.id} data-status={page.status}>
      <nav className="mb-2 text-label-sm text-secondary" aria-label={t('memwise.pages.breadcrumb')} data-breadcrumb>
        <span>{t('memwise.pages.breadcrumbRoot')}</span>
        {page.breadcrumb.map(b => (
          <React.Fragment key={b.id}>
            <span aria-hidden> › </span>
            {actions.onOpenPage ? <button type="button" className="hover:underline" onClick={() => actions.onOpenPage!(b.id)}>{b.title}</button> : <span>{b.title}</span>}
          </React.Fragment>
        ))}
        <span aria-hidden> › </span>
        <span>{page.title}</span>
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[1.6rem] font-semibold leading-tight text-foreground">{page.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-secondary">
            {page.status === 'draft' && <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-label-sm font-medium text-foreground" data-pill="draft">{t('memwise.pages.draftPill')}</span>}
            {page.status === 'archived' && <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-label-sm font-medium text-foreground" data-pill="archived">{t('memwise.pages.archivedPill')}</span>}
            {subtitle && <span>{subtitle}</span>}
          </p>
        </div>
        <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-1">
          {page.status === 'draft' && onKeep && <KeepControls page={page} pages={pages} busy={busy === 'keep'} onKeep={onKeep} />}
          {page.status === 'kept' && (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-tint px-2.5 py-1 text-label font-medium text-accent" data-pill="kept">
                <RefreshCw className="size-3.5" aria-hidden />
                {page.sumsChildren ? t('memwise.pages.sumsSubpages') : page.refreshEnded ? t('memwise.pages.refreshEnded') : refreshLabel(page.refresh?.every, t, lang)}
              </span>
              {lastLine && <span className="text-label-sm text-secondary" data-last-refresh>{lastLine}</span>}
              <span className="flex items-center gap-2 text-label-sm">
                {onRefresh && (
                  <button type="button" className="text-secondary hover:text-foreground hover:underline disabled:opacity-50" disabled={busy === 'refresh'} onClick={onRefresh} data-action="refresh-now">
                    {t('memwise.pages.refreshNow')}
                  </button>
                )}
                {onArchive && (
                  <button type="button" className="inline-flex items-center gap-1 text-secondary hover:text-foreground hover:underline" onClick={onArchive} data-action="archive">
                    <Archive className="size-3" aria-hidden />{t('memwise.pages.archive')}
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      {page.pendingChange && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-accent/40 bg-accent-tint/40 px-3.5 py-2.5 text-label" data-pending-change={page.pendingChange.id}>
          <span>
            <span className="font-medium">{t('memwise.pages.changeWaiting')}</span>
            {page.pendingChange.label && <span className="text-secondary"> · {page.pendingChange.label}</span>}
          </span>
          {onOpenChange && (
            <button type="button" className="rounded-md bg-foreground px-2.5 py-1 text-label-sm font-medium text-background" onClick={() => onOpenChange(page.pendingChange!.id)} data-action="review-change">
              {t('memwise.pages.review')}
            </button>
          )}
        </div>
      )}

      {page.regulated && page.status === 'kept' && (
        <p className="mt-3 text-label-sm text-secondary" data-regulated>{t('memwise.pages.regulatedNote')}</p>
      )}

      <PageBody
        className="mt-5"
        body={page.body}
        changedFromChat={page.changedFromChat?.sections}
        onUndo={page.canUndo && page.changedFromChat ? onUndo : undefined}
        actions={actions}
      />
      {!page.body.trim() && <p className="mt-5 text-label text-tertiary" data-empty-body>{t('memwise.pages.emptyBody')}</p>}

      <HistoryLine page={page} versions={versions} onShowAll={onShowAll} onUndo={page.canUndo && !page.changedFromChat ? onUndo : undefined} />
    </div>
  )
}

/** "Keep this page" and, under it, "Under GLP-1 ⌄ · refresh weekly ⌄". */
function KeepControls({ page, pages, busy, onKeep }: { page: MwPage; pages: MwPageSummary[]; busy: boolean; onKeep: (input: { every: string; parent: string | null }) => void }) {
  const { t } = useTranslation()
  const [parent, setParent] = React.useState<string>(page.parent ?? '')
  const [every, setEvery] = React.useState<string>(page.refresh?.every ?? 'mon')
  const choices = parentChoices(page.id, pages)
  // Narrow, right-aligned: a long page title in the list must not widen the header.
  const select = 'max-w-[11rem] cursor-pointer appearance-none truncate bg-transparent pr-1 text-right text-label-sm text-secondary [text-align-last:right] hover:text-foreground focus:outline-none'
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-label font-medium text-background disabled:opacity-60"
        disabled={busy}
        onClick={() => onKeep({ every, parent: parent || null })}
        data-action="keep-page"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {t('memwise.pages.keep')}
      </button>
      <span className="flex items-center gap-1 text-label-sm text-secondary">
        <label className="sr-only" htmlFor={`keep-parent-${page.id}`}>{t('memwise.pages.under')}</label>
        <select id={`keep-parent-${page.id}`} className={select} value={parent} onChange={e => setParent(e.target.value)} data-keep-parent>
          <option value="">{t('memwise.pages.atTop')}</option>
          {choices.map(p => <option key={p.id} value={p.id}>{t('memwise.pages.underPage', { title: p.title })}</option>)}
        </select>
        <span aria-hidden>·</span>
        <label className="sr-only" htmlFor={`keep-every-${page.id}`}>{t('memwise.pages.howOften')}</label>
        <select id={`keep-every-${page.id}`} className={select} value={every} onChange={e => setEvery(e.target.value)} data-keep-every>
          {EVERY_CHOICES.map(e => <option key={e} value={e}>{t(`memwise.pages.every.${e}`)}</option>)}
        </select>
      </span>
    </>
  )
}

/** "History: 1 June, ATTAIN-MAINTAIN added, accepted by Leah · 25 May, nothing new · … · All changes". */
function HistoryLine({ page, versions, onShowAll, onUndo }: { page: MwPage; versions?: MwPageVersion[]; onShowAll?: () => void; onUndo?: () => void }) {
  const { t, i18n } = useTranslation()
  if (!page.history.length) return null
  const shown = page.history.slice(0, 3)
  return (
    <div className="mt-8 text-label-sm text-secondary" data-history>
      <p className="my-0">
        <span className="font-semibold text-foreground">{t('memwise.pages.historyLabel')}</span>{' '}
        {shown.map((h, i) => (
          <React.Fragment key={`${h.at}:${h.kind}:${i}`}>
            {i > 0 && ' · '}
            <span data-history-kind={h.kind}>{shortDate(h.at, i18n.language)}, {historyText(h, t)}</span>
          </React.Fragment>
        ))}
        {onShowAll && (
          <>
            {' · '}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={onShowAll} data-action="all-changes">{t('memwise.pages.allChanges')}</button>
          </>
        )}
        {onUndo && (
          <>
            {' · '}
            <button type="button" className="text-foreground underline underline-offset-2" onClick={onUndo} data-action="undo">{t('memwise.pages.undoLast')}</button>
          </>
        )}
      </p>
      {versions && (
        <ol className="mt-3 space-y-1 pl-0" data-versions>
          {[...page.history].map((h, i) => (
            <li key={`all:${h.at}:${i}`} className={cn('list-none')}>
              {dayDate(h.at, i18n.language)} · {historyText(h, t)}{h.version ? ` · ${t('memwise.pages.versionN', { n: h.version })}` : ''}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
