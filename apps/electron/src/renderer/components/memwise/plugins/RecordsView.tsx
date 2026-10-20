/**
 * The domain's records of one entity with a source badge for each outside record linked to them,
 * and one record in detail: its own values, the values read live through its links, and the
 * links themselves (how each was matched, and by whom). Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Link2 } from 'lucide-react'
import type { MwEntityRecord, MwEntityRow, MwField } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { cn } from '@/lib/utils'
import { CaseFieldList } from '../CaseValues'
import { absoluteTime, formatValueInline, humanize, relativeTime, type PeopleById } from '../format'
import { Pill } from '../playbook/Tags'
import { linkBadgeLabel, matchMethodLabel, scorePercent } from './plugin-model'

/** A row's title: the first of its name-like fields, else the start of its id. */
export function rowTitle(entity: string, row: Pick<MwEntityRow, 'id' | 'values'>): string {
  for (const key of ['name', 'legal_name', 'title', 'client_name', 'full_name', 'email']) {
    const v = row.values[key]?.value
    if (typeof v === 'string' && v.trim()) return v
  }
  const first = Object.values(row.values).find(v => typeof v.value === 'string' && (v.value as string).trim())
  return typeof first?.value === 'string' ? first.value : `${humanize(entity)} ${row.id.slice(-6)}`
}

export function SourceBadge({ label, title }: { label: string; title?: string }) {
  return (
    <Pill className="bg-info-tint text-info" title={title}>
      <Link2 />
      {label}
    </Pill>
  )
}

export interface RecordsTableProps {
  entity: string
  rows: MwEntityRow[]
  /** The entity's fields, for up to two columns beside the title. */
  fields?: MwField[]
  selectedId?: string | null
  onOpen: (id: string) => void
}

export function RecordsTable({ entity, rows, fields = [], selectedId, onOpen }: RecordsTableProps) {
  const { t, i18n } = useTranslation()
  if (rows.length === 0) {
    return <EntityListEmptyScreen icon={<Database />} title={t('memwise.records.emptyTitle')} description={t('memwise.records.emptyDescription')} />
  }
  // Two columns beside the title keep the table inside the page; the record itself shows every field.
  const columns = fields.filter(f => !['name', 'legal_name', 'title'].includes(f.name)).slice(0, 2)
  return (
    <div className="overflow-x-auto rounded-lg bg-raised shadow-elev-1">
      <table className="w-full text-label" data-records={entity}>
        <thead>
          <tr className="border-b border-separator text-left text-label-sm text-tertiary">
            <th className="px-4 py-2 font-medium">{t('memwise.records.record')}</th>
            {columns.map(f => <th key={f.name} className="px-4 py-2 font-medium">{humanize(f.name)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={row.id}
              className={cn('cursor-pointer border-b border-separator last:border-0 hover:bg-fill-hover', selectedId === row.id && 'bg-fill-selected')}
              onClick={() => onOpen(row.id)}
              data-record={row.id}
            >
              {/* The source badges sit under the title, so a wide row never scrolls them out of sight. */}
              <td className="px-4 py-2 align-top">
                <div className="font-medium text-foreground">{rowTitle(entity, row)}</div>
                {(row.links ?? []).length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1" aria-label={t('memwise.records.linked')}>
                    {(row.links ?? []).map(l => (
                      <SourceBadge key={`${l.plugin}:${l.source}`} label={linkBadgeLabel(l)} title={matchMethodLabel(l.method, t)} />
                    ))}
                  </span>
                )}
              </td>
              {columns.map(f => <td key={f.name} className="px-4 py-2 align-top text-secondary">{formatValueInline(row.values[f.name]?.value, t, i18n.language)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RecordView({ record, people = {}, now }: { record: MwEntityRecord; people?: PeopleById; now?: number }) {
  const { t, i18n } = useTranslation()
  const readThrough = Object.entries(record.readThrough)
  return (
    <div className="space-y-6" data-record-detail={record.id}>
      <Info_Section title={t('memwise.records.values')}>
        {Object.keys(record.values).length === 0
          ? <p className="px-4 py-3 text-label text-tertiary">{t('memwise.records.noValues')}</p>
          : <CaseFieldList values={record.values} people={people} />}
      </Info_Section>

      {readThrough.length > 0 && (
        <Info_Section title={t('memwise.records.readThrough')} description={t('memwise.records.readThroughDescription')}>
          <Info_Table>
            {readThrough.map(([field, v]) => (
              <Info_Table.Row key={field} label={humanize(field)}>
                <span className="flex flex-wrap items-center gap-2" data-read-through={field}>
                  <span>{formatValueInline(v.value, t, i18n.language)}</span>
                  <SourceBadge label={v.pluginTitle} />
                </span>
              </Info_Table.Row>
            ))}
          </Info_Table>
        </Info_Section>
      )}

      <Info_Section title={t('memwise.records.links')} count={record.links.length}>
        {record.links.length === 0 ? (
          <p className="px-4 py-3 text-label text-tertiary">{t('memwise.records.noLinks')}</p>
        ) : (
          <ul className="divide-y divide-separator">
            {record.links.map(l => (
              <li key={l.id} className="space-y-1.5 px-4 py-3" data-link={l.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <SourceBadge label={linkBadgeLabel(l)} />
                  <span className="font-mono text-label-sm text-tertiary">{l.externalId}</span>
                  <span className="flex-1" />
                  <span className="text-label-sm text-tertiary" title={absoluteTime(l.at, i18n.language)}>
                    {l.linkedByName ?? l.linkedBy
                      ? t('memwise.records.linkedBy', { method: matchMethodLabel(l.method, t), name: l.linkedByName ?? l.linkedBy, time: relativeTime(l.at, now, i18n.language) })
                      : t('memwise.records.linkedHow', { method: matchMethodLabel(l.method, t), time: relativeTime(l.at, now, i18n.language) })}
                  </span>
                </div>
                {l.method === 'fuzzy' && <p className="text-label-sm text-secondary">{t('memwise.records.score', { score: scorePercent(l.score) })}</p>}
                {l.reasons.length > 0 && <p className="text-label-sm text-secondary">{l.reasons.join(' · ')}</p>}
                {l.error && (
                  <Info_Alert variant="warning" inline>
                    <Info_Alert.Title>{t('memwise.records.readFailed')}</Info_Alert.Title>
                    <Info_Alert.Description>{l.error}</Info_Alert.Description>
                  </Info_Alert>
                )}
                {l.values && Object.keys(l.values).length > 0 && (
                  <Info_Table>
                    {Object.entries(l.values).map(([k, v]) => <Info_Table.Row key={k} label={humanize(k)} value={formatValueInline(v, t, i18n.language)} />)}
                  </Info_Table>
                )}
              </li>
            ))}
          </ul>
        )}
      </Info_Section>
    </div>
  )
}
