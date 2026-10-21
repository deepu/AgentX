/**
 * A page's body (docs/memwise/26-projects-and-pages.md §4): its headline paragraph in larger type,
 * then each `##` section with its blocks drawn by the one page-block renderer the chat uses too.
 * Sections a chat changed carry "Changed from chat · Undo" and a coloured rule beside them.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown, PageBlocksContext, type PageBlocksActions } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { splitHeadline, splitSections } from './page-model'

export interface PageBodyProps {
  body: string
  /** Sections the last version changed from chat (`''`: the text before the first heading). */
  changedFromChat?: string[]
  /** Undo the chat's change (absent: no Undo link). */
  onUndo?: () => void
  /** Sections to mark otherwise (the review screen: "From the refresh"). */
  marks?: Record<string, { label: string; tone: 'chat' | 'refresh' }>
  actions?: PageBlocksActions
  className?: string
}

export function PageBody({ body, changedFromChat = [], onUndo, marks = {}, actions = {}, className }: PageBodyProps) {
  const { t } = useTranslation()
  const sections = React.useMemo(() => splitSections(body), [body])
  const changed = new Set(changedFromChat)
  const md = (text: string) => <Markdown mode="minimal" onUrlClick={actions.onUrlClick}>{text}</Markdown>
  return (
    <PageBlocksContext.Provider value={actions}>
      <div className={cn('space-y-5 text-[14px] leading-relaxed text-foreground', className)} data-page-body>
        {sections.map((s, i) => {
          const key = s.heading ?? ''
          const fromChat = changed.has(key)
          const mark = marks[key] ?? (fromChat ? { label: t('memwise.pages.changedFromChat'), tone: 'chat' as const } : undefined)
          if (s.heading === undefined) {
            const { headline, rest } = i === 0 ? splitHeadline(s.markdown) : { headline: '', rest: s.markdown }
            return (
              <section key={`s${i}`} className={cn(mark && 'border-l-2 border-accent pl-3.5')} data-section="" data-changed-from-chat={fromChat ? '' : undefined}>
                {mark && <SectionMark label={mark.label} onUndo={fromChat ? onUndo : undefined} />}
                {headline && <div className="text-[15px] leading-relaxed [&_p]:my-0" data-headline>{md(headline)}</div>}
                {rest && <div className={cn(headline && 'mt-4')}>{md(rest)}</div>}
              </section>
            )
          }
          return (
            <section key={`s${i}`} className={cn(mark && 'border-l-2 border-accent pl-3.5')} data-section={s.heading} data-changed-from-chat={fromChat ? '' : undefined}>
              <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-label-lg font-semibold text-foreground">
                <span>{s.heading}</span>
                {mark && <SectionMark label={mark.label} onUndo={fromChat ? onUndo : undefined} inline />}
              </h2>
              {s.markdown && md(s.markdown)}
            </section>
          )
        })}
      </div>
    </PageBlocksContext.Provider>
  )
}

function SectionMark({ label, onUndo, inline }: { label: string; onUndo?: () => void; inline?: boolean }) {
  const { t } = useTranslation()
  return (
    <span className={cn('text-label-sm font-normal text-accent', !inline && 'mb-1 block')} data-section-mark>
      {label}
      {onUndo && (
        <>
          {' · '}
          <button type="button" className="text-foreground underline underline-offset-2" onClick={onUndo} data-action="undo-chat-change">{t('memwise.pages.undo')}</button>
        </>
      )}
    </span>
  )
}
