/** The page's few building blocks: the frame, notes, plain pages for trouble, and instructions. */

import * as React from 'react'
import type { LinkRefusal } from '@memwise/defs/external'
import { parseMarkdown, type Inline } from './markdown'
import { refusalFallback, refusalTitle, S } from './strings'
import type { Unreachable } from './api'

export function Frame({ kicker, children, footer }: { kicker?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="frame">
      <main className="page" id="main">
        {kicker && <p className="kicker">{kicker}</p>}
        {children}
      </main>
      {footer}
    </div>
  )
}

type IconName = 'check' | 'clock' | 'lock' | 'search' | 'wifi' | 'pause' | 'info' | 'doc' | 'alert' | 'mail'

const PATHS: Record<IconName, string> = {
  check: 'M20 6 9 17l-5-5',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  search: 'm21 21-4.3-4.3M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  wifi: 'M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18',
  pause: 'M10 9v6M14 9v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info: 'M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  doc: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ?? 'icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  )
}

/** A whole page with one message: done, a refused link, trouble connecting. */
export function MessagePage({ icon, tone = 'neutral', title, children, action }: {
  icon: IconName
  tone?: 'neutral' | 'good' | 'warn'
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  const ref = React.useRef<HTMLHeadingElement>(null)
  React.useEffect(() => { ref.current?.focus() }, [title])
  return (
    <Frame>
      <section className="message" data-tone={tone}>
        <div className="message-icon"><Icon name={icon} /></div>
        <h1 ref={ref} tabIndex={-1}>{title}</h1>
        {children}
        {action && <div className="message-action">{action}</div>}
      </section>
    </Frame>
  )
}

const REFUSAL_ICON: Record<LinkRefusal['status'], IconName> = {
  expired: 'clock',
  used: 'check',
  closed: 'lock',
  revoked: 'lock',
  unknown: 'search',
  not_yet: 'clock',
  rate_limited: 'pause',
}

export function RefusalPage({ refusal, onRetry }: { refusal: LinkRefusal; onRetry?: () => void }) {
  const message = refusal.message?.trim() || refusalFallback(refusal.status)
  return (
    <MessagePage
      icon={REFUSAL_ICON[refusal.status] ?? 'info'}
      tone={refusal.status === 'used' ? 'good' : 'neutral'}
      title={refusalTitle(refusal.status)}
      action={(refusal.status === 'rate_limited' || refusal.status === 'not_yet') && onRetry
        ? <button type="button" className="button secondary" onClick={onRetry}>{S.tryAgain}</button>
        : undefined}
    >
      <div data-refusal={refusal.status}>
        <p>{message}</p>
        {refusal.status !== 'used' && <p className="muted">{S.replyForHelp}</p>}
      </div>
    </MessagePage>
  )
}

export function TroublePage({ error, onRetry }: { error: Unreachable; onRetry: () => void }) {
  const offline = error.reason === 'offline'
  const unavailable = error.reason === 'unavailable'
  return (
    <MessagePage
      icon={offline ? 'wifi' : 'alert'}
      title={offline ? S.offlineTitle : unavailable ? S.unavailableTitle : S.networkTitle}
      action={<button type="button" className="button primary" onClick={onRetry}>{S.tryAgain}</button>}
    >
      <p data-trouble={error.reason}>{offline ? S.offlineBody : unavailable ? S.unavailableBody : S.networkBody}</p>
    </MessagePage>
  )
}

export function Loading() {
  return (
    <Frame>
      <div className="loading" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span>{S.loading}</span>
      </div>
    </Frame>
  )
}

function Inlines({ list }: { list: Inline[] }) {
  return (
    <>
      {list.map((x, i) => {
        if (x.bold && x.italic) return <strong key={i}><em>{x.text}</em></strong>
        if (x.bold) return <strong key={i}>{x.text}</strong>
        if (x.italic) return <em key={i}>{x.text}</em>
        return <React.Fragment key={i}>{x.text}</React.Fragment>
      })}
    </>
  )
}

/** Instructions, from the safe Markdown subset (markdown.ts): text only, never HTML. */
export function Instructions({ source }: { source: string }) {
  const blocks = React.useMemo(() => parseMarkdown(source), [source])
  if (blocks.length === 0) return null
  return (
    <div className="instructions">
      {blocks.map((b, i) => {
        if (b.kind === 'p') return <p key={i}><Inlines list={b.inlines} /></p>
        if (b.kind === 'h') return <p key={i} className="instructions-heading"><Inlines list={b.inlines} /></p>
        const List = b.kind === 'ul' ? 'ul' : 'ol'
        return <List key={i}>{b.items.map((item, j) => <li key={j}><Inlines list={item} /></li>)}</List>
      })}
    </div>
  )
}

export function Callout({ tone = 'info', icon, children, live }: { tone?: 'info' | 'note' | 'good' | 'warn' | 'error'; icon?: IconName; children: React.ReactNode; live?: boolean }) {
  return (
    <div className="callout" data-tone={tone} role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
      {icon && <Icon name={icon} className="icon callout-icon" />}
      <div className="callout-body">{children}</div>
    </div>
  )
}
