/**
 * Document review (24 §11): the record page in review mode. Beside the document, the values the
 * agent proposed as a draft form (each with where it came from, how sure it was, the page and the
 * quote; picking one scrolls the viewer to its highlight), the checks, a comment, and "Send back"
 * or "Approve and sign" (the signing dialog). In "Review in a row", a/s/j/k decide and move on.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronLeft, ChevronRight, Keyboard, PenLine, Quote, Undo2 } from 'lucide-react'
import type { MwProposedValue, MwRecordReview, MwSubmitResult } from '@memwise/shared/protocol'
import { Markdown } from '@memwise/ui'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { outcomeLabel, resultMessage } from '../format'
import { Pill } from '../playbook/Tags'
import {
  baseType,
  changedReviewFields,
  confidenceLabel,
  formatTypedValue,
  initialReviewDraft,
  isPercentType,
  missingReviewFields,
  queueKeyAction,
  reviewOutcomes,
  type ReviewDraft,
} from './record-model'
import { SignDialog } from './SignDialog'
import { SignatureCard } from './SignatureCard'

export interface ReviewSubmit {
  outcome: string
  values: Record<string, unknown>
  comment?: string
  signature?: { password: string }
}

export interface ReviewQueue {
  position: number
  total: number
  onNext?: () => void
  onPrevious?: () => void
  onStop?: () => void
}

export interface ReviewPanelProps {
  review: MwRecordReview
  submit: (input: ReviewSubmit) => Promise<MwSubmitResult>
  onDone?: (result: MwSubmitResult) => void
  /** The signer's role in words (the review names role ids). */
  roleTitle?: (role: string) => string | undefined
  /** The proposed value whose quote the viewer shows. */
  activeField?: string | null
  onPick?: (field: string | null) => void
  queue?: ReviewQueue
  /** Open the signing dialog at once (the playground). */
  initialSigning?: boolean
  /** Sign in the page itself (the Sign page, doc 26 §2) instead of in a dialog. */
  inlineSignature?: boolean
}

function editable(p: MwProposedValue): 'text' | 'number' | 'date' | 'boolean' | null {
  const base = baseType(p.type)
  if (base === 'Ref' || base === 'List' || base === 'Document' || base === 'File') return null
  if (base === 'Boolean') return 'boolean'
  if (base === 'Number' || isPercentType(base) || base === 'Integer') return 'number'
  if (base === 'Date') return 'date'
  return typeof p.value === 'object' && p.value !== null ? null : 'text'
}

function rationaleOf(p: MwProposedValue): string | undefined {
  return p.provenance?.kind === 'judgement' ? p.provenance.rationale : undefined
}

/** The agent's reasoning when every value it proposed gives the same one: shown once, above them. */
export function sharedRationale(proposed: MwProposedValue[]): string | undefined {
  const reasons = proposed.map(rationaleOf).filter((r): r is string => !!r)
  return reasons.length > 1 && reasons.every(r => r === reasons[0]) ? reasons[0] : undefined
}

function provenanceText(p: MwProposedValue, t: ReturnType<typeof useTranslation>['t'], shared?: string): string {
  const sure = confidenceLabel(p.confidence, t)
  const who = p.provenance?.kind === 'person' ? t('memwise.review.byPerson') : t('memwise.review.byAgent')
  const why = rationaleOf(p)
  return [sure ? `${who} · ${sure}` : who, why === shared ? undefined : why].filter(Boolean).join(' · ')
}

