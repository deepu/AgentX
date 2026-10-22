/**
 * A project's Home (doc 26 §2, mocks `Main`, `LHome`). The chat column asks "What do you want to
 * know about …?" with a question box, questions to try and the recent chats; the page beside it
 * is the project's pinned page: what changed this week on its written pages, what waits for the
 * person, the pages kept up to date, the project's first dashboard, and what is running now.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import type { MwDomain, MwRecordQueryResult } from '@memwise/shared/protocol'
import { navigate, routes } from '@/lib/navigate'
import { memwiseCasesAtom, memwiseDomainsAtom, memwiseInboxAtom, memwisePlaybooksAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { getMemwiseApi } from '@/hooks/useMemwise'
import { useMemwiseDashboard, useMemwiseRecordQuery } from '@/hooks/useMemwiseRecords'
import { useMemwisePages } from '@/hooks/useMemwisePages'
import { PagesKeptTable, WhatChangedThisWeek } from '../pages'
import { getSessionTitle } from '@/utils/session'
import { DashboardView } from '../domains/DashboardView'
import { EdcProjectHome, isEdcApp } from '../edc/EdcProjectHome'
import { humanize, relativeTime } from '../format'
import { useNow } from '../use-now'
import { Composer } from './AnchoredChat'
import { caseProject, pluralTitle, projectPlaybooks, projectRecordScope, sortWaiting, waitingIn, type ShellProject } from './project-model'
import { playbookTitle, ShellPageFrame, ShellSection, UpdateCard, WaitingCard } from './WaitingPage'

const RECENT_SHOWN = 5

/** Questions worth trying when the project has none of its own (domain.yaml `home.suggested`). */
export function homeSuggestions(domain: MwDomain | null, t: (k: string, o?: Record<string, unknown>) => string): string[] {
  if (domain?.home?.suggested?.length) return domain.home.suggested.slice(0, 3)
  const out = [t('memwise.shell.tryWaiting')]
  const top = domain?.entities.find(e => e.count > 0) ?? domain?.entities[0]
  if (top) out.push(t('memwise.shell.tryRecords', { records: pluralTitle(top.title).toLowerCase() }))
  return out
}

export interface HomeChatColumnProps {
  project: ShellProject
  domain: MwDomain | null
  send: (message: string) => Promise<void>
  busy: boolean
}

