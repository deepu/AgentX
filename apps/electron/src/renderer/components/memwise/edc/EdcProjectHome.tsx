/**
 * Stage 6 in the project shell (doc 26 §9, XEdcHome): an EDC app's pinned Home page. The shell
 * gives the frame, what waits for the person and what is running; this adds what Rave says about
 * the study (and when MemWise last read it), randomised against target by site, the sites with old
 * queries and a way to the queries page (XQueries), the app's pages, and the same study in the
 * other apps. Read only: data entry stays in Rave.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwDomain } from '@memwise/shared/protocol'
import { navigate, routes } from '@/lib/navigate'
import { useNow } from '../use-now'
import { ShellPageFrame, ShellSection } from '../project/WaitingPage'
import { AlsoInOtherAppsList, EdcSiteBars, EdcSourceLine, EdcTiles } from './EdcHomeView'
import { useEdcHome, useStudyApps } from './EdcScreens'

/** An EDC app: one with a Study and a Site, read from a study system. */
export function isEdcApp(domain: MwDomain | null | undefined): boolean {
  if (!domain) return false
  const has = (bare: string) => domain.entities.some(e => e.key === `${domain.id}.${bare}` || e.entity === `${domain.id}.${bare}`)
  return has('Study') && has('Site') && has('Query')
}

/** The id of the page that lists queries (XQueries): the one named for old queries, else for queries. */
export function queriesPageId(domain: MwDomain): string | undefined {
  return domain.pages.find(p => p.id === 'old-queries')?.id ?? domain.pages.find(p => /quer/i.test(p.id))?.id
}

const OLD_SHOWN = 4

export interface EdcProjectHomeProps {
  project: { id: string; name: string }
  domain: MwDomain
  /** The shell's own sections, placed where they belong on this page. */
  waiting: React.ReactNode
  running?: React.ReactNode
}

export function EdcProjectHome({ project, domain, waiting, running }: EdcProjectHomeProps) {
  const { t } = useTranslation()
  const now = useNow()
  const home = useEdcHome(project.id, domain.id)
  const apps = useStudyApps(home.data ? project.id : null, domain.id)
  const openRecord = (entity: string, id: string) => navigate(routes.view.project(project.id, { type: 'record', entity, recordId: id }))
  const openPage = (pageId: string) => navigate(routes.view.project(project.id, { type: 'dashboard', domain: domain.id, pageId }))
  const queriesPage = queriesPageId(domain)
  const queriesTitle = domain.pages.find(p => p.id === queriesPage)?.title
  const data = home.data
  const old = data ? data.sites.filter(s => s.oldQueries > 0).sort((a, b) => b.oldQueries - a.oldQueries || a.number.localeCompare(b.number)) : []
  const title = data ? (data.study.name ?? t('memwise.edc.home.title', { study: data.study.key })) : project.name
  const actions = data?.study.record ? (
    <button type="button" className="mt-1.5 shrink-0 text-label-sm text-accent hover:underline" onClick={() => openRecord(data.study.record!.entity, data.study.record!.id)}>
      {t('memwise.edc.home.openStudy')}
    </button>
  ) : undefined

  return (
    <ShellPageFrame
      crumb={t('memwise.shell.homeCrumb')}
      title={title}
      subtitle={data ? <span className="flex flex-wrap gap-x-2"><EdcSourceLine home={data} now={now} /></span> : home.error ?? undefined}
      actions={actions}
    >
      <div data-testid="project-pinned-page" data-edc-home={data?.study.key}>
        {data && <div className="mb-6"><EdcTiles home={data} /></div>}
        {waiting}
        {data && (
          <ShellSection title={t('memwise.edc.home.bySite')} count={data.sites.length}>
            <div className="-mx-3.5"><EdcSiteBars home={data} onOpenRecord={openRecord} /></div>
          </ShellSection>
        )}
        {data && (
          <ShellSection title={t('memwise.edc.home.oldQueriesTitle', { days: data.queries.olderThanDays })} count={data.queries.old}>
            {old.length > 0 && (
              <div className="overflow-hidden rounded-[10px] border border-foreground/8" data-old-query-sites>
                {old.slice(0, OLD_SHOWN).map(s => (
                  <button
                    key={s.site.id}
                    type="button"
                    onClick={() => openRecord(s.site.entity, s.site.id)}
                    className="flex w-full items-center gap-3 border-b border-foreground/6 px-4 py-2.5 text-left text-label last:border-b-0 hover:bg-fill-hover"
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">{s.site.title}</span>
                    <span className="shrink-0 text-label-sm text-secondary">{t('memwise.edc.home.oldQueries', { count: s.oldQueries, days: data.queries.olderThanDays })}</span>
                  </button>
                ))}
              </div>
            )}
            {queriesPage && (
              <button type="button" className="mt-2 text-label-sm text-foreground underline underline-offset-2 hover:text-accent" onClick={() => openPage(queriesPage)} data-open-queries>
                {t('memwise.shell.openPage', { page: queriesTitle })}
              </button>
            )}
          </ShellSection>
        )}
        {domain.pages.length > 0 && (
          <ShellSection title={t('memwise.shell.pages')} count={domain.pages.length}>
            <div className="flex flex-wrap gap-2">
              {domain.pages.map(p => (
                <button key={p.id} type="button" onClick={() => openPage(p.id)} className="rounded-[8px] border border-foreground/10 bg-background px-3 py-1.5 text-label text-foreground hover:bg-fill-hover">
                  {p.title}
                </button>
              ))}
            </div>
          </ShellSection>
        )}
        {apps.data && (
          <ShellSection title={t('memwise.edc.also.title')} count={apps.data.apps.length}>
            <div className="-mx-3.5"><AlsoInOtherAppsList apps={apps.data} onOpenRecord={openRecord} /></div>
          </ShellSection>
        )}
        {running}
        {data && <p className="text-center text-label-sm text-tertiary">{t('memwise.edc.home.readOnly', { source: data.source?.title ?? data.domain.toUpperCase() })}</p>}
      </div>
    </ShellPageFrame>
  )
}
