/**
 * Stage 6 (docs/memwise/26-projects-and-pages.md §9, XEdcHome): the EDC study home. What Medidata
 * Rave says about the study (randomised against plan, open and old queries, pages verified), when
 * MemWise last read it, what waits for the viewer, randomised against target by site, and the same
 * study in the other apps. Data entry stays in Rave: nothing here edits it. Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ArrowUpRight, FlaskConical } from 'lucide-react'
import type { MwEdcHome, MwEdcWaiting, MwStudyApp, MwStudyApps } from '@memwise/shared/protocol'
import { KpiTiles } from '@memwise/ui'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { absoluteTime, relativeTime } from '../format'
import { formatTypedValue } from '../records/record-model'
import { barWidth } from './edc-model'
import { OwnerTag } from './OwnerTags'

export interface EdcHomeViewProps {
  home: MwEdcHome
  /** "Also in other apps"; null while it loads or when there is none. */
  apps: MwStudyApps | null
  now?: number
  onOpenRecord: (entity: string, id: string) => void
  onOpenCase: (caseId: string) => void
}

/** "synced 6 min ago", or why not. */
export function EdcSourceLine({ home, now }: { home: MwEdcHome; now?: number }) {
  const { t, i18n } = useTranslation()
  const s = home.source
  const app = home.domain.toUpperCase()
  if (!s) return <span data-source-line="none">{t('memwise.edc.home.noSource', { app })}</span>
  return (
    <>
      <span data-source-line={s.at ? 'synced' : 'never'} title={s.at ? absoluteTime(s.at, i18n.language) : undefined}>
        {s.at
          ? t('memwise.edc.home.synced', { app, source: s.title ?? s.plugin, time: relativeTime(s.at, now, i18n.language) })
          : t('memwise.edc.home.neverSynced', { app, source: s.title ?? s.plugin })}
      </span>
      {s.error && (
        <span className="text-destructive" data-sync-error>
          {t('memwise.edc.home.syncFailed', { source: s.title ?? s.plugin, time: relativeTime(s.errorAt, now, i18n.language), error: s.error })}
        </span>
      )}
    </>
  )
}

function waitingText(w: MwEdcWaiting, t: TFunction): string {
  switch (w.kind) {
    case 'approval': return t('memwise.edc.waiting.approval', { count: w.count })
    case 'input':
    case 'decision':
    case 'conversation': return t('memwise.edc.waiting.answer', { count: w.count })
    default: return t('memwise.edc.waiting.other', { count: w.count })
  }
}

/** The study's numbers from Rave: randomised against plan, open and old queries, pages verified. */
export function EdcTiles({ home }: { home: MwEdcHome }) {
  const { t } = useTranslation()
  const r = home.randomised
  const randomisedDetail = r.target !== undefined && r.plannedByNow !== undefined
    ? t('memwise.edc.home.randomisedPlan', { target: r.target, planned: r.plannedByNow })
    : r.target !== undefined ? t('memwise.edc.home.randomisedOf', { target: r.target }) : undefined
  return (
    <KpiTiles items={[
      { label: t('memwise.edc.home.randomised'), value: r.value, ...(r.plannedByNow !== undefined ? { target: r.plannedByNow } : {}), ...(randomisedDetail ? { detail: randomisedDetail } : {}) },
      { label: t('memwise.edc.home.openQueries'), value: home.queries.open, detail: t('memwise.edc.home.oldQueries', { count: home.queries.old, days: home.queries.olderThanDays }) },
      { label: t('memwise.edc.home.pagesVerified'), value: home.pagesVerified, format: 'percent', detail: t('memwise.edc.home.pagesVerifiedDetail') },
    ]} />
  )
}

