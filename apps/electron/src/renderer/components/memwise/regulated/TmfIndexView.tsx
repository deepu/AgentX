/**
 * The TMF index (Stage 5, docs/memwise/26-projects-and-pages.md §7; mock EIndex): built from the
 * TMF Reference Model, with the expected documents from the study plan. Four numbers (filed,
 * missing, waiting for QC, filed late), then one row per zone; each zone is a sub-page with its
 * sites, its documents and what is missing. Live: it is computed on read. Presentational:
 * `TmfIndexScreen` loads it. (Stage 2's pages render it as a block once `pages` merges.)
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, RefreshCw } from 'lucide-react'
import type { MwTmfIndex, MwTmfZoneRow } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { cn } from '@/lib/utils'
import { absoluteDate, humanize } from '../format'
import { Cell, Kpi, RegulatedPage, Section, Table } from './parts'
import { zoneName } from './regulated-model'

export interface TmfIndexViewProps {
  index: MwTmfIndex
  /** Open a zone's sub-page (null: back to the index). */
  onZone?: (zoneId: string | null) => void
  openRecord?: (entity: string, recordId: string) => void
  /** The crumb above the title ("Pages"). */
  crumb?: string
}

const zoneLabel = (z: Pick<MwTmfZoneRow, 'number' | 'id' | 'name'>, t: Parameters<typeof zoneName>[1]) => `${z.number} · ${zoneName(z, t)}`

