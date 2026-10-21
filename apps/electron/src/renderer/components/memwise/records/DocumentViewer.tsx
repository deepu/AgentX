/**
 * The record page's `viewer` block: the document (a PDF drawn by pdf.js, loaded lazily) with
 * the review's quotes highlighted, and the quotes the text layer did not contain listed below.
 * Presentational: the container loads the bytes (memwise:files:read).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, SearchX } from 'lucide-react'
import type { MwDocument } from '@memwise/shared/protocol'
import { Info_Section } from '@/components/info/Info_Section'
import { formatBytes } from '../format'
import type { QuoteMatch, QuoteQuery } from './quote-highlight'

const PdfPages = React.lazy(() => import('./PdfPages'))

export interface ViewerQuote extends QuoteQuery { label: string }

export interface DocumentViewerProps {
  document: MwDocument | null
  data?: Uint8Array | null
  loading?: boolean
  error?: string | null
  quotes?: ViewerQuote[]
  active?: number | null
  /** Shown when the found quotes are known; tests and the playground pass it. */
  missing?: number[]
}

export function DocumentViewer({ document, data, loading, error, quotes = [], active = null, missing: fixedMissing }: DocumentViewerProps) {
  const { t } = useTranslation()
  const [missing, setMissing] = React.useState<number[] | null>(fixedMissing ?? null)
  const [pages, setPages] = React.useState<number | null>(null)
  const onFound = React.useCallback((r: { matches: QuoteMatch[]; missing: number[] }) => setMissing(r.missing), [])
  const isPdf = !!document && (document.mime === 'application/pdf' || /\.pdf$/i.test(document.name))

  const title = document
    ? pages ? t('memwise.viewer.titlePages', { name: document.name, count: pages }) : t('memwise.viewer.title', { name: document.name })
    : t('memwise.viewer.noDocument')

  return (
    <Info_Section title={title}>
      <div className="bg-fill-hover/40 p-3" data-viewer={document?.id ?? ''}>
        {!document ? (
          <p className="px-1 py-6 text-center text-label text-tertiary">{t('memwise.viewer.noDocument')}</p>
        ) : !isPdf ? (
          <div className="flex items-center gap-2 px-1 py-4 text-label text-secondary">
            <FileText className="size-4" />
            <span className="truncate">{document.name}</span>
            <span className="text-tertiary tabular-nums">{formatBytes(document.size)}</span>
            <span className="text-tertiary">· {t('memwise.viewer.noPreview')}</span>
          </div>
        ) : error ? (
          <p className="px-1 py-6 text-center text-label text-destructive" role="alert">{t('memwise.viewer.failed')}: {error}</p>
        ) : loading || !data ? (
          <p className="px-1 py-6 text-center text-label text-tertiary">{t('memwise.viewer.loading')}</p>
        ) : (
          <React.Suspense fallback={<p className="px-1 py-6 text-center text-label text-tertiary">{t('memwise.viewer.loading')}</p>}>
            <PdfPages data={data} quotes={quotes} active={active} onFound={onFound} onPages={setPages} />
          </React.Suspense>
        )}
      </div>
      {quotes.length > 0 && missing && missing.length > 0 && (
        <div className="border-t border-separator px-3.5 py-2.5" data-quotes-missing={missing.length}>
          <p className="flex items-center gap-1.5 text-label-sm font-medium text-secondary">
            <SearchX className="size-3.5" />
            {t('memwise.viewer.notFound')}
          </p>
          <ul className="mt-1 space-y-0.5 text-label-sm text-secondary">
            {missing.map(i => quotes[i] && (
              <li key={i}><span className="text-tertiary">{quotes[i]!.label}:</span> “{quotes[i]!.quote}”</li>
            ))}
          </ul>
        </div>
      )}
    </Info_Section>
  )
}