/** The chat column before a question: the question, the box, questions to try, recent chats. */
export function HomeChatColumn({ project, domain, send, busy }: HomeChatColumnProps) {
  const { t } = useTranslation()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const sessions = useAtomValue(sessionMetaMapAtom)
  const now = useNow()
  const home = domain?.home
  const [recentChats, setRecentChats] = React.useState<string[]>([])
  React.useEffect(() => {
    const api = getMemwiseApi()
    if (!api || !workspaceId || typeof api.memwiseFindChat !== 'function') return
    let stale = false
    api.memwiseFindChat(workspaceId, { anchor: { kind: 'project', id: project.id } })
      .then(r => { if (!stale) setRecentChats(r.recent ?? (r.sessionId ? [r.sessionId] : [])) })
      .catch(() => undefined)
    return () => { stale = true }
  }, [workspaceId, project.id])
  // A domain with a home lists its recent questions (each has its page); others their chats.
  const asked = useMemwiseRecordQuery(home?.entity ? { entity: home.entity, ...projectRecordScope(project), limit: RECENT_SHOWN } : null)
  // A project built on pages (26 §4): the pages its questions made, latest first.
  const pages = useMemwisePages(home && !home.entity ? project.id : null)

  const recent: { key: string; title: string; kind: string; at?: string; open: () => void }[] = []
  for (const r of asked.data?.rows ?? []) {
    recent.push({ key: `r:${r.id}`, title: r.title, kind: t('memwise.shell.page'), open: () => navigate(routes.view.project(project.id, { type: 'record', entity: r.entity, recordId: r.id })) })
  }
  for (const p of [...(pages.data ?? [])].filter(p => p.question).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, RECENT_SHOWN)) {
    recent.push({ key: `p:${p.id}`, title: p.title, kind: t('memwise.shell.page'), at: p.updatedAt, open: () => navigate(routes.view.project(project.id, { type: 'page', pageId: p.id })) })
  }
  for (const id of recentChats) {
    const meta = sessions.get(id)
    if (!meta) continue
    const at = meta.lastMessageAt ? new Date(meta.lastMessageAt).toISOString() : undefined
    recent.push({ key: `c:${id}`, title: getSessionTitle(meta), kind: t('memwise.shell.chat'), ...(at ? { at } : {}), open: () => navigate(routes.view.project(project.id, { type: 'home', chatId: id })) })
  }

  const question = home?.ask ?? t('memwise.shell.askAbout', { project: project.name })
  const placeholder = home?.placeholder ?? t('memwise.shell.askPlaceholder')
  const suggestions = homeSuggestions(domain, t)
  return (
    <div className="flex min-h-full flex-col justify-center px-8 py-10" data-testid="project-home-chat">
      <h1 className="mx-auto max-w-[420px] text-center font-serif text-[30px] leading-[1.15] text-foreground">{question}</h1>
      <div className="mt-6">
        <Composer placeholder={placeholder} busy={busy} onSend={send} large autoFocus />
      </div>
      {suggestions.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-label-sm font-medium text-secondary">{t('memwise.shell.tryAsking')}</div>
          <div className="flex flex-col gap-2">
            {suggestions.map(s => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => void send(s)}
                className="rounded-[8px] border border-foreground/10 bg-background px-3 py-2 text-left text-label text-foreground hover:bg-fill-hover"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="mt-6">
          <div className="mb-1 text-label-sm font-medium text-secondary">{t('memwise.shell.recentChats')}</div>
          {recent.slice(0, RECENT_SHOWN).map(r => (
            <button key={r.key} type="button" onClick={r.open} className="flex w-full items-center gap-3 border-b border-foreground/6 px-0.5 py-2 text-left text-label last:border-b-0 hover:text-accent">
              <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
              <span className="shrink-0 text-label-sm text-tertiary">{r.kind}{r.at ? ` · ${relativeTime(r.at, now)}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The page beside Home: the project's pinned page. */
export function HomePinnedPage({ project, domain }: { project: ShellProject; domain: MwDomain | null }) {
  const { t } = useTranslation()
  const inbox = useAtomValue(memwiseInboxAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const domains = useAtomValue(memwiseDomainsAtom)
  const cases = useAtomValue(memwiseCasesAtom)
  const now = useNow()
  const waiting = sortWaiting(waitingIn(project.id, inbox, { playbooks, domains }, project.apps))
  const board = domain?.pages[0]
  const dashboard = useMemwiseDashboard(board && !isEdcApp(domain) ? domain.id : null, board?.id ?? null)
  const home = domain?.home
  const ends = home ? [home.draftState, ...home.endStates].map(s => `'${s}'`).join(', ') : ''
  const kept = useMemwiseRecordQuery(home?.entity ? { entity: home.entity, ...projectRecordScope(project), filter: `not (status in (${ends}))`, limit: 8 } : null)
  // Written pages (26 §4): what changed on them this week, and the ones kept up to date.
  const pages = useMemwisePages(project.id)
  const openPage = (pageId: string) => navigate(routes.view.project(project.id, { type: 'page', pageId }))
  const openChange = (changeId: string) => {
    const item = waiting.find(i => 'pageChange' in i && i.pageChange?.changeId === changeId)
    navigate(routes.view.project(project.id, item ? { type: 'waiting', itemId: item.id } : { type: 'change', changeId }))
  }
  const own = new Set(projectPlaybooks(project, playbooks).map(p => p.id))
  const running = (cases ?? []).filter(c => c.status === 'active' && own.has(c.workflowId) && (!project.stored || caseProject(c) === project.id)).slice(0, 4)
  const subtitle = [project.description, project.appName !== project.name ? t('memwise.shell.fromTemplate', { app: project.appName }) : undefined].filter(Boolean).join(' · ')
  const edc = isEdcApp(domain)

  const waitingSection = (
    <ShellSection title={t('memwise.shell.waiting')} count={waiting.length + (project.update ? 1 : 0)}>
      {waiting.length === 0 && !project.update ? (
        <p className="text-label text-tertiary">{t('memwise.shell.nothingWaiting')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {project.update && <UpdateCard project={project} primary={waiting.length === 0} />}
          {waiting.slice(0, 3).map((item, i) => (
            <WaitingCard key={item.id} item={item} playbooks={playbooks} primary={i === 0 && waiting.length === 1} now={now} compact onOpen={() => navigate(routes.view.project(project.id, { type: 'waiting', itemId: item.id }))} />
          ))}
          {waiting.length > 3 && (
            <button type="button" className="self-start text-label-sm text-accent hover:underline" onClick={() => navigate(routes.view.project(project.id, { type: 'waiting' }))}>
              {t('memwise.shell.seeAllWaiting', { count: waiting.length })}
            </button>
          )}
        </div>
      )}
    </ShellSection>
  )
  const runningSection = running.length > 0 && (
      <ShellSection title={t('memwise.shell.runningNow')}>
        <div className="flex flex-col gap-2">
          {running.map(c => (
            <button
              key={c.caseId}
              type="button"
              onClick={() => navigate(routes.view.project(project.id, { type: 'run', caseId: c.caseId }))}
              className="flex items-center gap-3 rounded-[10px] border border-foreground/10 bg-background px-4 py-2.5 text-left text-label shadow-minimal hover:bg-fill-hover"
            >
              <span className="min-w-0 flex-1 truncate">
                <span className="underline underline-offset-2">{playbookTitle(c.workflowId, playbooks)}</span>
                <span className="text-secondary"> · {c.title}</span>
              </span>
              <span className="shrink-0 text-label-sm text-secondary">{c.stateTitle}</span>
            </button>
          ))}
        </div>
      </ShellSection>
  )

  // An EDC app's home is its study (Stage 6, XEdcHome): Rave's numbers, sites, queries, other apps.
  if (edc && domain) return <EdcProjectHome project={project} domain={domain} waiting={waitingSection} running={runningSection} />

  return (
    <ShellPageFrame crumb={t('memwise.shell.homeCrumb')} title={project.name} subtitle={subtitle || undefined}>
      <div data-testid="project-pinned-page">
        <div className="mb-6 empty:hidden">
          <WhatChangedThisWeek projectId={project.id} onOpenChange={openChange} onOpenPage={openPage} />
        </div>
        {waitingSection}

        {home?.entity && <KeptPages project={project} rows={kept.data} />}
        {(pages.data ?? []).some(p => p.status === 'kept') && (
          <div className="mb-6">
            <PagesKeptTable pages={pages.data ?? []} onOpenPage={openPage} now={new Date(now)} />
          </div>
        )}

        {board && dashboard.data && (
          <ShellSection title={dashboard.data.title}>
            <div className="-mx-1">
              <DashboardView
                dashboard={dashboard.data}
                onOpenRecord={(entity, id) => navigate(routes.view.project(project.id, { type: 'record', entity, recordId: id }))}
                onRefresh={dashboard.reload}
                refreshing={dashboard.loading}
              />
            </div>
            <button type="button" className="mt-1 text-label-sm text-foreground underline underline-offset-2 hover:text-accent" onClick={() => navigate(routes.view.project(project.id, { type: 'dashboard', domain: domain.id, pageId: board.id }))}>
              {t('memwise.shell.openPage', { page: dashboard.data.title })}
            </button>
          </ShellSection>
        )}

        {runningSection}
      </div>
    </ShellPageFrame>
  )
}

function KeptPages({ project, rows }: { project: ShellProject; rows: MwRecordQueryResult | null }) {
  const { t } = useTranslation()
  const list = rows?.rows ?? []
  if (list.length === 0) return null
  return (
    <ShellSection title={t('memwise.shell.keptPages')} count={list.length}>
      <div className="overflow-hidden rounded-[10px] border border-foreground/8">
        {list.map(r => (
          <button
            key={r.id}
            type="button"
            onClick={() => navigate(routes.view.project(project.id, { type: 'record', entity: r.entity, recordId: r.id }))}
            className="flex w-full items-center gap-3 border-b border-foreground/6 px-4 py-2.5 text-left text-label last:border-b-0 hover:bg-fill-hover"
          >
            <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
            {r.status && <span className="shrink-0 text-label-sm text-tertiary">{humanize(r.status)}</span>}
          </button>
        ))}
      </div>
    </ShellSection>
  )
}