export function TmfIndexView({ index, onZone, openRecord, crumb }: TmfIndexViewProps) {
  const { t, i18n } = useTranslation()
  const live = <Info_Badge color="default" data-live><RefreshCw className="mr-1 inline size-3" />{t('memwise.regulated.tmf.live')}</Info_Badge>
  const pages = crumb ?? t('memwise.regulated.tmf.crumbPages')
  const n = (v: number) => v.toLocaleString(i18n.language)

  if (index.zone) {
    const { row, sites, documents, missing } = index.zone
    return (
      <RegulatedPage
        data-tmf-zone={row.id}
        crumbs={[pages, t('memwise.regulated.tmf.title'), zoneLabel(row, t)]}
        title={zoneLabel(row, t)}
        subtitle={t('memwise.regulated.tmf.zoneSubtitle')}
        badge={live}
        actions={onZone ? (
          <button type="button" className="text-label text-secondary hover:text-foreground" onClick={() => onZone(null)} data-action="back">{t('memwise.regulated.tmf.back')}</button>
        ) : undefined}
      >
        <div className="flex flex-wrap gap-3">
          <Kpi label={t('memwise.regulated.tmf.filed')} value={n(row.filed)} note={t('memwise.regulated.tmf.ofExpected', { count: row.expected, expected: n(row.expected) })} />
          <Kpi label={t('memwise.regulated.tmf.missing')} value={n(row.missing)} tone={row.missing > 0 ? 'warning' : undefined} />
          <Kpi label={t('memwise.regulated.tmf.inQc')} value={n(row.inQc)} />
          <Kpi label={t('memwise.regulated.tmf.filedLate')} value={n(row.filedLate)} note={t('memwise.regulated.tmf.lateNote', { days: index.kpis.lateAfterDays })} />
        </div>

        {sites.length > 0 && (
          <Section title={t('memwise.regulated.tmf.sites')} data-sites>
            <Table head={[t('memwise.regulated.tmf.site'), t('memwise.regulated.tmf.expected'), t('memwise.regulated.tmf.filed'), t('memwise.regulated.tmf.missing'), t('memwise.regulated.tmf.inQcShort')]}>
              {sites.map(s => (
                <tr key={s.siteId} data-site={s.siteId}>
                  <Cell>{s.label}</Cell>
                  <Cell>{n(s.expected)}</Cell>
                  <Cell>{n(s.filed)}</Cell>
                  <Cell className={cn(s.missing > 0 && 'text-info')}>{n(s.missing)}</Cell>
                  <Cell>{n(s.inQc)}</Cell>
                </tr>
              ))}
            </Table>
          </Section>
        )}

        <Section title={t('memwise.regulated.tmf.missingTitle')} data-missing>
          {missing.length === 0 ? (
            <p className="text-label text-secondary">{t('memwise.regulated.tmf.noneMissing')}</p>
          ) : (
            <Table head={[t('memwise.regulated.tmf.artifact'), t('memwise.regulated.tmf.site'), t('memwise.regulated.tmf.due')]}>
              {missing.map(m => (
                <tr key={m.id} data-missing-item={m.id}>
                  <Cell>{m.artifact}</Cell>
                  <Cell>{m.site ?? '—'}</Cell>
                  <Cell className="whitespace-nowrap">{m.dueDate ? absoluteDate(m.dueDate, i18n.language) : '—'}</Cell>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        <Section title={t('memwise.regulated.tmf.documents')} data-documents>
          {documents.length === 0 ? (
            <p className="text-label text-secondary">{t('memwise.regulated.tmf.noDocuments')}</p>
          ) : (
            <Table head={[t('memwise.regulated.tmf.document'), t('memwise.regulated.tmf.artifact'), t('memwise.regulated.tmf.site'), t('memwise.regulated.tmf.statusHead')]}>
              {documents.map(d => (
                <tr key={`${d.entity}:${d.id}`} data-document={d.id}>
                  <Cell>
                    {openRecord
                      ? <button type="button" className="text-left font-medium hover:underline" onClick={() => openRecord(d.entity, d.id)}>{d.title}</button>
                      : <span className="font-medium">{d.title}</span>}
                  </Cell>
                  <Cell className="text-secondary">{d.artifact ?? '—'}</Cell>
                  <Cell className="text-secondary">{d.site ?? '—'}</Cell>
                  <Cell className="whitespace-nowrap">
                    {humanize(d.status)}
                    {d.filedLate && <span className="ml-1.5 text-label-sm text-info" data-filed-late>{t('memwise.regulated.tmf.late')}</span>}
                    {d.inQcDays !== undefined && <span className="ml-1.5 text-label-sm text-secondary">{t('memwise.regulated.tmf.inQcDays', { count: d.inQcDays })}</span>}
                  </Cell>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </RegulatedPage>
    )
  }

  const k = index.kpis
  return (
    <RegulatedPage
      data-tmf-index={index.project}
      crumbs={[pages, t('memwise.regulated.tmf.title')]}
      title={t('memwise.regulated.tmf.title')}
      subtitle={index.study ? t('memwise.regulated.tmf.subtitleStudy', { study: index.study.label }) : t('memwise.regulated.tmf.subtitle')}
      badge={live}
    >
      <div className="flex flex-wrap gap-3" data-kpis>
        <Kpi label={t('memwise.regulated.tmf.filed')} value={n(k.filed)} note={t('memwise.regulated.tmf.ofExpected', { count: k.expected, expected: n(k.expected) })} />
        <Kpi label={t('memwise.regulated.tmf.missing')} value={n(k.missing)} note={t('memwise.regulated.tmf.missingNote')} tone={k.missing > 0 ? 'warning' : undefined} />
        <Kpi
          label={t('memwise.regulated.tmf.inQc')}
          value={n(k.inQc)}
          {...(k.oldestInQcDays !== null ? { note: t('memwise.regulated.tmf.oldest', { count: k.oldestInQcDays }) } : {})}
        />
        <Kpi label={t('memwise.regulated.tmf.filedLate')} value={n(k.filedLate)} note={t('memwise.regulated.tmf.lateNote', { days: k.lateAfterDays })} />
      </div>

      <Table head={[t('memwise.regulated.tmf.zoneHead'), t('memwise.regulated.tmf.expected'), t('memwise.regulated.tmf.filed'), t('memwise.regulated.tmf.missing'), t('memwise.regulated.tmf.inQcShort')]} data-zones>
        {index.zones.map(z => (
          <tr
            key={z.id}
            data-zone={z.id}
            className={cn(onZone && 'cursor-pointer hover:bg-fill-hover')}
            onClick={onZone ? () => onZone(z.id) : undefined}
          >
            <Cell>
              {onZone
                ? <button type="button" className="inline-flex items-center gap-1 text-left hover:underline" onClick={e => { e.stopPropagation(); onZone(z.id) }}>{zoneLabel(z, t)}<ChevronRight className="size-3 text-tertiary" /></button>
                : zoneLabel(z, t)}
            </Cell>
            <Cell>{n(z.expected)}</Cell>
            <Cell>{n(z.filed)}</Cell>
            <Cell className={cn(z.missing > 0 ? 'text-info' : 'text-secondary')}>{n(z.missing)}</Cell>
            <Cell className={cn(z.inQc > 0 ? 'text-foreground' : 'text-secondary')}>{n(z.inQc)}</Cell>
          </tr>
        ))}
      </Table>

      {index.unplaced.length > 0 && (
        <Info_Alert variant="warning" inline data-unplaced>
          <Info_Alert.Title>{t('memwise.regulated.tmf.unplaced', { count: index.unplaced.length })}</Info_Alert.Title>
          <Info_Alert.Description>{index.unplaced.join(', ')}</Info_Alert.Description>
        </Info_Alert>
      )}
    </RegulatedPage>
  )
}
