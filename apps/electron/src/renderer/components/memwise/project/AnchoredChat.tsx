/**
 * The chat column of the project shell (doc 26 §2): the person's chat about the page beside it.
 * It continues the latest chat on the page's anchor; when there is none, it shows a composer and
 * the chat starts with the person's own first message (no hidden opening turn, no model call
 * until they ask). The chat itself is the regular one (`ChatPage`), with a small header.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useStore } from 'jotai'
import { ArrowUp, Loader2, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import type { MwChatAnchor } from '@memwise/shared/protocol'
import ChatPage from '@/pages/ChatPage'
import { cn } from '@/lib/utils'
import { memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { getMemwiseApi, waitForSession } from '@/hooks/useMemwise'
import { anchorKeyOf } from './project-model'

export interface AnchoredChatProps {
  anchor: MwChatAnchor
  /** The header's title: what the chat is about ("Waiting for you", the record's title). */
  title: string
  placeholder: string
  /** A chat to show instead of the latest one (a step's chat a page opened, a Home chat). */
  sessionId?: string | null
  /** Home: always starts a new chat unless one is open. */
  alwaysNew?: boolean
  /** Replaces the empty column above the composer (Home's question and lists). */
  empty?: (send: (message: string) => Promise<void>, busy: boolean) => React.ReactNode
  /** A chat was started here. */
  onStarted?: (sessionId: string) => void
  /** "New chat": the column goes back to the composer. */
  onNewChat?: () => void
}

export function AnchoredChat({ anchor, title, placeholder, sessionId, alwaysNew, empty, onStarted, onNewChat }: AnchoredChatProps) {
  const { t } = useTranslation()
  const store = useStore()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const sessions = useAtomValue(sessionMetaMapAtom)
  const key = anchorKeyOf(anchor)
  // undefined: still looking; null: none yet.
  const [found, setFound] = React.useState<{ key: string; sessionId: string | null } | undefined>(undefined)
  const [fresh, setFresh] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => { setFresh(false) }, [key])
  React.useEffect(() => {
    if (alwaysNew) { setFound({ key, sessionId: null }); return }
    let stale = false
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseFindChat !== 'function') { setFound({ key, sessionId: null }); return }
    api.memwiseFindChat(workspaceId, { anchor })
      .then(r => { if (!stale) setFound({ key, sessionId: r.sessionId }) })
      .catch(() => { if (!stale) setFound({ key, sessionId: null }) })
    return () => { stale = true }
    // The anchor is identified by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspaceId, alwaysNew])

  const latest = found?.key === key ? found.sessionId : undefined
  const shown = sessionId ?? (fresh ? null : latest)
  const exists = shown ? sessions.has(shown) : false

  const send = React.useCallback(async (message: string) => {
    const text = message.trim()
    const api = getMemwiseApi()
    if (!text || busy) return
    if (!api || !workspaceId || typeof api.memwiseOpenChat !== 'function') { toast.error(t('memwise.notAvailable')); return }
    setBusy(true)
    try {
      const r = await api.memwiseOpenChat(workspaceId, { anchor, message: text })
      await waitForSession(store, r.sessionId)
      setFresh(false)
      setFound({ key, sessionId: r.sessionId })
      onStarted?.(r.sessionId)
    } catch (err) {
      toast.error(t('memwise.step.openChatFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }, [anchor, busy, key, onStarted, store, t, workspaceId])

  const newChat = () => { setFresh(true); onNewChat?.() }
  const header = (
    <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-foreground/6 px-6">
      <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground" data-testid="shell-chat-title">{title}</span>
      {shown && (
        <button type="button" onClick={newChat} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-label-sm text-secondary hover:bg-fill-hover hover:text-foreground">
          <SquarePen className="size-3.5" />
          {t('memwise.shell.newChat')}
        </button>
      )}
    </div>
  )

  if (shown && exists) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="shell-chat" data-session-id={shown}>
        <ChatPage sessionId={shown} header={header} />
      </div>
    )
  }
  if (found === undefined && !sessionId) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-4 animate-spin text-tertiary" /></div>
  }
  if (empty) {
    return <div className="h-full min-h-0 overflow-y-auto" data-testid="shell-chat-empty">{empty(send, busy)}</div>
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="shell-chat-empty">
      {header}
      <div className="flex-1" />
      <div className="px-5 pb-4">
        <Composer placeholder={placeholder} busy={busy} onSend={send} />
      </div>
    </div>
  )
}

/** The question box: Enter sends, Shift+Enter breaks the line. */
export function Composer({ placeholder, busy, onSend, large, autoFocus, footer }: {
  placeholder: string
  busy: boolean
  onSend: (text: string) => Promise<void>
  large?: boolean
  autoFocus?: boolean
  /** Chips under the text (Home: where answers come from). */
  footer?: React.ReactNode
}) {
  const { t } = useTranslation()
  const [text, setText] = React.useState('')
  const submit = async () => {
    const q = text.trim()
    if (!q || busy) return
    await onSend(q)
    setText('')
  }
  return (
    <form
      data-testid="shell-composer"
      className={cn(
        'w-full rounded-[14px] border bg-background shadow-minimal transition-colors',
        large ? 'border-accent/40 p-3.5' : 'border-foreground/12 p-3 focus-within:border-foreground/25',
      )}
      onSubmit={e => { e.preventDefault(); void submit() }}
    >
      <textarea
        className={cn('w-full resize-none bg-transparent px-1 text-foreground outline-none placeholder:text-tertiary', large ? 'min-h-[56px] text-label-lg' : 'min-h-[40px] text-label')}
        placeholder={placeholder}
        value={text}
        disabled={busy}
        autoFocus={autoFocus}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
      />
      <div className="mt-1 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">{footer}</div>
        <button
          type="submit"
          aria-label={t('memwise.home.ask')}
          disabled={busy || !text.trim()}
          className={cn('flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity', (busy || !text.trim()) && 'opacity-30')}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </form>
  )
}
