/**
 * MarkdownPageBlock - draws a MemWise page's fenced blocks (docs/memwise/26-projects-and-pages.md
 * §4): ```tiles, ```table, ```records and ```subpages. One renderer for pages and chat messages
 * (D84): a page passes PageBlocksContext so sub-pages and records open; in chat they are plain.
 *
 * A table cell may link to its source and carry the quote it came from ("every number links to
 * the sentence it came from", D81/D82): such a value is underlined with dots, and choosing it
 * shows the quote under the table. Live blocks come back from the server with their rows filled
 * in; in chat (not filled in) they say they show on the page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import {
  parseRecords, parseSubpages, parseTable, parseTiles, recordValueText, safeHref,
  type PageCell, type PageQuote, type PageRecentChange, type PageSubpage,
} from './page-blocks'

/** What a page screen lets its blocks open; absent in chat. */
export interface PageBlocksActions {
  onOpenPage?: (pageId: string) => void
  onOpenRecord?: (entity: string, id: string) => void
  onUrlClick?: (url: string) => void
}

export const PageBlocksContext = React.createContext<PageBlocksActions>({})

export interface MarkdownPageBlockProps {
  lang: string
  code: string
  className?: string
  onUrlClick?: (url: string) => void
}

export function MarkdownPageBlock({ lang, code, className, onUrlClick }: MarkdownPageBlockProps) {
  switch (lang) {
    case 'tiles': return <TilesBlock code={code} className={className} />
    case 'table': return <TableBlock code={code} className={className} onUrlClick={onUrlClick} />
    case 'records': return <RecordsBlock code={code} className={className} />
    case 'subpages': return <SubpagesBlock code={code} className={className} />
    default: return <CodeBlock code={code} language={lang} mode="full" className={className} />
  }
}

