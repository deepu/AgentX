/**
 * Table review (24 §11, `review.kind: table`): the rows a step proposes, each with accept, edit
 * and reject and the agent's reason; "Accept all at 90% or higher"; a comment; then approve with
 * the accepted rows (edited as changed) or send the list back.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, CheckCheck, Pencil, Undo2, X } from 'lucide-react'
import type { MwInboxItem, MwSubmitResult, MwSubmitStepInput } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { humanize, outcomeLabel, resultMessage } from '../format'
import { Pill } from '../playbook/Tags'
import { acceptAllAbove, editedCell, enumChoices, formatRowCell, orderRowColumns, reviewOutcomes, statusLabel, tableColumns, tableRows, tableSubmission, type RowDecision } from './record-model'

type ReviewItem = Extract<MwInboxItem, { kind: 'input' | 'decision' }>

export interface TableReviewProps {
  item: ReviewItem
  /** Submits the step (through the sign gate when the step signs). */
  submit: (input: MwSubmitStepInput) => Promise<MwSubmitResult>
  onDone?: (result: MwSubmitResult) => void
}

export function TableReview({ item, submit, onDone }: TableReviewProps) {
  const { t, i18n } = useTranslation()
  const field = item.review?.kind === 'table' ? item.review.items : ''
  const source = item.kind === 'input' ? item.prefill[field] : item.context[field]
  const rows = React.useMemo(() => tableRows(source), [source])
  const columns = React.useMemo(() => orderRowColumns(tableColumns(rows), rows.map(r => r.value), source?.itemTypes, source?.refTitles), [rows, source])
  const [decisions, setDecisions] = React.useState<Record<number, RowDecision>>({})
  const [edits, setEdits] = React.useState<Record<number, Record<string, unknown>>>({})
  const [editing, setEditing] = React.useState<number | null>(null)
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<MwSubmitResult | null>(null)
  const { approve, sendBack } = reviewOutcomes(item.outcomes.length ? item.outcomes : ['approved'])
  const { pending, values } = tableSubmission(rows, decisions, edits)
  const done = !!result?.applied
  const highCount = rows.filter(r => (decisions[r.index] ?? 'pending') === 'pending' && (r.confidence ?? 0) >= 0.9).length

  const set = (index: number, d: RowDecision) => setDecisions(prev => ({ ...prev, [index]: prev[index] === d ? 'pending' : d }))
  const send = async (outcome: string) => {
    if (outcome === sendBack && !comment.trim()) { setCommentError(t('memwise.inbox.commentRequired')); return }
    setCommentError(undefined)
    setBusy(outcome)
    try {
      const r = await submit({
        stepRunId: item.stepRunId,
        outcome,
        ...(outcome === approve ? { values: { [field]: values } } : {}),
        comment: comment.trim() || undefined,
      })
      setResult(r)
      if (r.applied) onDone?.(r)
    } catch (err) {
      setResult({ applied: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4" data-table-review={field}>
      <Info_Section
        title={humanize(field)}
        count={rows.length}
        description={t('memwise.review.tableHint')}
        actions={highCount > 0 && !done ? (
          <Button size="sm" variant="ghost" onClick={() => setDecisions(d => acceptAllAbove(rows, d, 0.9))} data-action="accept-high">
            <CheckCheck />
            {t('memwise.review.acceptAllHigh', { count: highCount })}
          </Button>
        ) : undefined}
      >
        <ul className="divide-y divide-separator">
          {rows.map(r => {
            const d = decisions[r.index] ?? 'pending'
            const value = { ...r.value, ...(edits[r.index] ?? {}) }
            return (
              <li key={r.index} className={cn('px-3.5 py-2.5', d === 'reject' && 'opacity-60')} data-row={r.index} data-decision={d}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    {editing === r.index ? (
                      <div className="grid gap-1.5 sm:grid-cols-2">
                        {columns.map(c => {
                          const type = source?.itemTypes?.[c]
                          const choices = enumChoices(type)
                          const setCell = (v: unknown) => setEdits(prev => ({ ...prev, [r.index]: { ...(prev[r.index] ?? {}), [c]: v } }))
                          const text = value[c] === null || value[c] === undefined ? '' : String(value[c])
                          return (
                            <label key={c} className="text-label-sm text-secondary">
                              {humanize(c)}
                              {choices ? (
                                // A choice column picks from its choices, by their labels
                                <select className="mt-0.5 block h-7 w-full rounded-md bg-fill-hover px-2 text-label text-foreground" value={text} onChange={e => setCell(e.target.value)} data-choice={c}>
                                  {!choices.includes(text) && <option value={text}>{text}</option>}
                                  {choices.map(o => <option key={o} value={o}>{statusLabel(o)}</option>)}
                                </select>
                              ) : (
                                <Input className="mt-0.5 h-7" value={text} onChange={e => setCell(editedCell(type, e.target.value))} />
                              )}
                            </label>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-x-3 text-label">
                        {columns.map((c, i) => (
                          <span key={c} className={i === 0 ? 'font-medium text-foreground' : 'text-secondary'}>
                            {i > 0 && <span className="text-tertiary">{humanize(c)}: </span>}
                            {formatRowCell(c, value[c], t, i18n.language, source?.itemTypes, source?.refTitles)}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.why && <p className="text-label-sm text-tertiary" data-why>{t('memwise.review.why', { why: r.why })}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {r.confidence !== undefined && <Pill className={r.confidence >= 0.9 ? 'bg-success-tint text-success' : r.confidence >= 0.7 ? 'bg-fill-hover text-secondary' : 'bg-accent-tint text-accent'}>{Math.round(r.confidence * 100)}%</Pill>}
                    <Button size="icon-sm" variant={d === 'accept' ? 'secondary' : 'ghost'} onClick={() => set(r.index, 'accept')} disabled={done} aria-pressed={d === 'accept'} aria-label={t('memwise.review.accept')} data-action="accept"><Check /></Button>
                    <Button size="icon-sm" variant={editing === r.index ? 'secondary' : 'ghost'} onClick={() => { setEditing(editing === r.index ? null : r.index); setDecisions(prev => ({ ...prev, [r.index]: 'accept' })) }} disabled={done} aria-label={t('memwise.review.edit')} data-action="edit"><Pencil /></Button>
                    <Button size="icon-sm" variant={d === 'reject' ? 'secondary' : 'ghost'} onClick={() => set(r.index, 'reject')} disabled={done} aria-pressed={d === 'reject'} aria-label={t('memwise.review.reject')} data-action="reject"><X /></Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </Info_Section>
      <div className="space-y-1.5">
        <label htmlFor="tr-comment" className="block text-label font-medium text-foreground">{t('memwise.inbox.comment')}<span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span></label>
        <Textarea id="tr-comment" value={comment} onChange={e => { setComment(e.target.value); setCommentError(undefined) }} rows={3} disabled={!!busy || done} />
        {commentError && <p className="text-label-sm text-destructive" role="alert">{commentError}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {pending > 0 && <span className="mr-auto text-label-sm text-tertiary" data-pending={pending}>{t('memwise.review.rowsPending', { count: pending })}</span>}
        {sendBack && <Button variant="secondary" onClick={() => void send(sendBack)} disabled={!!busy || done}><Undo2 />{t('memwise.review.sendBack')}</Button>}
        {approve && (
          <Button variant="primary" onClick={() => void send(approve)} disabled={!!busy || done || pending > 0} data-outcome={approve}>
            {busy === approve ? t('memwise.inbox.sending') : t('memwise.review.approveRows', { label: outcomeLabel(approve, t), count: values.length })}
          </Button>
        )}
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
