import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Hourglass, XCircle } from 'lucide-react'
import type { MwDiagnostic, MwPlaybook, MwRole, MwState } from '@memwise/shared/protocol'
import { Markdown } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { StepCheckpoint, StepDetail, StepFields, StepNext, StepTools } from './StepDetail'
import { PerformerTag } from './Tags'
import { performerLabel, stateTitle, stepOf } from './labels'

export interface PlaybookViewProps {
  playbook: MwPlaybook
  /** Called when a step is opened (its title clicked or its details shown). */
  onSelectStep?: (stepId: string) => void
  /** Role titles for assignee tags; ids are shown in plain words without it. */
  roles?: MwRole[]
  /** A short "what this playbook does" line; a summary is made from the steps without it. */
  description?: string
  /** Highlights a step and shows its details. */
  selectedStepId?: string
  /** Replaces the plain "Version N" (the playbook page shows who published it, and the other versions). */
  versionLine?: React.ReactNode
  className?: string
}

function Diagnostics({ diagnostics }: { diagnostics: MwDiagnostic[] }) {
  const { t } = useTranslation()
  if (!diagnostics.length) return null
  return (
    <div role="status" className="flex flex-col gap-1 rounded-lg border border-info/30 bg-info-tint px-3 py-2">
      <div className="text-label-sm font-medium text-info">{t('memwise.playbook.diagnostics', { count: diagnostics.length })}</div>
      <ul className="flex flex-col gap-0.5">
        {diagnostics.map((d, i) => {
          const Icon = d.severity === 'error' ? XCircle : AlertTriangle
          return (
            <li key={`${d.code}-${i}`} className="flex items-start gap-2 text-label text-secondary">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', d.severity === 'error' ? 'text-destructive' : 'text-info')} aria-hidden />
              <span className="min-w-0">
                {d.message}
                {d.file && (
                  <span className="ml-1.5 font-mono text-[11px] text-tertiary">
                    {d.file}
                    {d.line !== undefined ? `:${d.line}` : ''}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function WaitEntry({ playbook, state, roles }: { playbook: MwPlaybook; state: MwState; roles?: MwRole[] }) {
  const { t } = useTranslation()
  const performer = performerLabel(undefined, state, t, roles)
  return (
    <li className="flex gap-4">
      <span className="flex w-7 shrink-0 justify-center pt-0.5 text-tertiary" aria-hidden>
        <Hourglass className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label font-medium text-foreground">{stateTitle(playbook, state.id, t)}</span>
          <PerformerTag performer={performer} />
        </div>
        <p className="text-label text-tertiary">{t('memwise.playbook.waitState', { role: performer.label })}</p>
        <StepNext playbook={playbook} state={state} />
      </div>
    </li>
  )
}

function StepEntry({
  playbook,
  state,
  number,
  roles,
  open,
  selected,
  onToggle,
  onSelect,
}: {
  playbook: MwPlaybook
  state: MwState
  number: number
  roles?: MwRole[]
  open: boolean
  selected: boolean
  onToggle: () => void
  onSelect?: () => void
}) {
  const { t } = useTranslation()
  const step = stepOf(playbook, state)!
  const performer = performerLabel(step, state, t, roles)
  const detailsId = React.useId()
  return (
    <li className="flex gap-4">
      <span className="w-7 shrink-0 text-right font-serif text-[24px] leading-7 text-tertiary tabular-nums" aria-hidden>
        {number}
      </span>
      <article
        aria-label={t('memwise.playbook.stepNumber', { number, title: step.title })}
        className={cn('flex min-w-0 flex-1 flex-col gap-3 rounded-lg px-3 py-2.5 -mx-3 -my-2.5', selected && 'bg-fill-hover')}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <PerformerTag performer={performer} />
            {performer.note && <span className="text-label-sm text-tertiary">{performer.note}</span>}
          </div>
          {onSelect ? (
            <button type="button" onClick={onSelect} className="self-start text-left text-copy-lg font-semibold text-foreground hover:underline focus-visible:underline focus-visible:outline-none">
              {step.title}
            </button>
          ) : (
            <h3 className="text-copy-lg font-semibold text-foreground">{step.title}</h3>
          )}
        </div>
        {step.instructions.trim() && (
          <div className="text-label-lg text-secondary">
            <Markdown mode="minimal">{step.instructions}</Markdown>
          </div>
        )}
        <StepFields step={step} playbook={playbook} />
        <StepTools step={step} />
        <StepCheckpoint step={step} />
        <StepNext playbook={playbook} state={state} />
        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={onToggle}
            className="inline-flex h-control-sm items-center gap-1 rounded-sm px-1.5 -ml-1.5 text-label text-secondary hover:bg-fill-hover hover:text-foreground"
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
            {open ? t('memwise.playbook.hideRules') : t('memwise.playbook.showRules')}
          </button>
          {open && (
            <div id={detailsId} className="mt-2">
              <StepDetail step={step} playbook={playbook} roles={roles} embedded />
            </div>
          )}
        </div>
      </article>
    </li>
  )
}

/** The playbook read as a document: numbered steps, who does each, and what happens next. */
export function PlaybookView({ playbook, onSelectStep, roles, description, selectedStepId, versionLine, className }: PlaybookViewProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(selectedStepId ? [selectedStepId] : []))
  React.useEffect(() => {
    if (selectedStepId) setOpen((prev) => (prev.has(selectedStepId) ? prev : new Set(prev).add(selectedStepId)))
  }, [selectedStepId])

  const stepStates = playbook.states.filter((s) => stepOf(playbook, s))
  const first = stepStates[0]
  const last = stepStates[stepStates.length - 1]
  const summary =
    description ??
    (first && last
      ? t('memwise.playbook.summary', { first: stateTitle(playbook, first.id, t), last: stateTitle(playbook, last.id, t) })
      : t('memwise.playbook.noSteps'))

  let number = 0
  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-title font-semibold tracking-[var(--tracking-title)] text-foreground">{playbook.title}</h2>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-sm text-tertiary">
            {versionLine ?? <span>{t('memwise.playbook.version', { version: playbook.version })}</span>}
            {/* Kept together so a narrow panel wraps the count as a whole instead of squeezing it into a column. */}
            <span className="whitespace-nowrap"><span aria-hidden>·</span> {t('memwise.playbook.stepCount', { count: stepStates.length })}</span>
          </span>
        </div>
        <p className="text-copy text-secondary">{summary}</p>
      </header>
      <Diagnostics diagnostics={playbook.diagnostics} />
      <ol className="flex flex-col gap-7">
        {playbook.states.map((state) => {
          const step = stepOf(playbook, state)
          if (!step) return <WaitEntry key={state.id} playbook={playbook} state={state} roles={roles} />
          number += 1
          const isOpen = open.has(step.id)
          return (
            <StepEntry
              key={state.id}
              playbook={playbook}
              state={state}
              number={number}
              roles={roles}
              open={isOpen}
              selected={selectedStepId === step.id}
              onSelect={onSelectStep ? () => onSelectStep(step.id) : undefined}
              onToggle={() => {
                setOpen((prev) => {
                  const next = new Set(prev)
                  if (next.has(step.id)) next.delete(step.id)
                  else next.add(step.id)
                  return next
                })
                if (!isOpen) onSelectStep?.(step.id)
              }}
            />
          )
        })}
      </ol>
    </div>
  )
}
