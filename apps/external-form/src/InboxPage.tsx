/**
 * An inbox item opened from an email or WhatsApp message (`/i/<token>`, 23 §6): what it is
 * about, and its buttons (a decision's outcomes, or approving what would be sent), each with a
 * confirming step. Items that need typed values say to open MemWise instead.
 */

import * as React from 'react'
import type { InboxLinkItem, LinkRefusal } from '@memwise/defs/external'
import { inboxApi, isRefusal, Unreachable, type InboxApi } from './api'
import { Callout, Frame, Icon, Loading, MessagePage, RefusalPage, TroublePage } from './ui'
import { S } from './strings'

type Phase =
  | { kind: 'loading' }
  | { kind: 'trouble'; error: Unreachable }
  | { kind: 'refused'; refusal: LinkRefusal }
  | { kind: 'open'; item: InboxLinkItem }
  | { kind: 'done'; message: string }

interface Choice { id: string; label: string; comment: 'none' | 'optional' | 'required'; primary: boolean }

/** The buttons an item offers: a decision's outcomes, or approve / don't send for an approval. */
export function choicesOf(item: InboxLinkItem): Choice[] {
  if (item.openInApp) return []
  if (item.kind === 'approval') {
    return [
      { id: 'approved', label: S.approve, comment: 'none', primary: true },
      { id: 'rejected', label: S.reject, comment: 'optional', primary: false },
    ]
  }
  const outcomes = item.outcomes ?? []
  return outcomes.map((o, i) => ({ ...o, primary: i === 0 && o.comment !== 'required' }))
}

export function InboxPage({ apiBase, api: given }: { apiBase: string; api?: InboxApi }) {
  const api = React.useMemo(() => given ?? inboxApi(apiBase), [given, apiBase])
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })

  const load = React.useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const answer = await api.item()
      setPhase(isRefusal(answer) ? { kind: 'refused', refusal: answer } : { kind: 'open', item: answer })
    } catch (err) {
      setPhase({ kind: 'trouble', error: err instanceof Unreachable ? err : new Unreachable('network') })
    }
  }, [api])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    if (phase.kind === 'open') document.title = `${phase.item.title} · ${phase.item.business}`
  }, [phase])

  switch (phase.kind) {
    case 'loading': return <Loading />
    case 'trouble': return <TroublePage error={phase.error} onRetry={() => void load()} />
    case 'refused': return <RefusalPage refusal={phase.refusal} onRetry={() => void load()} />
    case 'done':
      return (
        <MessagePage icon="check" tone="good" title={S.decided}>
          {phase.message && <p data-done>{phase.message}</p>}
          <p className="muted">{S.decidedVia}</p>
        </MessagePage>
      )
    case 'open':
      return (
        <OpenItem
          item={phase.item}
          api={api}
          onDone={message => setPhase({ kind: 'done', message })}
          onRefused={refusal => setPhase({ kind: 'refused', refusal })}
        />
      )
  }
}

function OpenItem({ item, api, onDone, onRefused }: {
  item: InboxLinkItem
  api: InboxApi
  onDone: (message: string) => void
  onRefused: (r: LinkRefusal) => void
}) {
  const choices = choicesOf(item)
  const [chosen, setChosen] = React.useState<Choice | null>(null)
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState<string | null>(null)
  const confirmRef = React.useRef<HTMLHeadingElement>(null)

  React.useEffect(() => { if (chosen) confirmRef.current?.focus() }, [chosen])

  const choose = (c: Choice) => { setChosen(c); setNote(null); setCommentError(null) }

  const confirm = async () => {
    if (!chosen || busy) return
    if (chosen.comment === 'required' && !comment.trim()) { setCommentError(S.commentRequired); return }
    setBusy(true)
    setNote(null)
    try {
      const r = await api.decide({ outcome: chosen.id, ...(comment.trim() && chosen.comment !== 'none' ? { comment: comment.trim() } : {}) })
      if (r.status === 'applied') { onDone(r.message); return }
      if (isRefusal(r) && r.status !== 'rate_limited') { onRefused(r); return }
      setNote(r.message)
    } catch {
      setNote(S.sendFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame kicker={S.forPerson(item.business, item.person)}>
      <h1 className="title">{item.title}</h1>
      <p className="subtitle"><span className="muted">{S.caseLabel}:</span> {item.caseTitle}</p>

      {item.fields.length > 0 && (
        <section className="card" aria-label={S.details}>
          <dl className="values">
            {item.fields.map((f, i) => (
              <div key={i} className="value-row">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {item.preview && (
        <section className="card preview" aria-label={S.preview} data-preview>
          <h2 className="card-title"><Icon name="mail" className="icon small" />{S.preview}</h2>
          {item.preview.summary && <p className="preview-summary">{item.preview.summary}</p>}
          {(item.preview.to || item.preview.subject) && (
            <dl className="values compact">
              {item.preview.to && <div className="value-row"><dt>{S.to}</dt><dd>{item.preview.to}</dd></div>}
              {item.preview.subject && <div className="value-row"><dt>{S.subject}</dt><dd className="strong">{item.preview.subject}</dd></div>}
            </dl>
          )}
          {item.preview.body && <div className="preview-body">{item.preview.body}</div>}
        </section>
      )}

      {item.openInApp && (
        <Callout tone="info" icon="info">
          <p className="callout-title">{S.openInAppTitle}</p>
          <p className="callout-text">{/^(https?:|memwise:)/i.test(item.openInApp) ? S.openInAppBody : item.openInApp}</p>
          {/^(https?:|memwise:)/i.test(item.openInApp) && (
            <p><a className="button secondary" href={item.openInApp} rel="noreferrer noopener">{S.openInApp}</a></p>
          )}
        </Callout>
      )}

      {note && <Callout tone="warn" icon="alert" live><p>{note}</p></Callout>}

      {choices.length > 0 && !chosen && (
        <div className="decide-buttons">
          {choices.map(c => (
            <button key={c.id} type="button" className={`button ${c.primary ? 'primary' : 'secondary'} wide`} onClick={() => choose(c)} data-choice={c.id}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      {chosen && (
        <section className="card confirm" aria-labelledby="confirm-title" data-confirm={chosen.id}>
          <h2 id="confirm-title" ref={confirmRef} tabIndex={-1} className="card-title">{S.confirmTitle(chosen.label)}</h2>
          {chosen.comment !== 'none' && (
            <div className="field">
              <label className="label" htmlFor="comment">
                <span className="label-text">{S.comment}</span>
                {chosen.comment === 'optional' && <span className="label-optional">{S.optional}</span>}
              </label>
              <textarea id="comment" className="input" rows={4} value={comment}
                onChange={e => { setComment(e.target.value); if (commentError) setCommentError(null) }}
                aria-invalid={commentError ? true : undefined} aria-describedby="comment-help" disabled={busy} />
              <p className="help" id="comment-help">{S.commentHelp}</p>
              {commentError && <p className="error" role="alert"><Icon name="alert" className="icon small" />{commentError}</p>}
            </div>
          )}
          <div className="decide-buttons">
            <button type="button" className={`button ${chosen.primary ? 'primary' : 'danger'} wide`} onClick={() => void confirm()} disabled={busy} data-action="confirm">
              {busy ? S.sending : S.confirm(chosen.label)}
            </button>
            <button type="button" className="button ghost wide" onClick={() => setChosen(null)} disabled={busy}>{S.goBack}</button>
          </div>
        </section>
      )}
    </Frame>
  )
}
