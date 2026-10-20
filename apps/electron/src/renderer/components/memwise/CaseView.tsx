/**
 * The case view: header (title, playbook, current step, status or stop reason), the case's
 * fields with provenance badges, the map with this case's path, and a timeline of step
 * records. Presentational; the step record opens through `onOpenStep`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bot, Briefcase, CheckCircle2, Clock, FileWarning, MessageSquare, Settings2, User } from 'lucide-react'
import type { MwCase, MwPlaybook, MwRole, MwStepRunSummary } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CaseFieldList } from './CaseValues'
import { WorkflowMap } from './map'
import {
  absoluteTime,
  caseStatusLabel,
  outcomeLabel,
  personName,
  relativeTime,
  stepStatusLabel,
  waitingOnLabel,
  type PeopleById,
} from './format'

export interface CaseViewProps {
  kase: MwCase
  playbook?: MwPlaybook | null
  playbookTitle?: string
  people?: PeopleById
  roles?: MwRole[]
  onOpenStep?: (stepRunId: string) => void
  onOpenPlaybook?: (workflowId: string) => void
  onOpenChat?: () => void
  now?: number
}

const STATUS_COLOR = { active: 'default', done: 'success', stopped: 'destructive' } as const

export function CaseView({ kase, playbook, playbookTitle, people = {}, roles, onOpenStep, onOpenPlaybook, onOpenChat, now }: CaseViewProps) {
  const { t, i18n } = useTranslation()
  const waiting = waitingOnLabel(kase, t, roles)
  const title = playbookTitle ?? playbook?.title ?? kase.workflowId

  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Briefcase className="size-4" /></div>}
        title={kase.title}
        meta={
          <>
            <Info_Badge color={STATUS_COLOR[kase.status]} dot>{caseStatusLabel(kase.status, t)}</Info_Badge>
            <button type="button" className="hover:underline" onClick={() => onOpenPlaybook?.(kase.workflowId)}>
              {title}
            </button>
            <span>{t('memwise.case.currentStep', { step: kase.stateTitle })}</span>
            {waiting && <span>{waiting}</span>}
          </>
        }
        actions={onOpenChat ? (
          <Button variant="secondary" size="sm" onClick={onOpenChat}>
            <MessageSquare />
            {t('memwise.case.openChat')}
          </Button>
        ) : undefined}
      />

      {kase.status === 'stopped' && (
        <Info_Alert variant="error" icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.case.stopped')}</Info_Alert.Title>
          {kase.stopReason && <Info_Alert.Description>{kase.stopReason}</Info_Alert.Description>}
        </Info_Alert>
      )}

      <Info_Section title={t('memwise.case.fields')} count={Object.keys(kase.values).length}>
        <CaseFieldList values={kase.values} fields={kase.fields} people={people} />
      </Info_Section>

      <Info_Section title={t('memwise.case.map')} description={t('memwise.case.mapDescription')}>
        {playbook ? (
          <div className="overflow-x-auto p-3">
            <WorkflowMap
              playbook={playbook}
              mode="design"
              highlightPath={kase.path}
              roles={roles}
              onSelectState={stateId => {
                const run = [...kase.timeline].reverse().find(s => s.stepId === stateId)
                if (run) onOpenStep?.(run.stepRunId)
              }}
            />
          </div>
        ) : (
          <p className="px-3.5 py-3 text-label text-tertiary" data-map-placeholder>
            {kase.path.join(' → ')}
          </p>
        )}
      </Info_Section>

      <Info_Section title={t('memwise.case.timeline')} count={kase.timeline.length}>
        {kase.timeline.length === 0 ? (
          <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.case.noSteps')}</p>
        ) : (
          <ol className="divide-y divide-separator">
            {kase.timeline.map(step => (
              <TimelineRow
                key={step.stepRunId}
                step={step}
                people={people}
                onOpen={onOpenStep ? () => onOpenStep(step.stepRunId) : undefined}
                now={now}
                locale={i18n.language}
              />
            ))}
          </ol>
        )}
      </Info_Section>

      <p className="text-label-sm text-tertiary">
        {t('memwise.case.startedAt', { time: absoluteTime(kase.createdAt, i18n.language) })}
        {' · '}
        {t('memwise.case.updatedAt', { time: relativeTime(kase.updatedAt, now, i18n.language) })}
      </p>
    </Info_Page.Content>
  )
}

const PERFORMER_ICON = {
  agent: Bot,
  person: User,
  external: User,
  system: Settings2,
} as const

function StepStatusIcon({ status }: { status: MwStepRunSummary['status'] }) {
  switch (status) {
    case 'completed': return <CheckCircle2 className="size-4 text-success" />
    case 'failed':
    case 'needs_person': return <AlertTriangle className="size-4 text-destructive" />
    default: return <Clock className="size-4 text-info" />
  }
}

function TimelineRow({ step, people, onOpen, now, locale }: {
  step: MwStepRunSummary
  people: PeopleById
  onOpen?: () => void
  now?: number
  locale?: string
}) {
  const { t } = useTranslation()
  const Performer = PERFORMER_ICON[step.performer]
  const by = personName(step.decidedBy, people)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        data-step-run={step.stepRunId}
        className={cn(
          'flex w-full items-start gap-3 px-3.5 py-2.5 text-left',
          onOpen && 'hover:bg-fill-hover transition-[background-color] duration-micro',
        )}
      >
        <span className="mt-0.5 shrink-0"><StepStatusIcon status={step.status} /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label">
            <span className="font-medium text-foreground">{step.title}</span>
            {step.attempt > 1 && <span className="text-label-sm text-tertiary">{t('memwise.step.attempt', { attempt: step.attempt })}</span>}
            {step.tainted && (
              <Info_Badge color="warning" icon={<FileWarning className="size-3" />}>{t('memwise.step.readDocuments')}</Info_Badge>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-label-sm text-secondary">
            <Performer className="size-3.5" />
            <span>{step.outcome ? outcomeLabel(step.outcome, t) : stepStatusLabel(step.status, t)}</span>
            {by && <span>{t('memwise.step.decidedBy', { name: by })}</span>}
            <span className="text-tertiary" title={absoluteTime(step.startedAt, locale)}>{relativeTime(step.finishedAt ?? step.startedAt, now, locale)}</span>
          </span>
          {(step.rationale || step.comment) && (
            <span className="mt-1 block text-label-sm text-secondary line-clamp-2">{step.comment ?? step.rationale}</span>
          )}
        </span>
      </button>
    </li>
  )
}
