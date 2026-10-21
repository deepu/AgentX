/**
 * A domain's home (domain.yaml `home:`): a question box, what is being watched and the questions
 * asked before, and some to try. Asking makes a draft and opens a chat that answers it, with the
 * draft's page beside it.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Loader2 } from 'lucide-react'
import type { MwDomain, MwDomainHome, MwRecordQueryResult } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'

export interface DomainHomeProps {
  domain: MwDomain
  home: MwDomainHome
  /** Records past their draft state and not ended: being worked on. */
  watching: MwRecordQueryResult | null
  /** Drafts: the questions asked before. */
  drafts: MwRecordQueryResult | null
  ask: (question: string) => Promise<void>
  onOpenRecord: (entity: string, id: string) => void
  onAbout: () => void
}

export function DomainHome({ domain, home, watching, drafts, ask, onOpenRecord, onAbout }: DomainHomeProps) {
  const { t } = useTranslation()
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // One question at a time: a second Enter or click while the first is starting does nothing.
  const asking = React.useRef(false)

  const submit = async (question: string) => {
    const q = question.trim()
    if (!q || asking.current) return
    asking.current = true
    setBusy(true)
    try {
      await ask(q)
      setText('')
    } finally {
      asking.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center px-6 pb-16 pt-[14vh]">
      <h1 className="text-center font-serif text-display text-foreground">{home.ask ?? t('memwise.home.defaultTitle')}</h1>
      {domain.description && <p className="mt-2 max-w-xl text-center text-label text-secondary">{domain.description}</p>}

      <form
        className="mt-8 w-full max-w-2xl rounded-2xl border border-border bg-background p-3 shadow-elev-1 focus-within:border-foreground/30"
        onSubmit={e => { e.preventDefault(); void submit(text) }}
      >
        <textarea
          className="min-h-[72px] w-full resize-none bg-transparent px-2 py-1 text-label-lg text-foreground outline-none placeholder:text-tertiary"
          placeholder={home.placeholder ?? ''}
          value={text}
          disabled={busy}
          autoFocus
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(text) } }}
        />
        <div className="flex items-center justify-between">
          <button type="button" className="text-label-sm text-tertiary hover:text-foreground" onClick={onAbout}>
            {t('memwise.home.about')}
          </button>
          <button
            type="submit"
            aria-label={t('memwise.home.ask')}
            disabled={busy || !text.trim()}
            className={cn('flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity', (busy || !text.trim()) && 'opacity-30')}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
      </form>

      <div className="mt-10 grid w-full max-w-2xl gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <RecordList title={t('memwise.home.watching')} rows={watching} onOpen={onOpenRecord} />
          <RecordList title={t('memwise.home.recent')} rows={drafts} onOpen={onOpenRecord} />
        </div>
        {home.suggested.length > 0 && (
          <section>
            <h2 className="mb-2 text-label-sm font-medium text-tertiary">{t('memwise.home.suggested')}</h2>
            <ul className="flex flex-col">
              {home.suggested.map(s => (
                <li key={s}>
                  <button type="button" disabled={busy} className="w-full rounded-md px-2 py-1.5 text-left text-label text-secondary hover:bg-foreground/5 hover:text-foreground" onClick={() => void submit(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

/** A short list of records under the box; nothing at all when there are none. */
function RecordList({ title, rows, onOpen }: { title: string; rows: MwRecordQueryResult | null; onOpen: (entity: string, id: string) => void }) {
  const list = rows?.rows.slice(0, 8) ?? []
  if (list.length === 0) return null
  return (
    <section>
      <h2 className="mb-2 text-label-sm font-medium text-tertiary">{title}</h2>
      <ul className="flex flex-col">
        {list.map(r => (
          <li key={r.id}>
            <button type="button" className="w-full truncate rounded-md px-2 py-1.5 text-left text-label text-foreground hover:bg-foreground/5" onClick={() => onOpen(r.entity, r.id)}>
              {r.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
