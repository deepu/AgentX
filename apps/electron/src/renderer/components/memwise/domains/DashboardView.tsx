/**
 * A dashboard page (24 §6, "TMF health"): KPI tiles with their targets, tables and lists of
 * records, a 0–100 heatmap with its legend, text, and when it was computed. Every number is
 * computed by the server on read; the container refetches on record changes. Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, RefreshCw, Target } from 'lucide-react'
import type { MwDashboard, MwDashboardBlock, MwRecordQueryResult } from '@memwise/shared/protocol'
import { Markdown } from '@memwise/ui'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { absoluteTime, relativeTime } from '../format'
import { HEAT_CLASS, formatPercent, formatTypedValue, heatBucket, kpiBelowTarget, kpiValue, type HeatBucket } from '../records/record-model'
import { StatusPill } from '../records/RecordBlocks'

export interface DashboardViewProps {
  dashboard: MwDashboard
  onOpenRecord?: (entity: string, id: string) => void
  onRefresh?: () => void
  refreshing?: boolean
  now?: number
}

export function DashboardView({ dashboard, onOpenRecord, onRefresh, refreshing, now }: DashboardViewProps) {
  const { t, i18n } = useTranslation()
  const kpis = dashboard.blocks.filter((b): b is Extract<MwDashboardBlock, { kind: 'kpi' }> => b.kind === 'kpi')
  const rest = dashboard.blocks.filter(b => b.kind !== 'kpi')
  return (
    <Info_Page.Content wide>
      <div className="space-y-6" data-dashboard={dashboard.pageId}>
        <Info_Page.Hero
          avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><LayoutDashboard className="size-4" /></div>}
          title={dashboard.title}
          meta={
            <>
              {dashboard.description && <span>{dashboard.description}</span>}
              <span title={absoluteTime(dashboard.computedAt, i18n.language)} data-computed>{t('memwise.dashboard.computed', { time: relativeTime(dashboard.computedAt, now, i18n.language) })}</span>
            </>
          }
          actions={onRefresh ? (
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}><RefreshCw className={cn(refreshing && 'animate-spin')} />{t('memwise.dashboard.refresh')}</Button>
          ) : undefined}
        />
        {kpis.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3" data-kpis>
            {kpis.map((k, i) => <KpiTile key={i} block={k} />)}
          </div>
        )}
        {rest.map((b, i) => {
          switch (b.kind) {
            case 'heatmap': return <Heatmap key={i} block={b} onOpenRecord={onOpenRecord} />
            case 'table':
            case 'list': return <ResultBlock key={i} title={b.title} result={b.result} list={b.kind === 'list'} onOpenRecord={onOpenRecord} />
            case 'text': return <div key={i} className="text-label text-secondary" data-text-block><Markdown mode="minimal">{b.markdown}</Markdown></div>
            default: return null
          }
        })}
      </div>
    </Info_Page.Content>
  )
}

function KpiTile({ block }: { block: Extract<MwDashboardBlock, { kind: 'kpi' }> }) {
  const { t, i18n } = useTranslation()
  const below = kpiBelowTarget(block)
  return (
    <div className="rounded-lg bg-raised p-3.5 shadow-elev-1" data-kpi={block.label}>
      <div className={cn('text-title tabular-nums', below ? 'text-destructive' : 'text-foreground')}>{kpiValue(block, t, i18n.language)}</div>
      <div className="mt-0.5 text-label font-medium text-foreground">{block.label}</div>
      {(block.detail || block.target !== undefined) && (
        <div className="mt-1 space-y-0.5 text-label-sm text-tertiary">
          {block.detail && <div>{block.detail}</div>}
          {block.target !== undefined && (
            <div className={cn('flex items-center gap-1', below && 'text-destructive')} data-target>
              <Target className="size-3" />
              {t('memwise.dashboard.target', { value: block.format === 'percent' ? formatPercent(block.target, i18n.language) : String(block.target) })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const LEGEND: HeatBucket[] = ['top', 'good', 'fair', 'low', 'none']

function Heatmap({ block, onOpenRecord }: { block: Extract<MwDashboardBlock, { kind: 'heatmap' }>; onOpenRecord?: (entity: string, id: string) => void }) {
  const { t } = useTranslation()
  return (
    <Info_Section title={block.title ?? t('memwise.dashboard.heatmap')} description={t('memwise.dashboard.heatmapHint')}>
      <div className="overflow-x-auto" data-heatmap>
        <table className="w-full border-separate border-spacing-1 p-2 text-label-sm">
          <thead>
            <tr>
              <th />
              {block.columns.map(c => <th key={c} className="px-1 py-1 text-center font-medium text-tertiary">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {block.rows.map(row => (
              <tr key={row.record.id}>
                <th className="whitespace-nowrap pr-2 text-left font-medium">
                  {onOpenRecord
                    ? <button type="button" className="text-foreground hover:underline" onClick={() => onOpenRecord(row.record.entity, row.record.id)}>{row.record.title}</button>
                    : <span className="text-foreground">{row.record.title}</span>}
                </th>
                {row.values.map((v, i) => (
                  <td key={i} className={cn('min-w-12 rounded-sm px-2 py-1.5 text-center tabular-nums', HEAT_CLASS[heatBucket(v)])} data-heat={heatBucket(v)}>
                    {v === null ? t('memwise.dashboard.na') : v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-separator px-3.5 py-2 text-label-sm text-secondary" data-legend>
        {LEGEND.map(b => (
          <span key={b} className="flex items-center gap-1.5">
            <span className={cn('inline-block size-3 rounded-sm', HEAT_CLASS[b])} />
            {t(`memwise.dashboard.legend.${b}`)}
          </span>
        ))}
      </div>
    </Info_Section>
  )
}

function ResultBlock({ title, result, list, onOpenRecord }: { title?: string; result: MwRecordQueryResult; list: boolean; onOpenRecord?: (entity: string, id: string) => void }) {
  const { t, i18n } = useTranslation()
  return (
    <Info_Section title={title ?? t('memwise.dashboard.records')} count={result.total}>
      {result.rows.length === 0 ? (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.dashboard.nothing')}</p>
      ) : list ? (
        <ul className="divide-y divide-separator" data-list>
          {result.rows.map(row => (
            <li key={row.id}>
              <button type="button" className="flex w-full flex-col items-start px-3.5 py-2.5 text-left hover:bg-fill-hover disabled:hover:bg-transparent" onClick={() => onOpenRecord?.(row.entity, row.id)} disabled={!onOpenRecord}>
                <span className="font-medium text-label text-foreground">{row.title}</span>
                <span className="text-label-sm text-secondary">
                  {result.columns.map(c => (row.hidden.includes(c.name) ? null : `${c.label}: ${formatTypedValue(c.type, row.values[c.name], t, i18n.language)}`)).filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto" data-table>
          <table className="w-full text-label">
            <thead>
              <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                <th className="px-3.5 py-2 font-medium">{t('memwise.records.record')}</th>
                {result.columns.map(c => <th key={c.name} className="px-3.5 py-2 font-medium">{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {result.rows.map(row => (
                <tr key={row.id} className={cn('border-b border-separator last:border-0', onOpenRecord && 'cursor-pointer hover:bg-fill-hover')} onClick={() => onOpenRecord?.(row.entity, row.id)}>
                  <td className="px-3.5 py-2 font-medium text-foreground">{row.title}</td>
                  {result.columns.map(c => (
                    <td key={c.name} className="px-3.5 py-2 text-secondary">
                      {row.hidden.includes(c.name) ? <span className="text-tertiary">{t('memwise.case.restrictedValue')}</span>
                        : c.name === 'status' ? <StatusPill status={String(row.values[c.name] ?? '')} />
                        : formatTypedValue(c.type, row.values[c.name], t, i18n.language)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Info_Section>
  )
}