/** What waits for the viewer from the app's playbooks, one line per case. */
export function EdcWaitingList({ home, now, onOpenCase }: { home: MwEdcHome; now?: number; onOpenCase: (caseId: string) => void }) {
  const { t, i18n } = useTranslation()
  if (home.waiting.items.length === 0) return <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.edc.home.nothingWaiting')}</p>
  return (
    <ul className="divide-y divide-separator" data-waiting>
      {home.waiting.items.map(w => (
        <li key={`${w.caseId ?? ''}:${w.kind}`}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-fill-hover disabled:hover:bg-transparent"
            disabled={!w.caseId}
            onClick={() => w.caseId && onOpenCase(w.caseId)}
            data-waiting-kind={w.kind}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-label text-foreground">{w.workflowTitle ?? t('memwise.edc.waiting.untitled')}</span>
              <span className="text-label-sm text-secondary">{waitingText(w, t)}</span>
            </span>
            <span className="shrink-0 text-label-sm text-tertiary" title={absoluteTime(w.since, i18n.language)}>
              {w.dueAt ? t('memwise.edc.waiting.due', { time: relativeTime(w.dueAt, now, i18n.language) }) : relativeTime(w.since, now, i18n.language)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Randomised against target, by site: one bar each, the sites furthest behind first. */
export function EdcSiteBars({ home, onOpenRecord }: { home: MwEdcHome; onOpenRecord: (entity: string, id: string) => void }) {
  const { t } = useTranslation()
  if (home.sites.length === 0) return <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.edc.home.noSites')}</p>
  return (
    <ul className="space-y-1 px-3.5 py-2.5" data-site-bars>
      {home.sites.map(s => (
        <li key={s.site.id}>
          <button type="button" className="grid w-full grid-cols-[7rem_minmax(0,1fr)_6rem] items-center gap-3 rounded-md py-1 text-left text-label hover:bg-fill-hover" onClick={() => onOpenRecord(s.site.entity, s.site.id)} data-site={s.number}>
            <span className="truncate font-medium text-foreground" title={s.site.title}>{t('memwise.edc.home.site', { number: s.number })}</span>
            <span className="h-2 overflow-hidden rounded-full bg-fill-hover">
              <span className={cn('block h-full rounded-full', (s.percent ?? 0) < 60 ? 'bg-destructive' : (s.percent ?? 0) < 80 ? 'bg-info' : 'bg-success')} style={{ width: `${barWidth(s.percent)}%` }} data-percent={s.percent} />
            </span>
            <span className="text-right tabular-nums text-secondary">
              {s.target !== undefined ? t('memwise.edc.home.siteOf', { value: s.randomised, target: s.target }) : s.randomised}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function EdcHomeView({ home, apps, now, onOpenRecord, onOpenCase }: EdcHomeViewProps) {
  const { t } = useTranslation()
  return (
    <Info_Page.Content wide>
      <div className="space-y-6" data-edc-home={home.study.key}>
        <Info_Page.Hero
          avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><FlaskConical className="size-4" /></div>}
          title={t('memwise.edc.home.title', { study: home.study.key })}
          meta={<EdcSourceLine home={home} now={now} />}
          actions={home.study.record ? (
            <Button variant="ghost" size="sm" onClick={() => onOpenRecord(home.study.record!.entity, home.study.record!.id)}>
              {t('memwise.edc.home.openStudy')}<ArrowUpRight />
            </Button>
          ) : undefined}
        />
        <EdcTiles home={home} />
        <Info_Section title={t('memwise.edc.home.waiting')} count={home.waiting.total}>
          <EdcWaitingList home={home} now={now} onOpenCase={onOpenCase} />
        </Info_Section>
        <Info_Section title={t('memwise.edc.home.bySite')} description={t('memwise.edc.home.bySiteHint')} count={home.sites.length}>
          <EdcSiteBars home={home} onOpenRecord={onOpenRecord} />
        </Info_Section>
        {apps && <AlsoInOtherAppsView apps={apps} onOpenRecord={onOpenRecord} />}
        <p className="text-center text-label-sm text-tertiary">{t('memwise.edc.home.readOnly', { source: home.source?.title ?? home.domain.toUpperCase() })}</p>
      </div>
    </Info_Page.Content>
  )
}

function AppRow({ app, onOpenRecord }: { app: MwStudyApp; onOpenRecord: (entity: string, id: string) => void }) {
  const { t, i18n } = useTranslation()
  const facts = app.facts.filter(f => f.value !== null && f.value !== undefined)
    .map(f => `${f.label}: ${formatTypedValue(f.type, f.value, t, i18n.language)}`)
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-fill-hover disabled:hover:bg-transparent"
        disabled={!app.record}
        onClick={() => app.record && onOpenRecord(app.record.entity, app.record.id)}
        data-other-app={app.domain}
      >
        <OwnerTag app={{ domain: app.domain, name: app.domainName }} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-label text-foreground">
            <strong>{t('memwise.edc.also.sameStudy', { app: app.domainName })}</strong>
            {facts.length > 0 && <span className="text-secondary"> · {facts.join(' · ')}</span>}
          </span>
          {app.shares.length > 0 && <span className="text-label-sm text-tertiary">{t('memwise.edc.also.shares', { things: app.shares.join(', ').toLocaleLowerCase(i18n.language) })}</span>}
        </span>
        {app.record && <span className="shrink-0 text-label text-accent">{t('memwise.edc.also.open')}</span>}
      </button>
    </li>
  )
}

/** The other apps' rows, without a section around them. */
export function AlsoInOtherAppsList({ apps, onOpenRecord }: { apps: MwStudyApps; onOpenRecord: (entity: string, id: string) => void }) {
  const { t } = useTranslation()
  if (apps.apps.length === 0) return <p className="px-3.5 py-3 text-label text-tertiary" data-also-none>{t('memwise.edc.also.none', { study: apps.study.key })}</p>
  return (
    <ul className="divide-y divide-separator" data-also-in>
      {apps.apps.map(a => <AppRow key={a.domain} app={a} onOpenRecord={onOpenRecord} />)}
    </ul>
  )
}

/** "Also in other apps": the same study in each other app, with a headline or two and a way there. */
export function AlsoInOtherAppsView({ apps, onOpenRecord }: { apps: MwStudyApps; onOpenRecord: (entity: string, id: string) => void }) {
  const { t } = useTranslation()
  return (
    <Info_Section title={t('memwise.edc.also.title')} count={apps.apps.length}>
      <AlsoInOtherAppsList apps={apps} onOpenRecord={onOpenRecord} />
    </Info_Section>
  )
}
