/**
 * A step record: outcome, rationale, outputs with provenance, checkpoint results, the tool
 * and model calls (collapsible), usage and taint; plus "Ask about this step" (explain) and
 * "Open in chat". Presentational; StepRecordDrawer wires it to the API.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, ChevronRight, FileWarning, MessageSquare, Send, XCircle } from 'lucide-react'
import type { MwExplanation, MwJournalEntry, MwStepRecord } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Markdown } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { CaseFieldList } from './CaseValues'
import {
  absoluteTime,
  formatDuration,
  humanize,
  outcomeLabel,
  personName,
  stepStatusLabel,
  toolLabel,
  type PeopleById,
} from './format'

export interface StepRecordViewProps {
  record: MwStepRecord
  people?: PeopleById
  /** Answers asked so far in this drawer, oldest first. */
  explanations?: MwExplanation[]
  onAsk?: (question: string) => void
  asking?: boolean
  askError?: string | null
  onOpenChat?: () => void
}

export function StepRecordView({ record, people = {}, explanations = [], onAsk, asking, askError, onOpenChat }: StepRecordViewProps) {
  const { t, i18n } = useTranslation()
  const toolCalls = record.journal.filter(j => j.kind === 'tool' || j.kind === 'approval')
  const modelCalls = record.journal.filter(j => j.kind === 'model')
  const other = record.journal.filter(j => !['tool', 'approval', 'model'].includes(j.kind))
  const by = personName(record.decidedBy, people)
  const usage = record.usage

  return (
    <div className="space-y-5" data-step-record={record.stepRunId}>
      <div className="flex flex-wrap items-center gap-2 text-label-sm text-secondary">
        <Info_Badge color={record.status === 'completed' ? 'success' : record.status === 'failed' || record.status === 'needs_person' ? 'destructive' : 'default'} dot>
          {record.outcome ? outcomeLabel(record.outcome, t) : stepStatusLabel(record.status, t)}
        </Info_Badge>
        {record.attempt > 1 && <span>{t('memwise.step.attempt', { attempt: record.attempt })}</span>}
        {by && <span>{t('memwise.step.decidedBy', { name: by })}</span>}
        <span>{absoluteTime(record.startedAt, i18n.language)}</span>
      </div>

      {record.tainted && (
        <Info_Alert variant="info" inline icon={<FileWarning />}>
          <Info_Alert.Title>{t('memwise.step.taintedTitle')}</Info_Alert.Title>
          <Info_Alert.Description>{t('memwise.step.taintedDescription')}</Info_Alert.Description>
        </Info_Alert>
      )}

      {(record.rationale || record.comment) && (
        <Info_Section title={record.comment ? t('memwise.step.comment') : t('memwise.step.rationale')}>
          <p className="px-3.5 py-2.5 text-label whitespace-pre-wrap">{record.comment ?? record.rationale}</p>
        </Info_Section>
      )}

      <Info_Section title={t('memwise.step.outputs')} count={Object.keys(record.outputs).length}>
        <CaseFieldList values={record.outputs} people={people} />
      </Info_Section>

      {record.checkpoint.length > 0 && (
        <Info_Section title={t('memwise.step.checkpoint')}>
          <ul className="divide-y divide-separator">
            {record.checkpoint.map((c, i) => (
              <li key={i} className="flex items-start gap-2.5 px-3.5 py-2.5 text-label">
                {c.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-foreground">{c.rule}</span>
                  {c.reason && <span className="block text-label-sm text-secondary">{c.reason}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      {record.context && Object.keys(record.context.pushed).length > 0 && (
        <CollapsibleBlock title={t('memwise.step.whatItSaw')} count={Object.keys(record.context.pushed).length}>
          <CaseFieldList values={record.context.pushed} people={people} />
        </CollapsibleBlock>
      )}

      {toolCalls.length > 0 && (
        <CollapsibleBlock title={t('memwise.step.toolCalls')} count={toolCalls.length}>
          <JournalList entries={toolCalls} />
        </CollapsibleBlock>
      )}
      {modelCalls.length > 0 && (
        <CollapsibleBlock title={t('memwise.step.modelCalls')} count={modelCalls.length}>
          <JournalList entries={modelCalls} />
        </CollapsibleBlock>
      )}
      {other.length > 0 && (
        <CollapsibleBlock title={t('memwise.step.otherEntries')} count={other.length}>
          <JournalList entries={other} />
        </CollapsibleBlock>
      )}

      <Info_Section title={t('memwise.step.usage')}>
        <Info_Table>
          {usage.modelCalls !== undefined && <Info_Table.Row label={t('memwise.step.usageModelCalls')} value={String(usage.modelCalls)} />}
          {usage.tokens !== undefined && <Info_Table.Row label={t('memwise.step.usageTokens')} value={new Intl.NumberFormat(i18n.language).format(usage.tokens)} />}
          {usage.durationMs !== undefined && <Info_Table.Row label={t('memwise.step.usageTime')} value={formatDuration(usage.durationMs)} />}
          {usage.costUsd !== undefined && (
            <Info_Table.Row label={t('memwise.step.usageCost')} value={new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(usage.costUsd)} />
          )}
          {record.modelRole && <Info_Table.Row label={t('memwise.step.modelRole')} value={humanize(record.modelRole)} />}
        </Info_Table>
      </Info_Section>

      <AskAboutStep explanations={explanations} onAsk={onAsk} asking={asking} error={askError} onOpenChat={onOpenChat} />
    </div>
  )
}

function CollapsibleBlock({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-label-sm font-semibold text-secondary hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {title}
        {count !== undefined && <span className="font-normal text-tertiary tabular-nums">{count}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 overflow-hidden rounded-lg bg-raised shadow-elev-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function preview(v: unknown): string {
  if (v === undefined) return ''
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s
  } catch {
    return String(v)
  }
}

function JournalList({ entries }: { entries: MwJournalEntry[] }) {
  const { t } = useTranslation()
  return (
    <ul className="divide-y divide-separator">
      {entries.map(e => (
        <li key={e.key} className="px-3.5 py-2.5 text-label" data-journal={e.key}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{e.kind === 'tool' ? toolLabel(e.name) : humanize(e.name)}</span>
            {e.kind === 'tool' && <span className="font-mono text-label-sm text-tertiary">{e.name}</span>}
            {e.durationMs !== undefined && <span className="text-label-sm text-tertiary">{formatDuration(e.durationMs)}</span>}
            {e.error && <Info_Badge color="destructive">{t('memwise.step.callFailed')}</Info_Badge>}
          </div>
          {e.error && <p className="mt-1 text-label-sm text-destructive">{e.error}</p>}
          {(e.request !== undefined || e.response !== undefined) && (
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              {e.request !== undefined && (
                <pre className="max-h-48 overflow-auto rounded-sm bg-fill-hover p-2 text-[11px] leading-4 whitespace-pre-wrap">{preview(e.request)}</pre>
              )}
              {e.response !== undefined && (
                <pre className="max-h-48 overflow-auto rounded-sm bg-fill-hover p-2 text-[11px] leading-4 whitespace-pre-wrap">{preview(e.response)}</pre>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function AskAboutStep({ explanations, onAsk, asking, error, onOpenChat }: {
  explanations: MwExplanation[]
  onAsk?: (q: string) => void
  asking?: boolean
  error?: string | null
  onOpenChat?: () => void
}) {
  const { t } = useTranslation()
  const [question, setQuestion] = React.useState('')
  const ask = (q: string) => {
    const text = q.trim()
    if (!text || !onAsk || asking) return
    onAsk(text)
    setQuestion('')
  }
  const suggestion = t('memwise.step.suggestFlagged')
  return (
    <section className="space-y-2" data-ask>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-label-sm font-semibold text-secondary">{t('memwise.step.askTitle')}</h3>
        {onOpenChat && (
          <Button variant="ghost" size="sm" onClick={onOpenChat}>
            <MessageSquare />
            {t('memwise.step.openInChat')}
          </Button>
        )}
      </div>
      {explanations.map(ex => (
        <div key={ex.id} className="space-y-2 rounded-lg bg-raised p-3.5 shadow-elev-1" data-explanation={ex.id}>
          <p className="text-label font-medium text-foreground">{ex.question}</p>
          <div className="text-label">
            <Markdown mode="minimal">{ex.answer}</Markdown>
          </div>
          {!ex.grounded && <p className="text-label-sm text-info">{t('memwise.step.notGrounded')}</p>}
          {ex.cites.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-label-sm text-tertiary">{t('memwise.step.sources')}</span>
              {ex.cites.map(c => (
                <Info_Badge key={`${c.kind}:${c.ref}`} color="muted" title={c.ref}>{c.label}</Info_Badge>
              ))}
            </div>
          )}
        </div>
      ))}
      {onAsk && (
        <div className="space-y-2">
          {explanations.length === 0 && (
            <button
              type="button"
              className="inline-flex h-6 items-center rounded-full bg-fill-hover px-2.5 text-label-sm text-foreground hover:bg-fill-pressed"
              onClick={() => ask(suggestion)}
              disabled={asking}
            >
              {suggestion}
            </button>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  ask(question)
                }
              }}
              placeholder={t('memwise.step.askPlaceholder')}
              rows={2}
              disabled={asking}
              className="flex-1"
            />
            <Button variant="primary" size="icon" onClick={() => ask(question)} disabled={asking || !question.trim()} aria-label={t('memwise.step.ask')}>
              <Send />
            </Button>
          </div>
          {asking && <p className="text-label-sm text-tertiary">{t('memwise.step.thinking')}</p>}
          {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
        </div>
      )}
    </section>
  )
}
