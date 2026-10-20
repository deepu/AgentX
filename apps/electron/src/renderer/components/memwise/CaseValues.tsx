/**
 * Case values with their provenance: the badge saying who or what set a value, the value
 * itself (money, documents, lists of records), and a field list used by the case view,
 * the inbox context and the step record.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Cog, FileText, FileWarning, Globe, Lock, PenLine, Sparkles, User, Wrench } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@memwise/ui'
import type { MwCaseValue, MwField } from '@memwise/shared/protocol'
import { Info_Badge } from '@/components/info/Info_Badge'
import type { BadgeColor } from '@/components/info/Info_Badge'
import { cn } from '@/lib/utils'
import {
  formatBytes,
  formatValueInline,
  humanize,
  isDocumentValue,
  provenanceBadge,
  type PeopleById,
  type ProvenanceTone,
} from './format'

const TONE: Record<ProvenanceTone, { color: BadgeColor; icon: React.ReactNode }> = {
  person: { color: 'default', icon: <User className="size-3" /> },
  tool: { color: 'muted', icon: <Wrench className="size-3" /> },
  judgement: { color: 'default', icon: <Sparkles className="size-3" /> },
  input: { color: 'default', icon: <PenLine className="size-3" /> },
  system: { color: 'muted', icon: <Cog className="size-3" /> },
  tainted: { color: 'warning', icon: <FileWarning className="size-3" /> },
  hidden: { color: 'muted', icon: <Lock className="size-3" /> },
  external: { color: 'warning', icon: <Globe className="size-3" /> },
}

export function ProvenanceBadge({ value, people }: { value: MwCaseValue; people?: PeopleById }) {
  const { t } = useTranslation()
  const info = provenanceBadge(value, t, people)
  const tone = TONE[info.tone]
  const badge = (
    <Info_Badge color={tone.color} icon={tone.icon} data-provenance={info.tone}>
      {info.text}
    </Info_Badge>
  )
  if (!info.detail) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="text-xs">{info.detail}</span>
      </TooltipContent>
    </Tooltip>
  )
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function DocumentChip({ doc }: { doc: { name: string; size?: number } }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-sm bg-fill-hover px-2 text-label-sm text-foreground">
      <FileText className="size-3.5 shrink-0 text-secondary" />
      <span className="truncate">{doc.name}</span>
      {typeof doc.size === 'number' && <span className="shrink-0 text-tertiary tabular-nums">{formatBytes(doc.size)}</span>}
    </span>
  )
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)

/** A file name in a table cell: one line, cut with an ellipsis rather than broken at its hyphens. */
const looksLikeFileName = (v: unknown): v is string => typeof v === 'string' && /^[^\s/]+\.[a-z0-9]{2,5}$/i.test(v)

/**
 * A case value, laid out for reading: documents as chips, lists of records as a small table.
 * `fieldNames`: the case's fields, so a record naming one (a flag's `field: pan`) shows its label.
 */
export function CaseValueView({ value, fieldNames }: { value: unknown; fieldNames?: ReadonlySet<string> }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language

  if (Array.isArray(value) && value.length > 0) {
    if (value.every(isDocumentValue)) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((d, i) => <DocumentChip key={i} doc={d as { name: string; size?: number }} />)}
        </div>
      )
    }
    if (value.every(isRecord)) {
      const columns = Array.from(new Set(value.flatMap(r => Object.keys(r as Record<string, unknown>))))
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-label-sm">
            <thead>
              <tr className="text-left text-tertiary">
                {columns.map(c => <th key={c} className="py-1 pr-3 font-medium">{humanize(c)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {value.map((row, i) => (
                <tr key={i}>
                  {columns.map(c => {
                    const cell = (row as Record<string, unknown>)[c]
                    const namesField = typeof cell === 'string' && (c === 'field' || !!fieldNames?.has(cell))
                    const file = looksLikeFileName(cell)
                    return (
                      <td
                        key={c}
                        className={cn('py-1 pr-3 align-top text-foreground', file && 'max-w-[14rem] truncate whitespace-nowrap')}
                        title={file ? cell : undefined}
                      >
                        {namesField ? humanize(cell as string) : formatValueInline(cell, t, locale)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }
  if (isDocumentValue(value)) return <DocumentChip doc={value} />
  const text = formatValueInline(value, t, locale)
  const empty = isEmptyValue(value)
  return <span className={cn('[overflow-wrap:anywhere]', empty && 'text-tertiary')}>{text}</span>
}

export interface CaseFieldListProps {
  values: Record<string, MwCaseValue>
  /** Field definitions, for order and descriptions; values without one follow in their own order. */
  fields?: MwField[]
  people?: PeopleById
  /** Show only these fields, in this order. */
  only?: string[]
  className?: string
}

/**
 * Rows of label · value · provenance badge, inside an Info_Section card. In a narrow card (a
 * third panel) the badge goes under the value, so the value keeps the width it needs.
 */
export function CaseFieldList({ values, fields, people, only, className }: CaseFieldListProps) {
  const { t } = useTranslation()
  const order = only ?? [
    ...(fields ?? []).map(f => f.name).filter(n => n in values),
    ...Object.keys(values).filter(n => !(fields ?? []).some(f => f.name === n)),
  ]
  const rows = order.filter(n => values[n] !== undefined)
  const fieldNames = React.useMemo(() => new Set([...(fields ?? []).map(f => f.name), ...Object.keys(values)]), [fields, values])
  if (rows.length === 0) {
    return <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.case.noFields')}</p>
  }
  return (
    <dl className={cn('@container/fields divide-y divide-separator', className)}>
      {rows.map(name => {
        const cv = values[name]!
        const def = fields?.find(f => f.name === name)
        return (
          <div
            key={name}
            className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-3.5 py-2.5 text-label @lg/fields:grid-cols-[140px_minmax(0,1fr)_auto]"
            data-field={name}
          >
            <dt className="text-secondary" title={def?.description}>{humanize(name)}</dt>
            <dd className="min-w-0 text-foreground">
              {cv.hidden ? <span className="text-tertiary">{t('memwise.case.restrictedValue')}</span> : <CaseValueView value={cv.value} fieldNames={fieldNames} />}
            </dd>
            {/* Nothing there: no "who set it" badge for an empty value */}
            {(cv.hidden || !isEmptyValue(cv.value)) && <div className="col-start-2 justify-self-start @lg/fields:col-start-3"><ProvenanceBadge value={cv} people={people} /></div>}
          </div>
        )
      })}
    </dl>
  )
}