function Invalid({ code, kind, error, className }: { code: string; kind: string; error: 'json' | 'shape'; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={className} data-page-block-invalid={kind}>
      <CodeBlock code={code} language="json" mode="full" />
      <p className="mt-1 flex items-start gap-1.5 text-label-sm text-tertiary">
        <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>{t('pageBlock.invalid', { kind, error: t(`pageBlock.error.${error}`) })}</span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- tiles

function TilesBlock({ code, className }: { code: string; className?: string }) {
  const parsed = React.useMemo(() => parseTiles(code), [code])
  if (!parsed.ok) return <Invalid code={code} kind="tiles" error={parsed.error} className={className} />
  return (
    <div className={cn('grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3', className)} data-page-block="tiles">
      {parsed.value.map((tile, i) => (
        <div key={`${i}:${tile.label}`} className="min-w-0 rounded-lg border border-border px-3.5 py-3" data-tile={tile.label}>
          <div className="truncate text-label-sm text-secondary">{tile.label}</div>
          <div className="mt-0.5 truncate text-[1.5rem] font-semibold leading-tight tabular-nums text-foreground">{tile.value}</div>
          {tile.note && <div className="mt-1 truncate text-label-sm text-tertiary">{tile.note}</div>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- table

function QuoteNote({ quote, onUrlClick }: { quote: PageQuote; onUrlClick?: (url: string) => void }) {
  return (
    <blockquote className="mt-2 border-l-2 border-accent bg-accent-tint/40 px-3.5 py-2.5 text-label text-foreground" data-quote>
      <p className="my-0">“{quote.text}”</p>
      {(quote.cite || quote.href) && (
        <p className="my-0 mt-1 text-label-sm text-secondary">
          {quote.cite}
          {quote.cite && quote.href && ' · '}
          {quote.href && <LinkText href={quote.href} onUrlClick={onUrlClick}>{quote.href.replace(/^https?:\/\/(dx\.)?doi\.org\//, 'doi:')}</LinkText>}
        </p>
      )}
    </blockquote>
  )
}

function LinkText({ href: raw, children, onUrlClick }: { href: string; children: React.ReactNode; onUrlClick?: (url: string) => void }) {
  const href = safeHref(raw)
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      className="text-foreground underline underline-offset-2"
      onClick={onUrlClick ? (e) => { e.preventDefault(); onUrlClick(href) } : undefined}
      target={onUrlClick ? undefined : '_blank'}
      rel="noreferrer"
    >
      {children}
    </a>
  )
}

function CellView({ cell, chosen, onChoose, onUrlClick }: { cell: PageCell; chosen: boolean; onChoose: () => void; onUrlClick?: (url: string) => void }) {
  const { t } = useTranslation()
  if (cell.quote) {
    return (
      <button
        type="button"
        className={cn('text-left underline decoration-accent/60 decoration-dotted underline-offset-4', chosen && 'bg-accent-tint/60')}
        onClick={onChoose}
        aria-pressed={chosen}
        title={t('pageBlock.showQuote')}
        data-cell-quote
      >
        {cell.text}
      </button>
    )
  }
  if (cell.href) return <LinkText href={cell.href} onUrlClick={onUrlClick}>{cell.text}</LinkText>
  return <span className={cn(cell.muted && 'text-tertiary')}>{cell.text}</span>
}

function TableBlock({ code, className, onUrlClick }: { code: string; className?: string; onUrlClick?: (url: string) => void }) {
  const actions = React.useContext(PageBlocksContext)
  const open = onUrlClick ?? actions.onUrlClick
  const parsed = React.useMemo(() => parseTable(code), [code])
  const [chosen, setChosen] = React.useState<string | null>(null)
  if (!parsed.ok) return <Invalid code={code} kind="table" error={parsed.error} className={className} />
  const table = parsed.value
  const quote = chosen ? (() => {
    const [r, k] = chosen.split(':')
    return table.rows[Number(r)]?.[k!]?.quote
  })() : undefined
  return (
    <div className={className} data-page-block="table">
      {table.title && <div className="mb-1.5 text-label font-semibold text-foreground">{table.title}</div>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-label">
          <thead>
            <tr className="border-b border-border">
              {table.columns.map((c) => (
                <th key={c.key} className={cn('px-3.5 py-2.5 text-left align-bottom text-label-sm font-medium', c.changed ? 'text-accent' : 'text-secondary')} data-column-changed={c.changed ? '' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border last:border-b-0">
                {table.columns.map((c) => {
                  const cell = row[c.key]
                  const id = `${ri}:${c.key}`
                  return (
                    <td key={c.key} className="px-3.5 py-2.5 align-top text-foreground">
                      {cell ? <CellView cell={cell} chosen={chosen === id} onChoose={() => setChosen(chosen === id ? null : id)} onUrlClick={open} /> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {quote && <QuoteNote quote={quote} onUrlClick={open} />}
      {table.note && <p className="my-0 mt-1.5 text-label-sm text-tertiary">{table.note}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- records (live)

/** A field name in words for a column head: `missing_documents` → "Missing documents". */
function fieldWords(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : name
}

function RecordsBlock({ code, className }: { code: string; className?: string }) {
  const { t } = useTranslation()
  const { onOpenRecord } = React.useContext(PageBlocksContext)
  const parsed = React.useMemo(() => parseRecords(code), [code])
  if (!parsed.ok) return <Invalid code={code} kind="records" error={parsed.error} className={className} />
  const block = parsed.value
  if (block.error) {
    return <p className={cn('flex items-start gap-1.5 text-label-sm text-tertiary', className)} data-page-block="records" data-error><AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />{block.error}</p>
  }
  const r = block.result
  if (!r) {
    return <p className={cn('rounded-lg border border-dashed border-border px-3.5 py-2.5 text-label-sm text-tertiary', className)} data-page-block="records" data-live>{t('pageBlock.recordsOnPage', { entity: block.entity })}</p>
  }
  const columns = (block.columns?.length ? block.columns : r.columns.map((c) => c.name)).filter((c) => c !== 'title').slice(0, 4)
  return (
    <div className={className} data-page-block="records">
      <div className="mb-1.5 flex items-baseline gap-1.5 text-label">
        <span className="font-semibold text-foreground">{block.title ?? r.entity}</span>
        <span className="text-tertiary">{t('pageBlock.recordsTotal', { count: r.total })}</span>
      </div>
      {r.rows.length === 0 ? (
        <p className="my-0 text-label-sm text-tertiary">{t('pageBlock.recordsNone')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-label">
            <thead>
              <tr className="border-b border-border">
                <th className="px-3.5 py-2 text-left text-label-sm font-medium text-secondary">{t('pageBlock.recordTitle')}</th>
                {columns.map((c) => <th key={c} className="px-3.5 py-2 text-left text-label-sm font-medium text-secondary">{fieldWords(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-b-0" data-record={row.id}>
                  <td className="px-3.5 py-2 align-top">
                    {onOpenRecord
                      ? <button type="button" className="text-left text-foreground underline-offset-2 hover:underline" onClick={() => onOpenRecord(r.entity, row.id)}>{row.title}</button>
                      : <span className="text-foreground">{row.title}</span>}
                  </td>
                  {columns.map((c) => <td key={c} className="px-3.5 py-2 align-top text-secondary">{row.refs?.[c] ?? recordValueText(row.values[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- sub-pages (live)

function shortDay(iso: string, lang: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'long' }).format(d)
}

function SubpageCard({ page }: { page: PageSubpage }) {
  const { t, i18n } = useTranslation()
  const { onOpenPage } = React.useContext(PageBlocksContext)
  const last = page.last
  const when = last ? shortDay(last.at, i18n.language) : ''
  const footer = !last ? '' : last.kind === 'accepted' ? t('pageBlock.sub.changed', { when })
    : last.kind === 'nothing_new' ? t('pageBlock.sub.nothingNew', { when })
      : last.kind === 'chat' ? t('pageBlock.sub.fromChat', { when })
        : t('pageBlock.sub.made', { when })
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-label font-semibold text-foreground">
        <span className="truncate">{page.title}</span>
        {page.status === 'kept' && <RefreshCw aria-label={t('pageBlock.sub.kept')} className="size-3.5 shrink-0" />}
        {page.status === 'draft' && <span className="rounded bg-foreground/5 px-1.5 py-0.5 text-[11px] font-normal text-secondary">{t('pageBlock.sub.draft')}</span>}
      </div>
      {page.headline && <p className="my-0 mt-1 line-clamp-3 text-label text-foreground">{page.headline}</p>}
      {footer && <p className="my-0 mt-1.5 text-label-sm text-tertiary">{footer}</p>}
    </>
  )
  const cls = 'block w-full min-w-0 rounded-lg border border-border px-3.5 py-3 text-left'
  return onOpenPage
    ? <button type="button" className={cn(cls, 'hover:bg-foreground/[0.03]')} onClick={() => onOpenPage(page.id)} data-subpage={page.id} data-in-summary={page.inSummary ? '' : undefined}>{body}</button>
    : <div className={cls} data-subpage={page.id} data-in-summary={page.inSummary ? '' : undefined}>{body}</div>
}

function ChangeLine({ change }: { change: PageRecentChange }) {
  const { t } = useTranslation()
  const { onOpenPage } = React.useContext(PageBlocksContext)
  const what = change.kind === 'accepted' ? (change.byName ? t('pageBlock.week.acceptedBy', { text: change.text ?? '', name: change.byName }) : change.text ?? t('pageBlock.week.accepted'))
    : change.kind === 'nothing_new' ? t('pageBlock.week.nothingNew')
      : change.kind === 'chat' ? t('pageBlock.week.chat')
        : t('pageBlock.week.made')
  return (
    <li data-week-change={change.kind}>
      {change.kind === 'accepted' && onOpenPage
        ? <button type="button" className="underline underline-offset-2" onClick={() => onOpenPage(change.pageId)}>{change.title}</button>
        : <span>{change.title}</span>}
      {': '}{what}
    </li>
  )
}

function SubpagesBlock({ code, className }: { code: string; className?: string }) {
  const { t } = useTranslation()
  const parsed = React.useMemo(() => parseSubpages(code), [code])
  if (!parsed.ok) return <Invalid code={code} kind="subpages" error={parsed.error} className={className} />
  const { pages, changes } = parsed.value
  if (!pages) {
    return <p className={cn('rounded-lg border border-dashed border-border px-3.5 py-2.5 text-label-sm text-tertiary', className)} data-page-block="subpages" data-live>{t('pageBlock.subpagesOnPage')}</p>
  }
  return (
    <div className={className} data-page-block="subpages">
      <div className="mb-2 text-label font-semibold text-foreground">{t('pageBlock.sub.title')}</div>
      {pages.length === 0
        ? <p className="my-0 text-label-sm text-tertiary">{t('pageBlock.sub.none')}</p>
        : <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2.5">{pages.map((p) => <SubpageCard key={p.id} page={p} />)}</div>}
      {changes && changes.length > 0 && (
        <div className="mt-5" data-week>
          <div className="mb-1 text-label font-semibold text-foreground">{t('pageBlock.week.title')}</div>
          <ul className="my-0 list-none space-y-0.5 pl-0 text-label text-foreground">{changes.map((c) => <ChangeLine key={`${c.pageId}:${c.at}`} change={c} />)}</ul>
        </div>
      )}
    </div>
  )
}
