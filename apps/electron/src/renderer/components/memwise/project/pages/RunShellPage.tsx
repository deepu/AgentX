/**
 * A run's page in the project shell (doc 26 §2, mock `Run`): the playbook's steps as a timeline,
 * each with who did it and when, and the step waiting for the person open in place: its form or
 * approval is the inbox item's own body (`InboxItemView`), answered right here.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { Check, Circle, CircleAlert, Loader2 } from 'lucide-react'
import type { MwCase, MwInboxItem, MwPlaybook, MwRole } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseInboxAtom, memwisePeopleAtom, memwiseRolesAtom, memwiseStatusAtom } from '@/atoms/memwise'
import { useMemwiseCase, useMemwisePlaybook } from '@/hooks/useMemwise'
import { absoluteDate, absoluteTime, humanize, peopleById, personName, roleTitle } from '../../format'
import { InboxItemView } from '../../InboxItemView'
import { useInboxActions } from '../../MemwisePages'
import { useProjectShell } from '../shell-context'
import { ShellPageFrame } from '../WaitingPage'
import { runTimeline, whoDoes, type TimelineRow } from './every-page-model'
import { Tag } from './shell-ui'

export function RunShellPage({ caseId }: { caseId: string }) {
  const { t } = useTranslation()
  const { data: kase, error, reload } = useMemwiseCase(caseId)
  const { data: playbook } = useMemwisePlaybook(kase?.workflowId ?? null)
  const inbox = useAtomValue(memwiseInboxAtom)
  const shell = useProjectShell()
  if (!kase || !playbook) {
    return <div className="flex h-full items-center justify-center p-8 text-label text-tertiary">{error ?? t('memwise.entities.loading')}</div>
  }
  const rows = runTimeline(kase, playbook)
  const mine = (inbox ?? []).filter(i => i.caseId === kase.caseId)
  const waiting = rows.find(r => r.status === 'waiting')
  const project = shell?.projectId ?? ''

  return (
    <ShellPageFrame
      crumb={(
        <>
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate(routes.view.project(project, { type: 'playbook', workflowId: playbook.id }))}>{playbook.title}</button>
          {' '}<span className="text-tertiary">›</span> {t('memwise.everyPage.runs')} <span className="text-tertiary">›</span> {kase.title}
        </>
      )}
      title={t('memwise.everyPage.runTitle', { playbook: playbook.title, run: kase.title })}
      subtitle={(
        <span className="flex flex-wrap items-center gap-2">
          <RunTag kase={kase} waiting={waiting} mine={mine.length > 0} />
          <span>{t('memwise.everyPage.startedOn', { date: absoluteTime(kase.createdAt), version: kase.workflowVersion })}</span>
        </span>
      )}
    >
      <ol className="space-y-1" data-testid="run-timeline">
        {rows.map(r => (
          <TimelineItem key={r.state} row={r} kase={kase} playbook={playbook} item={r.status === 'waiting' ? pickItem(mine, r) : undefined} onAnswered={reload} />
        ))}
      </ol>
      {!waiting && kase.status === 'active' && kase.waiting && (
        <p className="mt-2 rounded-[10px] bg-fill-hover px-4 py-3 text-label text-secondary" data-testid="run-waiting-condition">
          {t('memwise.everyPage.waitingForCondition', { record: kase.waiting.record.title, condition: kase.waiting.condition })}
        </p>
      )}
    </ShellPageFrame>
  )
}

function pickItem(items: MwInboxItem[], row: TimelineRow): MwInboxItem | undefined {
  return items.find(i => 'stepRunId' in i && i.stepRunId === row.run?.stepRunId) ?? items.find(i => 'stepRunId' in i && typeof i.stepRunId === 'string' && i.stepRunId.endsWith(`/${row.state}`))
}

function RunTag({ kase, waiting, mine }: { kase: MwCase; waiting?: TimelineRow; mine: boolean }) {
  const { t } = useTranslation()
  if (kase.status === 'done') return <Tag tone="green">{t('memwise.everyPage.finished')}</Tag>
  if (kase.status === 'stopped') return <Tag tone="red">{humanize(kase.status)}</Tag>
  if (mine && waiting) return <Tag tone="amber" data-testid="run-waiting-tag">{t('memwise.everyPage.waitingForYouStep', { n: waiting.n })}</Tag>
  if (kase.waiting) return <Tag tone="muted">{t('memwise.everyPage.waitingOnRecord')}</Tag>
  return <Tag tone="muted">{t('memwise.everyPage.running')}</Tag>
}

function whoText(row: TimelineRow, roles: MwRole[] | null, myRoles: string[], t: (k: string) => string): string {
  const who = whoDoes(row.step, myRoles)
  if (who.kind === 'system') return t('memwise.everyPage.whoSystem')
  if (who.kind === 'agent') return t('memwise.everyPage.whoAgent')
  if (who.kind === 'external') return t('memwise.everyPage.whoExternal')
  if (who.kind === 'you') return t('memwise.everyPage.whoYou')
  return who.kind === 'role' ? roleTitle(who.role, roles) ?? humanize(who.role) : ''
}

function TimelineItem({ row, kase, playbook, item, onAnswered }: { row: TimelineRow; kase: MwCase; playbook: MwPlaybook; item?: MwInboxItem; onAnswered: () => void }) {
  const { t } = useTranslation()
  const roles = useAtomValue(memwiseRolesAtom)
  const me = useAtomValue(memwiseStatusAtom)?.me
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const run = row.run
  const when = run ? (row.status === 'waiting' ? t('memwise.everyPage.waitingSince', { time: absoluteDate(run.startedAt) }) : absoluteTime(run.finishedAt ?? run.startedAt)) : undefined
  const by = run?.decidedBy ? personName(run.decidedBy, people) : undefined
  const muted = row.status === 'next' || row.status === 'skipped'
  return (
    <li className="flex gap-3" data-step={row.state} data-status={row.status}>
      <div className="flex w-5 shrink-0 justify-center pt-[3px]">
        {row.status === 'done' && <span className="grid size-[18px] place-items-center rounded-full bg-success text-background"><Check className="size-3" strokeWidth={3} /></span>}
        {row.status === 'waiting' && <span className="size-[18px] rounded-full border-2 border-amber-600 dark:border-amber-400" />}
        {row.status === 'running' && <Loader2 className="size-[18px] animate-spin text-secondary" />}
        {row.status === 'failed' && <CircleAlert className="size-[18px] text-destructive" />}
        {muted && <Circle className="size-[18px] text-foreground/25" />}
      </div>
      <div className={cn('min-w-0 flex-1 pb-3', muted && 'text-secondary')}>
        <p className="text-label">
          <span className={cn(!muted && 'font-medium text-foreground')}>{row.n} · {row.title}</span>
          <span className="text-secondary"> · {by ?? whoText(row, roles, me?.roles ?? [], t)}{when ? ` · ${when}` : ''}</span>
        </p>
        {row.status === 'done' && (run?.rationale || run?.comment || run?.outcome) && (
          <p className="mt-0.5 line-clamp-2 text-label text-secondary">{run.comment ?? run.rationale ?? humanize(run.outcome!)}</p>
        )}
        {row.status === 'waiting' && (
          <div className="mt-2" data-testid="run-waiting-step">
            {item ? <InPlace item={item} onAnswered={onAnswered} /> : <WaitingNote kase={kase} playbook={playbook} row={row} />}
          </div>
        )}
      </div>
    </li>
  )
}

/** The waiting step's own body, answered here; the page stays and shows the run moving on. */
function InPlace({ item, onAnswered }: { item: MwInboxItem; onAnswered: () => void }) {
  const roles = useAtomValue(memwiseRolesAtom)
  const people = peopleById(useAtomValue(memwisePeopleAtom))
  const me = useAtomValue(memwiseStatusAtom)?.me
  const signer = React.useMemo(() => (me ? { name: me.name, role: me.roles[0] ? roleTitle(me.roles[0], roles) : undefined } : undefined), [me, roles])
  const actions = useInboxActions(item, { onDone: onAnswered })
  return (
    <div className="rounded-[10px] border border-foreground/10 border-l-2 border-l-accent/60 px-4 py-3">
      <InboxItemView bare item={item} actions={actions} people={people} roles={roles ?? undefined} signer={signer} />
    </div>
  )
}

function WaitingNote({ kase, row }: { kase: MwCase; playbook: MwPlaybook; row: TimelineRow }) {
  const { t } = useTranslation()
  const roles = useAtomValue(memwiseRolesAtom)
  if (kase.waiting) return <p className="text-label text-secondary">{t('memwise.everyPage.waitingForCondition', { record: kase.waiting.record.title, condition: kase.waiting.condition })}</p>
  const role = row.step.assignee
  return <p className="text-label text-secondary">{role ? t('memwise.everyPage.waitingForRole', { role: roleTitle(role, roles) ?? humanize(role) }) : t('memwise.everyPage.running')}</p>
}
