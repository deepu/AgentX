/**
 * Home's "Pages kept up to date" (docs/memwise/26-projects-and-pages.md §4; mock LHome): each kept
 * page with its parent ("GLP-1 › Weight loss"), what it says now, and when it last refreshed.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwPageSummary } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { pathTitle, refreshedWhen } from './page-model'

export interface PagesKeptTableProps {
  /** The project's pages (`useMemwisePages`); only kept ones are shown. */
  pages: MwPageSummary[]
  onOpenPage?: (pageId: string) => void
  /** Show the "Pages kept up to date N" heading (default true). */
  heading?: boolean
  now?: Date
}

/** Kept pages, in the tree's order. */
export function keptPages(pages: MwPageSummary[]): MwPageSummary[] {
  return pages.filter(p => p.status === 'kept')
}

/** What a kept page says now: a parent that sums its sub-pages says how many and whether anything is new. */
export function saysNow(page: MwPageSummary, pages: MwPageSummary[], t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!page.sumsChildren) return page.headline
  const kids = pages.filter(p => p.parent === page.id && p.status !== 'archived')
  if (!kids.length) return page.headline
  const anyNew = kids.some(k => k.pendingChange)
  const tail = t(anyNew ? 'memwise.pages.kept.subpagesChanged' : 'memwise.pages.kept.subpagesNothingNew', { count: kids.length })
  return page.headline ? `${page.headline} · ${tail}` : tail
}

export function PagesKeptTable({ pages, onOpenPage, heading = true, now }: PagesKeptTableProps) {
  const { t, i18n } = useTranslation()
  const kept = keptPages(pages)
  if (!kept.length) return null
  return (
    <section data-pages-kept>
      {heading && (
        <h2 className="mb-2 text-label font-semibold text-foreground">
          {t('memwise.pages.kept.title')} <span className="font-normal text-secondary">{kept.length}</span>
        </h2>
      )}
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-label">
          <thead>
            <tr className="border-b border-border text-label-sm text-secondary">
              <th className="px-3.5 py-2 font-medium">{t('memwise.pages.kept.page')}</th>
              <th className="px-3.5 py-2 font-medium">{t('memwise.pages.kept.saysNow')}</th>
              <th className="px-3.5 py-2 font-medium">{t('memwise.pages.kept.refreshed')}</th>
            </tr>
          </thead>
          <tbody>
            {kept.map(p => {
              const { parents } = pathTitle(p, pages)
              const when = p.lastRefresh?.at ?? p.refresh?.last
              return (
                <tr
                  key={p.id}
                  className={cn('border-b border-border align-top last:border-b-0', onOpenPage && 'cursor-pointer hover:bg-foreground/[0.02]')}
                  onClick={onOpenPage ? () => onOpenPage(p.id) : undefined}
                  data-kept-page={p.id}
                >
                  <td className="px-3.5 py-2.5">
                    {parents.map(x => <span key={x} className="text-secondary">{x}<span aria-hidden> › </span></span>)}
                    <span className="text-foreground">{p.title}</span>
                  </td>
                  <td className="px-3.5 py-2.5 text-foreground">{saysNow(p, pages, t)}</td>
                  <td className="whitespace-nowrap px-3.5 py-2.5 text-foreground">{refreshedWhen(when, i18n.language, now)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