export function ReviewPanel({ review, submit, onDone, roleTitle, activeField, onPick, queue, initialSigning = false, inlineSignature = false }: ReviewPanelProps) {
  const { t, i18n } = useTranslation()
  const [draft, setDraft] = React.useState<ReviewDraft>(() => initialReviewDraft(review))
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<MwSubmitResult | null>(null)
  const [signing, setSigning] = React.useState(initialSigning)
  const { approve, sendBack } = reviewOutcomes(review.outcomes)
  const changed = changedReviewFields(review, draft)
  const shared = sharedRationale(review.proposed)
  const missing = missingReviewFields(review, draft)
  const done = !!result?.applied

  React.useEffect(() => {
    setDraft(initialReviewDraft(review))
    setComment('')
    setResult(null)
    setSigning(initialSigning)
  }, [review.stepRunId, initialSigning]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = React.useCallback(async (outcome: string, password?: string): Promise<MwSubmitResult> => {
    setBusy(outcome)
    try {
      const r = await submit({ outcome, values: draft, comment: comment.trim() || undefined, ...(password ? { signature: { password } } : {}) })
      if (!password || r.applied) setResult(r)
      if (r.applied) { setSigning(false); onDone?.(r) }
      else if (!password && (r.code === 'submit.signature-required' || r.code === 'submit.password-not-set')) setSigning(true)
      return r
    } catch (err) {
      const r: MwSubmitResult = { applied: false, message: err instanceof Error ? err.message : String(err) }
      setResult(r)
      return r
    } finally {
      setBusy(null)
    }
  }, [submit, draft, comment, onDone])

  const doApprove = React.useCallback(() => {
    if (!approve || done || busy) return
    if (missing.length) { setResult({ applied: false, message: t('memwise.review.fillRequired') }); return }
    if (review.sign) setSigning(true)
    else void send(approve)
  }, [approve, done, busy, missing.length, review.sign, send, t])

  const doSendBack = React.useCallback(() => {
    if (!sendBack || done || busy) return
    if (!comment.trim()) { setCommentError(t('memwise.inbox.commentRequired')); return }
    setCommentError(undefined)
    void send(sendBack)
  }, [sendBack, done, busy, comment, send, t])

  // Queue keys: only when no field has the focus and the signing dialog is closed.
  React.useEffect(() => {
    if (!queue || typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      if (signing) return
      const action = queueKeyAction(e)
      if (!action) return
      e.preventDefault()
      if (action === 'approve') doApprove()
      else if (action === 'sendBack') doSendBack()
      else if (action === 'next') queue.onNext?.()
      else if (action === 'previous') queue.onPrevious?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [queue, signing, doApprove, doSendBack])

  const signer = review.sign?.as
  const role = signer?.roles.map(r => roleTitle?.(r) ?? r).find(Boolean)

  return (
    <div className="space-y-4" data-review={review.stepRunId}>
      {queue && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-tint/50 px-3 py-2 text-label" data-review-queue>
          <span className="font-medium text-foreground">{t('memwise.review.queuePosition', { position: queue.position, total: queue.total })}</span>
          <span className="flex items-center gap-1 text-label-sm text-secondary"><Keyboard className="size-3.5" />{t('memwise.review.queueKeys')}</span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={queue.onPrevious} disabled={!queue.onPrevious} aria-label={t('memwise.review.previous')}><ChevronLeft /></Button>
            <Button size="icon-sm" variant="ghost" onClick={queue.onNext} disabled={!queue.onNext} aria-label={t('memwise.review.next')}><ChevronRight /></Button>
            {queue.onStop && <Button size="sm" variant="ghost" onClick={queue.onStop}>{t('memwise.review.stopQueue')}</Button>}
          </span>
        </div>
      )}

      <h3 className="text-label-lg font-semibold text-foreground" data-review-title>{review.title}</h3>
      {review.instructions?.trim() && (
        <div className="text-label text-secondary"><Markdown mode="minimal">{review.instructions}</Markdown></div>
      )}

      {review.returnedComments?.map((c, i) => (
        <Info_Alert key={i} variant="info" icon={<Undo2 />}>
          <Info_Alert.Title>{t('memwise.review.sentBackBy', { name: c.by })}</Info_Alert.Title>
          <Info_Alert.Description>{c.comment}</Info_Alert.Description>
        </Info_Alert>
      ))}

      <Info_Section title={t('memwise.review.proposed')} description={changed.length ? t('memwise.review.changedCount', { count: changed.length }) : t('memwise.review.proposedHint')}>
        {shared && <p className="border-b border-separator px-3.5 py-2.5 text-label-sm text-secondary" data-agent-rationale>{t('memwise.review.byAgent')} · {shared}</p>}
        <ul className="divide-y divide-separator" data-proposed>
          {review.proposed.map(p => {
            const kind = editable(p)
            const value = draft[p.field]
            const isActive = activeField === p.field
            const edited = changed.includes(p.field)
            return (
              <li
                key={p.field}
                className={cn('px-3.5 py-2.5 transition-[background-color] duration-micro', isActive && 'bg-accent-tint/40', p.quote && 'cursor-pointer')}
                onClick={() => p.quote && onPick?.(isActive ? null : p.field)}
                data-proposed-field={p.field}
                data-active={isActive || undefined}
              >
                <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
                  <label className="text-label text-secondary" htmlFor={`rv-${p.field}`}>
                    {p.label}
                    {p.required && <span className="text-destructive" aria-hidden> *</span>}
                  </label>
                  <div className="min-w-0" onClick={e => e.stopPropagation()}>
                    {kind === null || done ? (
                      <span className="text-label font-medium text-foreground">{formatTypedValue(p.type, value, t, i18n.language, value === p.value ? p.ref : undefined)}</span>
                    ) : kind === 'boolean' ? (
                      <label className="flex items-center gap-2 text-label">
                        <input id={`rv-${p.field}`} type="checkbox" checked={value === true} onChange={e => setDraft(d => ({ ...d, [p.field]: e.target.checked }))} disabled={!!busy} onFocus={() => p.quote && onPick?.(p.field)} />
                        {value === true ? t('memwise.form.yes') : t('memwise.form.no')}
                      </label>
                    ) : (
                      <Input
                        id={`rv-${p.field}`}
                        className="h-7"
                        type={kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'}
                        value={value === null || value === undefined ? '' : String(value)}
                        onChange={e => {
                          const v = e.target.value
                          setDraft(d => ({ ...d, [p.field]: kind === 'number' ? (v === '' ? null : Number(v)) : v }))
                        }}
                        onFocus={() => p.quote && onPick?.(p.field)}
                        disabled={!!busy}
                      />
                    )}
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-0 text-label-sm text-tertiary sm:pl-[132px]">
                  <span>{provenanceText(p, t, shared)}</span>
                  {p.page !== undefined && <span>{t('memwise.review.page', { page: p.page })}</span>}
                  {p.quote && (
                    <span className="inline-flex min-w-0 items-center gap-1 text-secondary" data-quote-of={p.field}>
                      <Quote className="size-3 shrink-0" />
                      <span className="truncate">“{p.quote}”</span>
                    </span>
                  )}
                  {edited && <Pill className="bg-info-tint text-info">{t('memwise.review.edited')}</Pill>}
                  {p.confidence !== undefined && p.confidence < 0.7 && <Pill className="bg-accent-tint text-accent">{t('memwise.review.checkThis')}</Pill>}
                </div>
              </li>
            )
          })}
        </ul>
      </Info_Section>

      <div className="space-y-1.5">
        <label htmlFor="rv-comment" className="block text-label font-medium text-foreground">
          {t('memwise.inbox.comment')}
          <span className="ml-1.5 font-normal text-tertiary">{t('memwise.review.commentHint')}</span>
        </label>
        <Textarea id="rv-comment" value={comment} onChange={e => { setComment(e.target.value); setCommentError(undefined) }} rows={3} disabled={!!busy || done} aria-invalid={!!commentError || undefined} />
        {commentError && <p className="text-label-sm text-destructive" role="alert">{commentError}</p>}
      </div>

      {inlineSignature && review.sign && approve ? (
        <SignatureCard
          meaning={review.sign.meaning}
          disabled={done}
          busy={busy === approve ? 'sign' : busy === sendBack ? 'sendBack' : null}
          onSign={async password => {
            if (missing.length) {
              const r: MwSubmitResult = { applied: false, message: t('memwise.review.fillRequired') }
              setResult(r)
              return r
            }
            return send(approve, password)
          }}
          onSendBack={sendBack ? doSendBack : undefined}
          onNeedsPassword={() => setSigning(true)}
        />
      ) : (
      <div className="flex flex-wrap justify-end gap-2" data-review-actions>
        {sendBack && (
          <Button variant="secondary" onClick={doSendBack} disabled={!!busy || done} data-outcome={sendBack}>
            <Undo2 />
            {busy === sendBack ? t('memwise.inbox.sending') : t('memwise.review.sendBack')}
          </Button>
        )}
        {approve && (
          <Button variant="primary" onClick={doApprove} disabled={!!busy || done} data-outcome={approve}>
            {review.sign && <PenLine />}
            {busy === approve ? t('memwise.inbox.sending') : review.sign ? t('memwise.review.approveAndSign') : outcomeLabel(approve, t)}
          </Button>
        )}
      </div>
      )}

      {result && !result.applied && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title>{result.errors ? t('memwise.inbox.fixErrors') : t('memwise.inbox.notApplied')}</Info_Alert.Title>
          {(result.code || result.message) && <Info_Alert.Description>{resultMessage(result, t)}</Info_Alert.Description>}
        </Info_Alert>
      )}

      {review.sign && approve && (
        <SignDialog
          open={signing}
          onOpenChange={setSigning}
          name={signer?.name ?? ''}
          role={role}
          meaning={review.sign.meaning}
          action={t('memwise.review.signAndApprove')}
          onSign={password => send(approve, password)}
        />
      )}
    </div>
  )
}
