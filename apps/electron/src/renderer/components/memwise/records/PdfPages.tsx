/**
 * The PDF itself, page by page (react-pdf), with the quotes highlighted in its text layer.
 * Loaded lazily by DocumentViewer so pdf.js only loads when a record page shows a document.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { findQuotes, highlightItemHtml, rangesByItem, type QuoteMatch, type QuoteQuery } from './quote-highlight'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

export interface PdfPagesProps {
  data: Uint8Array
  quotes: QuoteQuery[]
  /** The quote picked in the form: scrolled to and drawn stronger. */
  active?: number | null
  /** Which quotes were found, once the text is read. */
  onFound?: (result: { matches: QuoteMatch[]; missing: number[] }) => void
  /** Page count, once loaded. */
  onPages?: (count: number) => void
}

const HIGHLIGHT_CSS = `
.mw-pdf .react-pdf__Page__textContent mark.mw-quote { background: rgb(250 204 21 / 0.42); color: transparent; border-radius: 2px; }
.mw-pdf .react-pdf__Page__textContent mark.mw-quote-active { background: rgb(250 204 21 / 0.7); outline: 2px solid rgb(234 179 8); }
`

export default function PdfPages({ data, quotes, active = null, onFound, onPages }: PdfPagesProps) {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState<number>(560)
  const [count, setCount] = React.useState(0)
  const [matches, setMatches] = React.useState<QuoteMatch[]>([])
  // react-pdf transfers the buffer to its worker: hand it a copy so the caller's bytes stay usable.
  const file = React.useMemo(() => ({ data: data.slice() }), [data])
  const quotesKey = JSON.stringify(quotes)
  const quotesRef = React.useRef(quotes)
  quotesRef.current = quotes

  React.useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pdfRef = React.useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null)
  const readText = React.useCallback(async () => {
    const pdf = pdfRef.current
    if (!pdf) return
    const pages: string[][] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const text = await page.getTextContent()
      // Keep every item's index (marked-content items have no text) so they line up with the text layer.
      pages.push(text.items.map(item => ('str' in item ? item.str : '')))
    }
    const result = findQuotes(pages, quotesRef.current)
    setMatches(result.matches)
    onFound?.(result)
  }, [quotesKey, onFound])

  React.useEffect(() => { void readText() }, [readText])

  const scrollToActive = React.useCallback(() => {
    if (active === null || active === undefined) return
    const mark = ref.current?.querySelector(`mark[data-quote="${active}"]`)
    if (mark && 'scrollIntoView' in mark) (mark as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])
  React.useEffect(() => { scrollToActive() }, [scrollToActive, matches])

  return (
    <div ref={ref} className="mw-pdf w-full" data-pdf-pages={count}>
      <style>{HIGHLIGHT_CSS}</style>
      <Document
        file={file}
        onLoadSuccess={pdf => {
          pdfRef.current = pdf
          setCount(pdf.numPages)
          onPages?.(pdf.numPages)
          void readText()
        }}
        loading={<p className="p-4 text-label text-tertiary">{t('memwise.viewer.loading')}</p>}
        error={<p className="p-4 text-label text-destructive">{t('memwise.viewer.failed')}</p>}
      >
        {Array.from({ length: count }, (_, i) => (
          <PdfPage key={i} pageNumber={i + 1} width={width} matches={matches} active={active} onTextReady={scrollToActive} />
        ))}
      </Document>
    </div>
  )
}

function PdfPage({ pageNumber, width, matches, active, onTextReady }: {
  pageNumber: number
  width: number
  matches: QuoteMatch[]
  active: number | null
  onTextReady: () => void
}) {
  const byItem = React.useMemo(() => rangesByItem(matches, pageNumber), [matches, pageNumber])
  const render = React.useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => highlightItemHtml(str, byItem.get(itemIndex), active),
    [byItem, active],
  )
  return (
    <div className="mb-3 overflow-hidden rounded-md bg-white shadow-elev-1 last:mb-0" data-pdf-page={pageNumber}>
      <Page
        pageNumber={pageNumber}
        width={width}
        renderAnnotationLayer={false}
        customTextRenderer={render}
        onRenderTextLayerSuccess={onTextReady}
      />
    </div>
  )
}
