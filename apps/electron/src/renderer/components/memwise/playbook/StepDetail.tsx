import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Bell, CheckSquare, CornerDownLeft, Hourglass } from 'lucide-react'
import type { MwPlaybook, MwRole, MwState, MwStep } from '@memwise/shared/protocol'
import { Markdown } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { EffectivePolicyView } from './EffectivePolicyView'
import { EffectBadge, PerformerTag, Pill } from './Tags'
import { humanize, nextLines, performerLabel, readType, toolTreatment } from './labels'

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)}>
      <h4 className="text-label-sm font-medium text-tertiary">{title}</h4>
      {children}
    </section>
  )
}

function FieldChip({ name, type }: { name: string; type?: string }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1.5 rounded-sm bg-fill-hover px-1.5 py-0.5 text-label">
      <span className="text-foreground">{humanize(name)}</span>
      {type && <span className="truncate text-label-sm text-tertiary">{type}</span>}
    </span>
  )
}

/** What the step reads from the case and what it writes back. */
export function StepFields({ step, playbook }: { step: MwStep; playbook?: MwPlaybook }) {
  const { t } = useTranslation()
  if (!step.reads.length && !step.writes.length) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {step.reads.length > 0 && (
        <Section title={t('memwise.playbook.reads')}>
          <div className="flex flex-wrap gap-1">
            {step.reads.map((r) => (
              <FieldChip key={r} name={r} type={readType(playbook, r)} />
            ))}
          </div>
        </Section>
      )}
      {step.writes.length > 0 && (
        <Section title={t('memwise.playbook.writes')}>
          <div className="flex flex-wrap gap-1">
            {step.writes.map((f) => (
              <FieldChip key={f.name} name={f.name} type={f.type} />
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

/** Tools the step may use, with what each can do and whether it needs a person's approval. */
export function StepTools({ step }: { step: MwStep }) {
  const { t } = useTranslation()
  if (!step.tools.length) return null
  return (
    <Section title={t('memwise.playbook.tools.title')}>
      <ul className="flex flex-col gap-1">
        {step.tools.map((tool) => {
          const treatment = toolTreatment(tool, step.policy)
          return (
            <li key={tool.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
              <span className="font-mono text-[12px] text-foreground" title={tool.description}>
                {tool.name}
              </span>
              <EffectBadge effect={tool.effect} classified={tool.classified} />
              {tool.required && <Pill className="bg-fill-selected text-secondary">{t('memwise.playbook.tools.required')}</Pill>}
              {treatment === 'approve' && <Pill className="border border-info/40 text-info">{t('memwise.playbook.tools.needsApproval')}</Pill>}
              {treatment === 'preview' && <Pill className="border border-info/40 text-info">{t('memwise.playbook.tools.preview')}</Pill>}
              {treatment === 'deny' && <Pill className="border border-destructive/40 text-destructive">{t('memwise.playbook.tools.denied')}</Pill>}
              {tool.description && <span className="min-w-0 text-label-sm text-tertiary">{tool.description}</span>}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** Checkpoint rules: what must hold before the step's outcome counts. */
export function StepCheckpoint({ step }: { step: MwStep }) {
  const { t } = useTranslation()
  if (!step.checkpoint.length) return null
  return (
    <Section title={t('memwise.playbook.checkpoint')}>
      <ul className="flex flex-col gap-1">
        {step.checkpoint.map((rule) => (
          <li key={rule} className="flex items-start gap-2 text-label text-secondary">
            <CheckSquare className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
            <span>{rule}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** "What happens next": each outcome and wait in words. */
export function StepNext({ playbook, state }: { playbook: MwPlaybook; state: MwState }) {
  const { t, i18n } = useTranslation()
  const lines = nextLines(playbook, state, t, i18n.resolvedLanguage)
  if (!lines.length) return null
  return (
    <Section title={t('memwise.playbook.next.title')}>
      <ul className="flex flex-col gap-1">
        {lines.map((line, i) => {
          const Icon = line.kind === 'remind' ? Bell : line.kind === 'timeout' ? Hourglass : line.back ? CornerDownLeft : ArrowRight
          return (
            <li key={i} className="flex items-start gap-2 text-label text-secondary">
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', line.back ? 'text-info' : 'text-tertiary')} aria-hidden />
              <span>{line.text}</span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

export interface StepDetailProps {
  step: MwStep
  /** The playbook the step belongs to: adds field types and "what happens next". */
  playbook?: MwPlaybook
  roles?: MwRole[]
  /**
   * Inside the playbook view the step's title, instructions, fields, tools and next steps are
   * already on the page; embedded shows only the effective policy and the step's settings.
   */
  embedded?: boolean
  className?: string
}

export function StepDetail({ step, playbook, roles, embedded = false, className }: StepDetailProps) {
  const { t } = useTranslation()
  const state = playbook?.states.find((s) => s.stepId === step.id || s.id === step.id)
  const performer = performerLabel(step, state, t, roles)
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {!embedded && (
        <>
          <header className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <PerformerTag performer={performer} />
              {performer.note && <span className="text-label-sm text-tertiary">{performer.note}</span>}
            </div>
            <h3 className="text-copy-lg font-semibold text-foreground">{step.title}</h3>
          </header>
          {step.instructions.trim() && (
            <div className="text-label-lg text-secondary">
              <Markdown mode="minimal">{step.instructions}</Markdown>
            </div>
          )}
          <StepFields step={step} playbook={playbook} />
          <StepTools step={step} />
          <StepCheckpoint step={step} />
          {playbook && state && <StepNext playbook={playbook} state={state} />}
        </>
      )}
      <Section title={t('memwise.playbook.policy.title')}>
        <EffectivePolicyView rules={step.policy} />
      </Section>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-label">
        <dt className="text-tertiary">{t('memwise.playbook.strictness.label')}</dt>
        <dd className="text-secondary">{t(`memwise.playbook.strictness.${step.strictness}`)}</dd>
        {step.modelRole && (
          <>
            <dt className="text-tertiary">{t('memwise.playbook.modelRole')}</dt>
            <dd className="text-secondary">{step.modelRole}</dd>
          </>
        )}
        {step.outcomes.length > 0 && (
          <>
            <dt className="text-tertiary">{t('memwise.playbook.outcomes')}</dt>
            <dd className="text-secondary">{step.outcomes.map(humanize).join(', ')}</dd>
          </>
        )}
        <dt className="text-tertiary">{t('memwise.playbook.file')}</dt>
        <dd className="break-all font-mono text-[12px] text-tertiary">{step.file}</dd>
      </dl>
    </div>
  )
}
