/**
 * Diff review (24 §11, `review.kind: diff`): what a value is now beside what the step would make
 * it, changed rows first, then approve or send back. A simple side-by-side; the Phase 3 draft
 * diff stays on the draft's own screen.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Undo2 } from 'lucide-react'
import type { MwInboxItem, MwSubmitResult, MwSubmitStepInput } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatValueInline, humanize, outcomeLabel, resultMessage } from '../format'
import { diffRows, reviewOutcomes } from './record-model'

type ReviewItem = Extract<MwInboxItem, { kind: 'input' | 'decision' }>

/** The two sides of a diff review: a form step proposes its prefill over its reads; a decision shows what it decides on. */
export function diffSides(item: ReviewItem): { before: Record<string, unknown>; after: Record<string, unknown> } {
  if (item.kind === 'input') {
    const after = Object.fromEntries(Object.entries(item.prefill).map(([k, v]) => [k, v.value]))
    const before = Object.fromEntries(Object.entries(item.context).filter(([k]) => k in after).map(([k, v]) => [k, v.value]))
    return { before, after }
  }
  return { before: {}, after: Object.fromEntries(Object.entries(item.context).map(([k, v]) => [k, v.value])) }
}

export function DiffReview({ item, before, after, submit, onDone }: {
  item: ReviewItem
  before: Record<string, unknown>
  after: Record<string, unknown>
  submit: (input: MwSubmitStepInput) => Promise<MwSubmitResult>
  onDone?: (result: MwSubmitResult) => void
}) {
  const { t, i18n } = useTranslation()
  const rows = diffRows(before, after)
  const changed = rows.filter(r => r.changed).length
  const { approve, sendBack } = reviewOutcomes(item.outcomes.length ? item.outcomes : ['approved'])
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<MwSubmitResult | null>(null)
  const done = !!result?.applied
  const send = async (outcome: string) => {
    if (outcome === sendBack && !comment.trim()) { setCommentError(t('memwise.inbox.commentRequired')); return }
    setCommentError(undefined)
    setBusy(outcome)
    try {
      const r = await submit({ stepRunId: item.stepRunId, outcome, ...(item.kind === 'input' && outcome === approve ? { values: after } : {}), comment: comment.trim() || undefined })
      setResult(r)
      if (r.applied) onDone?.(r)
    } catch (err) {
      setResult({ applied: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-4" data-diff-review>
      <Info_Section title={t('memwise.review.diffTitle')} description={t('memwise.review.diffChanged', { count: changed })}>
        <div className="overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.field')}</th>
                <th className="px-3.5 py-2 font-medium">{t('memwise.review.now')}</th>
                <th aria-hidden />
                <th className="px-3.5 py-2 font-medium">{t('memwise.review.after')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.field} className={cn('border-b border-separator last:border-0', r.changed && 'bg-accent-tint/30')} data-diff-field={r.field} data-changed={r.changed || undefined}>
                  <td className="px-3.5 py-2 text-secondary">{humanize(r.field)}</td>
                  <td className={cn('px-3.5 py-2', r.changed ? 'text-secondary line-through decoration-tertiary' : 'text-foreground')}>{formatValueInline(r.before, t, i18n.language)}</td>
                  <td className="text-tertiary">{r.changed && <ArrowRight className="size-3.5" />}</td>
                  <td className={cn('px-3.5 py-2', r.changed ? 'font-medium text-foreground' : 'text-secondary')}>{formatValueInline(r.after, t, i18n.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Info_Section>
      <div className="space-y-1.5">
        <label htmlFor="dr-comment" className="block text-label font-medium text-foreground">{t('memwise.inbox.comment')}<span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span></label>
        <Textarea id="dr-comment" value={comment} onChange={e => { setComment(e.target.value); setCommentError(undefined) }} rows={3} disabled={!!busy || done} />
        {commentError && <p className="text-label-sm text-destructive" role="alert">{commentError}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {sendBack && <Button variant="secondary" onClick={() => void send(sendBack)} disabled={!!busy || done}><Undo2 />{t('memwise.review.sendBack')}</Button>}
        {approve && <Button variant="primary" onClick={() => void send(approve)} disabled={!!busy || done} data-outcome={approve}>{busy === approve ? t('memwise.inbox.sending') : outcomeLabel(approve, t)}</Button>}
      </div>
      {result && !result.applied && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.inbox.notApplied')}</Info_Alert.Title>
          {(result.code || result.message) && <Info_Alert.Description>{resultMessage(result, t)}</Info_Alert.Description>}
        </Info_Alert>
      )}
    </div>
  )
}
