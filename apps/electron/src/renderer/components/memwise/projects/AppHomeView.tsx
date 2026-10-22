/**
 * The app home (26 §3, mock EPortfolio): "TMF across studies". Tiles for the studies, the
 * headline percent and the next milestone, one row per project the person can see with the
 * app's columns and what comes next, and who has the most waiting on them. Presentational; the
 * screen fetches it (memwise:apps:home).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutGrid } from 'lucide-react'
import type { MwAppHome } from '@memwise/shared/protocol'
import { KpiTiles, type KpiTile } from '@memwise/ui'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { cn } from '@/lib/utils'
import { bottleneckLine, capital, homeCell, homeTotalsDetail, nextLabel, shortDate } from './project-model'

export interface AppHomeViewProps {
  home: MwAppHome
  appTitle?: string
  onOpenProject?: (projectId: string) => void
}

export function AppHomeView({ home, appTitle, onOpenProject }: AppHomeViewProps) {
  const { t, i18n } = useTranslation()
  const nouns = home.nouns
  const next = home.milestones[0]
  const tiles: KpiTile[] = [
    { label: capital(nouns.many), value: home.totals.projects, detail: homeTotalsDetail(home, t) },
    ...(home.headline ? [{ label: home.headline.label, value: home.headline.value, format: 'percent' as const, detail: t('memwise.projects.home.acrossRunning', { many: nouns.many }) }] : []),
    ...(next ? [{
      label: t('memwise.projects.home.nextMilestone'),
      value: null,
      display: next.label,
      detail: [next.name, next.date ? shortDate(next.date, i18n.language) : undefined].filter(Boolean).join(', '),
    }] : []),
  ]
  return (
    <Info_Page.Content wide>
      <div className="space-y-6" data-app-home={home.app}>
        <div className="text-label-sm text-tertiary" data-breadcrumbs>
          {appTitle ?? home.app} › {home.link ?? capital(nouns.many)}
        </div>
        <Info_Page.Hero
          avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><LayoutGrid className="size-4" /></div>}
          title={home.title}
          tagline={t('memwise.projects.home.tagline', { app: appTitle ?? home.app, many: nouns.many })}
        />
        <KpiTiles items={tiles} />
        <Info_Section title={capital(nouns.many)} count={home.rows.length}>
          {home.rows.length === 0 ? (
            <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.projects.home.none', { many: nouns.many })}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-label" data-home-table>
                <thead>
                  <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                    <th className="px-3.5 py-2 font-medium">{capital(nouns.one)}</th>
                    {home.columns.map((c) => <th key={c.label} className="px-3 py-2 font-medium">{c.label}</th>)}
                    <th className="px-3 py-2 font-medium">{t('memwise.projects.home.next')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-separator">
                  {home.rows.map((row) => (
                    <tr key={row.project} data-project={row.project} data-status={row.status}>
                      <td className="px-3.5 py-2.5 font-semibold">
                        {onOpenProject
                          ? <button type="button" className="text-foreground hover:underline" onClick={() => onOpenProject(row.project)}>{row.study ?? row.name}</button>
                          : <span>{row.study ?? row.name}</span>}
                      </td>
                      {home.columns.map((c, i) => (
                        <td key={c.label} className={cn('px-3 py-2.5 tabular-nums', row.values[i] === null && 'text-tertiary')}>
                          {homeCell(row.values[i], c.format, t, i18n.language)}
                        </td>
                      ))}
                      <td className="px-3 py-2.5 text-secondary">{nextLabel(row, t, i18n.language)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Info_Section>
        {home.bottlenecks.length > 0 && (
          <Info_Section title={t('memwise.projects.home.bottleneck')}>
            <table className="w-full text-label" data-bottlenecks>
              <thead>
                <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                  <th className="px-3.5 py-2 font-medium">{t('memwise.projects.home.person')}</th>
                  <th className="px-3 py-2 font-medium">{t('memwise.projects.home.waitingOnThem', { many: nouns.many })}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {home.bottlenecks.map((b) => (
                  <tr key={b.personId ?? b.name} data-person={b.personId ?? b.name}>
                    <td className="px-3.5 py-2.5">{[b.name, b.roles.join(', ')].filter(Boolean).join(' · ')}</td>
                    <td className="px-3 py-2.5 text-secondary">{bottleneckLine(b, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Info_Section>
        )}
      </div>
    </Info_Page.Content>
  )
}


