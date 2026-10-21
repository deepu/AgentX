/**
 * The record page's `viewer` block on a Text field (25 §4): the text with the quotes of the
 * record's values and of its related records highlighted. Hovering a highlight names the field
 * it was quoted for; `active` scrolls to one. Quotes the text doesn't contain are listed below.
 * Matching is the kernel's (quote-highlight.ts): NFKC, case folded, whitespace collapsed.
 * Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { SearchX } from 'lucide-react'
import { Info_Section } from '@/components/info/Info_Section'
import { cn } from '@/lib/utils'
import { findTextQuotes, textSegments } from './quote-highlight'

export interface TextQuote {
  quote: string
  /** The field it was quoted for, in words ("Sample size", "Evidence · Effect"). */
  label: string
  /** The field's name, for `data-quote-field` and picking. */
  field?: string
}

export interface TextViewerProps {
  title: string
  text: string | null | undefined
  quotes?: TextQuote[]
  /** The quote (index in `quotes`) to scroll to and mark. */
  active?: number | null
  /** Picks a highlight (the page can show which value it belongs to). */
  onPick?: (quote: number) => void
}

export function TextViewer({ title, text, quotes = [], active = null, onPick }: TextViewerProps) {
  const { t } = useTranslation()
  const body = text ?? ''
  const { ranges, missing } = React.useMemo(() => findTextQuotes(body, quotes.map(q => q.quote)), [body, quotes])
  const segments = React.useMemo(() => textSegments(body, ranges), [body, ranges])
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (active === null || active === undefined) return
    const el = ref.current?.querySelector(`mark[data-quote~="${active}"]`)
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  return (
    <Info_Section title={title} count={ranges.length || undefined}>
      {!body.trim() ? (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.viewer.noText')}</p>
      ) : (
        <div ref={ref} className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap px-3.5 py-3 text-label leading-relaxed text-foreground [overflow-wrap:anywhere]" data-text-viewer data-quotes-found={ranges.length}>
          {segments.map(s => {
            const piece = body.slice(s.start, s.end)
            if (s.quotes.length === 0) return <React.Fragment key={s.start}>{piece}</React.Fragment>
            const labels = [...new Set(s.quotes.map(q => quotes[q]!.label))]
            const fields = [...new Set(s.quotes.map(q => quotes[q]!.field ?? quotes[q]!.label))]
            const isActive = active !== null && s.quotes.includes(active)
            return (
              <mark
                key={s.start}
                title={t('memwise.viewer.quoteFor', { field: labels.join(', ') })}
                data-quote={s.quotes.join(' ')}
                data-quote-field={fields.join(' ')}
                className={cn(
                  'rounded-xs bg-info-tint px-px text-foreground',
                  s.quotes.length > 1 && 'bg-accent-tint',
                  isActive && 'ring-1 ring-info',
                  onPick && 'cursor-pointer',
                )}
                onClick={onPick ? () => onPick(s.quotes[0]!) : undefined}
              >
                {piece}
              </mark>
            )
          })}
        </div>
      )}
      {missing.length > 0 && (
        <div className="border-t border-separator px-3.5 py-2.5" data-quotes-missing={missing.length}>
          <p className="flex items-center gap-1.5 text-label-sm font-medium text-secondary">
            <SearchX className="size-3.5" />
            {t('memwise.viewer.notFoundText')}
          </p>
          <ul className="mt-1 space-y-0.5 text-label-sm text-secondary">
            {missing.map(i => (
              <li key={i} data-quote-missing={quotes[i]!.field ?? quotes[i]!.label}><span className="text-tertiary">{quotes[i]!.label}:</span> “{quotes[i]!.quote}”</li>
            ))}
          </ul>
        </div>
      )}
    </Info_Section>
  )
}
