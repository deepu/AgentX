/**
 * Waiting for you (doc 26 §2, mock `Waiting`): a built-in page listing every step, from any
 * playbook in the project, that needs the person, the one waiting longest first, then what was
 * finished this week. `*` lists every project's (mock `XWaitingAll`).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import type { MwCaseSummary, MwInboxItem, MwPlaybookSummary } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseCasesAtom, memwiseDomainsAtom, memwiseInboxAtom, memwisePlaybooksAtom } from '@/atoms/memwise'
import { inboxItemStepTitle, relativeTime } from '../format'
import { useNow } from '../use-now'
import { ALL_PROJECTS } from '../../../../shared/project-route'
import { caseProject, projectLookups, sortWaiting, updateItemId, waitingIn, type ShellProject } from './project-model'
import { inboxItemProject } from '@memwise/shared/protocol'

const DAY = 86_400_000

export function ShellPageFrame({ crumb, title, count, subtitle, actions, children }: {
  crumb?: React.ReactNode
  title: React.ReactNode
  count?: number
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto" data-testid="shell-page">
      <div className="mx-auto max-w-[760px] px-7 pb-16 pt-6">
        {crumb && <div className="mb-1.5 text-label-sm text-secondary">{crumb}</div>}
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-[24px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
            {title}
            {count !== undefined && <span className="ml-2 font-normal text-tertiary">{count}</span>}
          </h1>
          {actions}
        </div>
        {subtitle && <p className="mt-1.5 text-label text-secondary">{subtitle}</p>}
        <div className="mt-5">{children}</div>
      </div>
    </div>
  )
}

export function ShellSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-label font-semibold text-foreground">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal text-tertiary">{count}</span>}
      </h2>
      {children}
    </section>
  )
}

export function WaitingPage({ projectId, projects }: { projectId: string; projects: ShellProject[] }) {
  const { t } = useTranslation()
  const inbox = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const domains = useAtomValue(memwiseDomainsAtom)
  const cases = useAtomValue(memwiseCasesAtom)
  const now = useNow()
  const all = projectId === ALL_PROJECTS
  const items = sortWaiting(waitingIn(projectId, inbox, { playbooks, domains }, projects.find(p => p.id === projectId)?.apps))
  const lookups = projectLookups({ playbooks, domains })
  const projectName = (item: MwInboxItem) => projects.find(p => p.id === inboxItemProject(item, lookups))?.name
  const done = finishedThisWeek(cases, projectId, now)
  const project = all ? undefined : projects.find(p => p.id === projectId)
  const update = project?.update ? project : undefined

  return (
    <ShellPageFrame
      crumb={t('memwise.shell.waiting')}
      title={all ? t('memwise.shell.waitingAll') : t('memwise.shell.waiting')}
      count={items.length + (update ? 1 : 0)}
      subtitle={all ? t('memwise.shell.waitingAllHint') : t('memwise.shell.waitingHint')}
    >
      {update && <div className="mb-2.5"><UpdateCard project={update} primary={items.length === 0} /></div>}
      {inbox === null ? null : items.length === 0 ? (update ? null : (
        <p className="rounded-[10px] border border-foreground/8 px-4 py-6 text-center text-label text-secondary" data-testid="waiting-empty">{t('memwise.shell.nothingWaiting')}</p>
      )) : (
        <div className="flex flex-col gap-2.5" data-testid="waiting-list">
          {items.map((item, i) => (
            <WaitingCard
              key={item.id}
              item={item}
              playbooks={playbooks}
              primary={i === 0}
              now={now}
              {...(all ? { project: projectName(item) } : {})}
              onOpen={() => navigate(routes.view.project(all ? inboxItemProject(item, lookups) : projectId, { type: 'waiting', itemId: item.id }))}
            />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="mt-6">
          <ShellSection title={t('memwise.shell.doneThisWeek')} count={done.length}>
            <div className="overflow-hidden rounded-[10px] border border-foreground/8">
              {done.map(c => (
                <button
                  key={c.caseId}
                  type="button"
                  onClick={() => navigate(routes.view.project(projectId === ALL_PROJECTS ? caseProject(c) : projectId, { type: 'run', caseId: c.caseId }))}
                  className="flex w-full items-center gap-3 border-b border-foreground/6 px-4 py-2.5 text-left text-label last:border-b-0 hover:bg-fill-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {playbookTitle(c.workflowId, playbooks)} · <span className="text-secondary">{c.title}</span>
                  </span>
                  <span className="shrink-0 text-label-sm text-tertiary">{weekday(c.updatedAt)}</span>
                </button>
              ))}
            </div>
          </ShellSection>
        </div>
      )}
    </ShellPageFrame>
  )
}

export function WaitingCard({ item, playbooks, primary, now, project, compact, onOpen }: {
  item: MwInboxItem
  playbooks: MwPlaybookSummary[] | null
  primary?: boolean
  now: number
  project?: string
  compact?: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const due = 'dueAt' in item ? item.dueAt : undefined
  const waitedDays = Math.floor((now - Date.parse(item.since)) / DAY)
  const pb = playbookTitle(item.workflowId, playbooks)
  const when = due
    ? t('memwise.shell.dueOn', { date: shortDate(due) })
    : t('memwise.shell.waitingSince', { when: relativeTime(item.since, now) })
  return (
    <div className="flex items-center gap-4 rounded-[10px] border border-foreground/10 bg-background px-4 py-3 shadow-minimal" data-testid="waiting-card">
      <div className="min-w-0 flex-1">
        <div className="text-label font-semibold text-foreground">{inboxItemStepTitle(item, t)}</div>
        <div className="truncate text-label-sm text-secondary">
          {project ? `${project} · ` : ''}{item.caseTitle}
        </div>
        {!compact && (
          <div className="truncate text-label-sm text-tertiary">
            {t('memwise.shell.from')}{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={e => { e.stopPropagation(); if (item.workflowId) navigate(routes.view.playbooks(item.workflowId)) }}
            >
              {pb}
            </button>
            {' · '}{when}
          </div>
        )}
        {compact && <div className="truncate text-label-sm text-tertiary">{t('memwise.shell.fromPlaybook', { playbook: pb })}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {!compact && waitedDays >= 3 && (
          <span className="text-label-sm font-medium text-warning">{t('memwise.shell.waitingDays', { count: waitedDays })}</span>
        )}
        <button
          type="button"
          onClick={onOpen}
          data-testid="waiting-open"
          className={cn(
            'rounded-md px-3 py-1 text-label-sm font-medium',
            primary ? 'bg-foreground text-background hover:opacity-90' : 'border border-foreground/15 text-foreground hover:bg-fill-hover',
          )}
        >
          {t('memwise.shell.open')}
        </button>
      </div>
    </div>
  )
}

/** A project's template update, waiting for review beside its other items (Stage 3). */
export function UpdateCard({ project, primary }: { project: ShellProject; primary?: boolean }) {
  const { t } = useTranslation()
  const id = updateItemId(project)
  if (!project.update || !id) return null
  return (
    <div className="flex items-center gap-4 rounded-[10px] border border-foreground/10 bg-background px-4 py-3 shadow-minimal" data-testid="waiting-update">
      <div className="min-w-0 flex-1">
        <div className="text-label font-semibold text-foreground">{t('memwise.projects.update.itemTitle', { app: project.appName, version: project.update.to })}</div>
        {project.update.from !== undefined && (
          <div className="truncate text-label-sm text-secondary">{t('memwise.projects.update.itemDetail', { from: project.update.from, to: project.update.to })}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => navigate(routes.view.project(project.id, { type: 'update', itemId: id }))}
        data-testid="waiting-review-update"
        className={cn(
          'shrink-0 rounded-md px-3 py-1 text-label-sm font-medium',
          primary ? 'bg-foreground text-background hover:opacity-90' : 'border border-foreground/15 text-foreground hover:bg-fill-hover',
        )}
      >
        {t('memwise.projects.update.review')}
      </button>
    </div>
  )
}

export function playbookTitle(workflowId: string | undefined, playbooks: MwPlaybookSummary[] | null | undefined): string {
  return playbooks?.find(p => p.id === workflowId)?.title ?? workflowId ?? ''
}

/** Runs of the project finished in the last seven days, latest first. */
export function finishedThisWeek(cases: MwCaseSummary[] | null | undefined, projectId: string, now: number): MwCaseSummary[] {
  return (cases ?? [])
    .filter(c => c.status === 'done' && (projectId === ALL_PROJECTS || caseProject(c) === projectId))
    .filter(c => now - Date.parse(c.updatedAt) < 7 * DAY)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 6)
}

function weekday(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)
}

function shortDate(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? iso : new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(at)
}
