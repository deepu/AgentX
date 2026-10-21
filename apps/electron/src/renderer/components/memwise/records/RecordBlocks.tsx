/**
 * The blocks a record page is made of (24 §6): fields and details with a source badge each
 * and in-place editing, related tables, cases, the lifecycle, charts and KPI tiles (drawn with
 * the @memwise/ui chart kit, 25 §5), "ask about this record", checks, notes, mentions, "start a
 * playbook here" and the history with its signatures. Presentational.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowRight,
  AtSign,
  Bot,
  Calculator,
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  Download,
  ExternalLink,
  Link2,
  Lock,
  MessageSquare,
  Pencil,
  Play,
  Plug,
  ShieldAlert,
  User,
  X,
} from 'lucide-react'
import type { MwPageBlock, MwRecordField, MwRecordFieldSource, MwRecordPage, MwRecordWriteResult, MwTransitionOption } from '@memwise/shared/protocol'
import { Chart, KpiTiles, Markdown } from '@memwise/ui'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Pill } from '../playbook/Tags'
import { absoluteTime, humanize, relativeTime, type PeopleById } from '../format'
import {
  SOURCE_TONE_CLASS,
  TONE_PILL,
  baseType,
  chartRows,
  fallbackChart,
  fieldSourceLabel,
  fieldSourceTone,
  formatFieldValue,
  formatTypedValue,
  isPercentType,
  isStructuralCheck,
  kpiTiles,
  lifecycleSteps,
  relatedColumns,
  statusLabel,
  statusTone,
  transitionBlockedReason,
  transitionLabel,
  type ChartView,
  type KpiView,
} from './record-model'

// ---------------------------------------------------------------- actions

export interface RecordPageActions {
  openRecord?: (entity: string, id: string) => void
  openCase?: (caseId: string) => void
  /** "Open all": the entity's records, narrowed to this record's (a view). */
  openView?: (entity: string, filter?: string) => void
  startPlaybook?: (workflowId: string) => void
  update?: (values: Record<string, unknown>, reason?: string) => Promise<MwRecordWriteResult>
  transition?: (transition: string, reason?: string) => Promise<MwRecordWriteResult>
  saveNote?: (body: string, reason?: string) => Promise<MwRecordWriteResult>
  exportAudit?: (format: 'json' | 'pdf') => Promise<void>
}

export function writeResultMessage(r: MwRecordWriteResult, t: ReturnType<typeof useTranslation>['t']): string {
  return t(`memwise.record.result.${r.status}`, { defaultValue: r.message ?? '' }) || r.message || t('memwise.inbox.notApplied')
}

// ---------------------------------------------------------------- small pieces

export function StatusPill({ status, className }: { status?: string; className?: string }) {
  if (!status) return null
  return <Pill className={cn(TONE_PILL[statusTone(status)], className)}><CircleDot />{statusLabel(status)}</Pill>
}

const SOURCE_ICON: Record<MwRecordFieldSource['kind'], React.ReactNode> = {
  domain: <Lock />,
  plugin: <Plug />,
  source: <Plug />,
  link: <Link2 />,
  calculated: <Calculator />,
  step: <Bot />,
  person: <User />,
}

export function FieldSourceBadge({ source }: { source: MwRecordFieldSource }) {
  const { t } = useTranslation()
  return (
    <Pill className={SOURCE_TONE_CLASS[fieldSourceTone(source)]} title={t('memwise.record.source.title')}>
      {SOURCE_ICON[source.kind]}
      <span data-source={source.kind}>{fieldSourceLabel(source, t)}</span>
    </Pill>
  )
}

/** A field's value: a reference links to its record page. */
export function FieldValue({ field, onOpenRecord }: { field: Pick<MwRecordField, 'type' | 'value' | 'ref' | 'hidden'>; onOpenRecord?: (entity: string, id: string) => void }) {
  const { t, i18n } = useTranslation()
  if (field.hidden) return <span className="text-tertiary">{t('memwise.case.restrictedValue')}</span>
  const text = formatFieldValue(field, t, i18n.language)
  const empty = field.value === null || field.value === undefined || field.value === ''
  if (field.ref && onOpenRecord) {
    return (
      <button type="button" className="text-left font-medium text-accent hover:underline [overflow-wrap:anywhere]" onClick={() => onOpenRecord(field.ref!.entity, field.ref!.id)} data-ref={`${field.ref.entity}:${field.ref.id}`}>
        {text}
      </button>
    )
  }
  return <span className={cn('[overflow-wrap:anywhere]', empty && 'text-tertiary')}>{text}</span>
}

/** Asks why, for a change in a regulated domain (24 §9). */
export function ReasonBox({ onConfirm, onCancel, busy, label }: { onConfirm: (reason: string) => void; onCancel: () => void; busy?: boolean; label?: string }) {
  const { t } = useTranslation()
  const [reason, setReason] = React.useState('')
  const id = React.useId()
  return (
    <div className="space-y-2 rounded-md bg-fill-hover/60 p-3" data-reason-box>
      <label htmlFor={id} className="block text-label-sm font-medium text-foreground">{label ?? t('memwise.record.reasonLabel')}</label>
      <Input id={id} value={reason} onChange={e => setReason(e.target.value)} placeholder={t('memwise.record.reasonPlaceholder')} autoFocus disabled={busy}
        onKeyDown={e => { if (e.key === 'Enter' && reason.trim()) { e.preventDefault(); onConfirm(reason.trim()) } }} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="button" size="sm" variant="primary" onClick={() => onConfirm(reason.trim())} disabled={!reason.trim() || busy}>{t('memwise.record.reasonConfirm')}</Button>
      </div>
    </div>
  )
}

function WriteError({ result }: { result: MwRecordWriteResult | null }) {
  const { t } = useTranslation()
  if (!result || result.applied) return null
  const fieldErrors = result.errors ? Object.entries(result.errors).flatMap(([f, errs]) => errs.map(e => `${humanize(f)}: ${e}`)) : []
  return (
    <Info_Alert variant="error" inline icon={<AlertTriangle />}>
      <Info_Alert.Title data-write-status={result.status}>{writeResultMessage(result, t)}</Info_Alert.Title>
      {fieldErrors.length > 0 && <Info_Alert.Description>{fieldErrors.join(' · ')}</Info_Alert.Description>}
    </Info_Alert>
  )
}

/**
 * Runs a write that may need a reason: in a regulated domain the reason is asked first; else the
 * write goes straight away and a `reason-required` answer asks for one and tries again.
 */
export function useReasonedWrite(regulated: boolean) {
  const [asking, setAsking] = React.useState<null | ((reason: string) => void)>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<MwRecordWriteResult | null>(null)
  const exec = React.useCallback(async (run: (reason?: string) => Promise<MwRecordWriteResult>, reason?: string): Promise<MwRecordWriteResult> => {
    setBusy(true)
    try {
      const r = await run(reason)
      if (!r.applied && r.status === 'reason-required' && !reason) {
        setAsking(() => (why: string) => { setAsking(null); void exec(run, why) })
        setResult(null)
        return r
      }
      setResult(r)
      return r
    } catch (err) {
      const r: MwRecordWriteResult = { applied: false, status: 'invalid', message: err instanceof Error ? err.message : String(err) }
      setResult(r)
      return r
    } finally {
      setBusy(false)
    }
  }, [])
  const write = React.useCallback((run: (reason?: string) => Promise<MwRecordWriteResult>, needsReason = regulated) => {
    setResult(null)
    if (needsReason) setAsking(() => (why: string) => { setAsking(null); void exec(run, why) })
    else void exec(run)
  }, [exec, regulated])
  return { write, asking, cancel: () => setAsking(null), busy, result, clear: () => setResult(null) }
}

// ---------------------------------------------------------------- fields

function editorKind(type: string): 'number' | 'date' | 'boolean' | 'text' {
  const base = baseType(type)
  if (base === 'Number' || isPercentType(base) || base === 'Integer') return 'number'
  if (base === 'Date') return 'date'
  if (base === 'Boolean') return 'boolean'
  return 'text'
}

function FieldEditor({ field, onSave, onCancel, busy }: { field: MwRecordField; onSave: (value: unknown) => void; onCancel: () => void; busy?: boolean }) {
  const { t } = useTranslation()
  const kind = editorKind(field.type)
  const [value, setValue] = React.useState<string | boolean>(kind === 'boolean' ? field.value === true : field.value === null || field.value === undefined ? '' : String(field.value))
  const parsed = (): unknown => {
    if (kind === 'boolean') return value === true
    const s = String(value).trim()
    if (!s) return null
    if (kind === 'number') return Number(s)
    return s
  }
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); onSave(parsed()) }} data-field-editor={field.name}>
      {kind === 'boolean' ? (
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={value === true} onChange={e => setValue(e.target.checked)} disabled={busy} />
          {value === true ? t('memwise.form.yes') : t('memwise.form.no')}
        </label>
      ) : (
        <Input className="h-7 min-w-0 flex-1" type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'} value={String(value)} onChange={e => setValue(e.target.value)} autoFocus disabled={busy} aria-label={field.label} />
      )}
      <Button type="submit" size="sm" variant="primary" disabled={busy}><Check />{t('common.save')}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}><X />{t('common.cancel')}</Button>
    </form>
  )
}

export function FieldRows({ fields, regulated, actions, emptyText }: {
  fields: MwRecordField[]
  regulated: boolean
  actions?: RecordPageActions
  emptyText?: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = React.useState<string | null>(null)
  const w = useReasonedWrite(regulated)
  if (fields.length === 0) return <p className="px-3.5 py-3 text-label text-tertiary">{emptyText ?? t('memwise.case.noFields')}</p>
  return (
    <dl className="@container/fields divide-y divide-separator">
      {fields.map(f => {
        const canEdit = f.editable && !!actions?.update && !f.hidden
        const isEditing = editing === f.name
        return (
          <div key={f.name} className="px-3.5 py-2.5 text-label" data-field={f.name}>
            <div className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 @2xl/fields:grid-cols-[140px_minmax(0,1fr)_auto]">
              <dt className="text-secondary" title={f.description}>
                {f.label}
                {f.required && <span className="sr-only"> ({t('memwise.record.required')})</span>}
              </dt>
              <dd className="flex min-w-0 items-start gap-1.5 text-foreground">
                {isEditing ? (
                  <FieldEditor
                    field={f}
                    busy={w.busy}
                    onCancel={() => { setEditing(null); w.cancel(); w.clear() }}
                    onSave={value => w.write(async reason => {
                      const r = await actions!.update!({ [f.name]: value }, reason)
                      if (r.applied) setEditing(null)
                      return r
                    }, regulated && f.controlled !== false)}
                  />
                ) : (
                  <>
                    <FieldValue field={f} onOpenRecord={actions?.openRecord} />
                    {canEdit && (
                      <button type="button" className="mt-0.5 shrink-0 text-tertiary hover:text-foreground" onClick={() => { setEditing(f.name); w.clear() }} aria-label={t('memwise.record.editField', { field: f.label })} data-action="edit-field">
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                  </>
                )}
              </dd>
              <div className="col-start-2 flex flex-wrap gap-1 justify-self-start @2xl/fields:col-start-3">
                {/* Nothing there: no "where it came from" badge (a calculated field still says so). */}
                {(f.hidden || f.calculated || !(f.value === null || f.value === undefined || f.value === '')) && <FieldSourceBadge source={f.source} />}
                {f.followed && <Pill className="bg-fill-hover text-secondary" title={t('memwise.record.followedHint')}>{t('memwise.record.followed')}</Pill>}
              </div>
            </div>
            {isEditing && w.asking && <div className="mt-2"><ReasonBox onConfirm={w.asking} onCancel={w.cancel} busy={w.busy} /></div>}
            {isEditing && <div className="mt-2"><WriteError result={w.result} /></div>}
          </div>
        )
      })}
    </dl>
  )
}

// ---------------------------------------------------------------- related

export function RelatedBlock({ page, names, actions }: { page: MwRecordPage; names: string[]; actions?: RecordPageActions }) {
  const { t, i18n } = useTranslation()
  return (
    <>
      {names.map(name => {
        const rel = page.related[name]
        if (!rel) return null
        const columns = relatedColumns(rel.rows)
        return (
          <Info_Section
            key={name}
            title={rel.label}
            count={rel.total}
            actions={actions?.openView && rel.total > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => actions.openView!(rel.entity)} data-action="open-all">
                {t('memwise.record.openAll')}
                <ArrowRight />
              </Button>
            ) : undefined}
          >
            {rel.rows.length === 0 ? (
              <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.record.noRelated')}</p>
            ) : (
              <div className="overflow-x-auto" data-related={name}>
                <table className="w-full text-label">
                  <tbody>
                    {rel.rows.map(row => (
                      <tr
                        key={row.id}
                        className={cn('border-b border-separator last:border-0', actions?.openRecord && 'cursor-pointer hover:bg-fill-hover')}
                        onClick={() => actions?.openRecord?.(row.entity, row.id)}
                      >
                        <td className="px-3.5 py-2 font-medium text-foreground">{row.title}</td>
                        {columns.map(c => (
                          <td key={c} className="px-3.5 py-2 text-secondary">{formatTypedValue(rel.types?.[c] ?? '', row.values[c], t, i18n.language)}</td>
                        ))}
                        <td className="px-3.5 py-2 text-right"><StatusPill status={row.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rel.total > rel.rows.length && (
                  <p className="border-t border-separator px-3.5 py-2 text-label-sm text-tertiary">{t('memwise.record.showingOf', { shown: rel.rows.length, total: rel.total })}</p>
                )}
              </div>
            )}
          </Info_Section>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- cases

export function CasesBlock({ page, actions, now }: { page: MwRecordPage; actions?: RecordPageActions; now?: number }) {
  const { t, i18n } = useTranslation()
  return (
    <Info_Section title={t('memwise.record.cases')} count={page.cases.length}>
      {page.cases.length === 0 ? (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.record.noCases')}</p>
      ) : (
        <ul className="divide-y divide-separator" data-record-cases>
          {page.cases.map(c => (
            <li key={c.caseId}>
              <button
                type="button"
                className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-fill-hover disabled:hover:bg-transparent"
                onClick={() => actions?.openCase?.(c.caseId)}
                disabled={!actions?.openCase}
                data-case={c.caseId}
              >
                <span className="mt-0.5 shrink-0">{c.status === 'done' ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-info" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{c.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-label-sm text-secondary">
                    <span>{c.status === 'active' ? t('memwise.record.now', { step: c.state }) : statusLabel(c.status)}</span>
                    {c.waitingOn && c.status === 'active' && <span>{t('memwise.record.waitingOn', { name: c.waitingOn })}</span>}
                    <span className="text-tertiary" title={absoluteTime(c.updatedAt, i18n.language)}>{relativeTime(c.updatedAt, now, i18n.language)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Info_Section>
  )
}

// ---------------------------------------------------------------- lifecycle

export function TransitionButtons({ transitions, onTransition, busy, size = 'sm' }: {
  transitions: MwTransitionOption[]
  onTransition?: (tr: MwTransitionOption) => void
  busy?: boolean
  size?: 'sm' | 'default'
}) {
  const { t } = useTranslation()
  if (transitions.length === 0) return null
  return (
    <div className="flex flex-wrap items-start gap-2" data-transitions>
      {transitions.map(tr => {
        const why = transitionBlockedReason(tr, t)
        return (
          <span key={tr.name} className="inline-flex flex-col items-start gap-0.5">
            <Button
              size={size}
              variant={tr.allowed ? 'secondary' : 'ghost'}
              disabled={!tr.allowed || !onTransition || busy}
              title={why}
              onClick={() => onTransition?.(tr)}
              data-transition={tr.name}
            >
              {transitionLabel(tr, t)}
              {tr.signed && <Lock className="size-3" aria-label={t('memwise.record.needsSignature')} />}
            </Button>
            {why && <span className="max-w-[16rem] text-label-sm text-tertiary" data-blocked={tr.name}>{why}</span>}
          </span>
        )
      })}
    </div>
  )
}

export function LifecycleBlock({ page, onTransition, busy }: { page: MwRecordPage; onTransition?: (tr: MwTransitionOption) => void; busy?: boolean }) {
  const { t } = useTranslation()
  const lc = page.lifecycle
  if (!lc) return null
  const steps = lifecycleSteps(lc.states, lc.current ?? page.status)
  const guards = lc.transitions.filter(tr => tr.guard)
  return (
    <Info_Section title={t('memwise.record.lifecycle')}>
      <div className="space-y-3 p-3.5">
        <ol className="flex flex-wrap items-center gap-1.5" data-lifecycle>
          {steps.map((s, i) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-label-sm',
                  s.state === 'current' ? 'bg-accent-tint font-medium text-accent' : s.state === 'done' ? 'bg-success-tint text-success' : 'bg-fill-hover text-tertiary',
                )}
                aria-current={s.state === 'current' ? 'step' : undefined}
                data-step-state={s.state}
              >
                {s.state === 'done' && <Check className="size-3" />}
                {s.label}
              </span>
              {i < steps.length - 1 && <ArrowRight className="size-3 text-tertiary" />}
            </li>
          ))}
        </ol>
        {guards.length > 0 && (
          <ul className="space-y-1 text-label-sm">
            {guards.map(tr => (
              <li key={tr.name} className="flex items-start gap-1.5" data-guard={tr.name}>
                {tr.guard!.holds ? <CheckCircle2 className="mt-0.5 size-3.5 text-success" /> : <ShieldAlert className="mt-0.5 size-3.5 text-tertiary" />}
                <span className="text-secondary">
                  {t(tr.guard!.holds ? 'memwise.record.guardHolds' : 'memwise.record.guardWaits', { state: statusLabel(tr.to) })}
                  <code className="ml-1 rounded bg-fill-hover px-1 text-tertiary">{tr.guard!.condition}</code>
                </span>
              </li>
            ))}
          </ul>
        )}
        <TransitionButtons transitions={lc.transitions} onTransition={onTransition} busy={busy} />
      </div>
    </Info_Section>
  )
}

// ---------------------------------------------------------------- chart, kpis, chat (25 §5)

/**
 * A chart in a section, drawn with the kit (@memwise/ui charts): the rows the server computed
 * for it, or nothing-to-chart. Record pages and dashboards both use it.
 */
export function ChartSection({ title, chart }: { title: string; chart: ChartView | null }) {
  const { t } = useTranslation()
  const data = chart ? chartRows(chart) : []
  return (
    <Info_Section title={title} count={chart && chart.kind !== 'interval' && chart.total > 0 ? chart.total : undefined}>
      <div className="p-3.5" data-chart={chart?.kind ?? ''}>
        {!chart || data.length === 0 ? (
          <p className="text-label text-tertiary">{t('memwise.record.noChartData')}</p>
        ) : (
          <Chart kind={chart.kind} data={data} title={title} unit={chart.unit} />
        )}
        {!!chart?.skipped && <p className="mt-2 text-label-sm text-tertiary" data-chart-skipped={chart.skipped}>{t('memwise.record.chartSkipped', { count: chart.skipped })}</p>}
      </div>
    </Info_Section>
  )
}

/** A `chart` block: the rows the kernel computed for it, else its related rows counted here. */
export function ChartBlock({ page, block, chart }: { page: MwRecordPage; block: Extract<MwPageBlock, { kind: 'chart' }>; chart?: ChartView | null }) {
  const { t } = useTranslation()
  const view = chart ?? fallbackChart(page, block)
  const of = page.related[block.of]?.label ?? humanize(block.of)
  const title = view?.title ?? (block as { title?: string }).title ?? t('memwise.record.chartTitle', { of, by: humanize(block.by ?? 'status').toLowerCase() })
  return <ChartSection title={title} chart={view} />
}

/** A `kpis` block: one tile per field, with the field's label. */
export function KpisBlock({ page, fields, kpis }: { page: MwRecordPage; fields: string[]; kpis?: Record<string, KpiView> }) {
  const { t, i18n } = useTranslation()
  return <KpiTiles items={kpiTiles(page, fields, kpis, t, i18n.language)} />
}

/** A `chat` block: "Ask about this topic", opening a chat anchored to the record beside the page. */
export function ChatBlock({ page, onOpenChat }: { page: MwRecordPage; onOpenChat?: () => void }) {
  const { t } = useTranslation()
  if (!onOpenChat) return null
  return (
    <Button variant="secondary" className="w-full justify-start" onClick={onOpenChat} data-action="ask-about-record">
      <MessageSquare />
      {t('memwise.record.askAbout', { entity: page.entityName.toLowerCase() })}
    </Button>
  )
}

// ---------------------------------------------------------------- checks

export function ChecksBlock({ page }: { page: MwRecordPage }) {
  const { t } = useTranslation()
  const checks = page.review?.checks ?? []
  if (checks.length === 0) return null
  const flagged = checks.filter(c => c.verdict !== 'pass').length
  const folded = checks.filter(c => c.verdict === 'pass' && isStructuralCheck(c.rule)).length
  return (
    <Info_Section title={flagged ? t('memwise.review.checksSummaryFlags', { passed: checks.length - flagged, count: flagged }) : t('memwise.review.checksAllPassed', { count: checks.length })}>
      <ul className="divide-y divide-separator" data-checks>
        {folded > 0 && (
          <li className="flex items-start gap-2.5 px-3.5 py-2.5 text-label" data-check="pass" data-form-checks={folded}>
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <span className="min-w-0 text-foreground">{t('memwise.review.formChecks')}</span>
          </li>
        )}
        {checks.filter(c => !(c.verdict === 'pass' && isStructuralCheck(c.rule))).map((c, i) => {
          const pass = c.verdict === 'pass'
          return (
            <li key={i} className="flex items-start gap-2.5 px-3.5 py-2.5 text-label" data-check={pass ? 'pass' : 'flag'}>
              {pass ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />}
              <span className="min-w-0">
                <span className="text-foreground">{c.rule}</span>
                {c.note && <span className="mt-0.5 block text-label-sm text-secondary">{c.note}</span>}
              </span>
              {!pass && <Info_Badge color="destructive" className="ml-auto shrink-0">{t('memwise.review.flag')}</Info_Badge>}
            </li>
          )
        })}
      </ul>
    </Info_Section>
  )
}

// ---------------------------------------------------------------- notes

export function NotesBlock({ page, actions, now }: { page: MwRecordPage; actions?: RecordPageActions; now?: number }) {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = React.useState(false)
  const [body, setBody] = React.useState(page.notes?.body ?? '')
  const w = useReasonedWrite(page.regulated)
  React.useEffect(() => { if (!editing) setBody(page.notes?.body ?? '') }, [page.notes?.body, editing])
  const note = page.notes
  return (
    <Info_Section
      title={t('memwise.record.notes')}
      description={note ? t('memwise.record.noteMeta', { count: note.version, name: note.by, time: relativeTime(note.at, now, i18n.language) }) : undefined}
      actions={actions?.saveNote && !editing ? (
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)} data-action="edit-note"><Pencil />{note ? t('common.edit') : t('memwise.record.addNote')}</Button>
      ) : undefined}
    >
      {editing ? (
        <div className="space-y-2 p-3.5">
          <Textarea value={body} onChange={e => setBody(e.target.value)} rows={6} autoFocus aria-label={t('memwise.record.notes')} disabled={w.busy} />
          <p className="text-label-sm text-tertiary">{t('memwise.record.notesHint')}</p>
          {w.asking && <ReasonBox onConfirm={w.asking} onCancel={w.cancel} busy={w.busy} />}
          <WriteError result={w.result} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); w.cancel(); w.clear() }} disabled={w.busy}>{t('common.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={w.busy} onClick={() => w.write(async reason => {
              const r = await actions!.saveNote!(body, reason)
              if (r.applied) setEditing(false)
              return r
            })} data-action="save-note">{t('common.save')}</Button>
          </div>
        </div>
      ) : note?.body ? (
        <div className="px-3.5 py-3 text-label" data-note><Markdown mode="minimal">{note.body}</Markdown></div>
      ) : (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.record.noNotes')}</p>
      )}
    </Info_Section>
  )
}

// ---------------------------------------------------------------- mentions, start

export function MentionsBlock({ page, actions, now }: { page: MwRecordPage; actions?: RecordPageActions; now?: number }) {
  const { t, i18n } = useTranslation()
  return (
    <Info_Section title={t('memwise.record.mentions')} count={page.mentions.length}>
      {page.mentions.length === 0 ? (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.record.noMentions')}</p>
      ) : (
        <ul className="divide-y divide-separator" data-mentions>
          {page.mentions.map(m => (
            <li key={`${m.sourceKind}:${m.sourceId}`} className="flex items-center gap-2 px-3.5 py-2 text-label">
              <AtSign className="size-3.5 shrink-0 text-tertiary" />
              {m.caseId && actions?.openCase ? (
                <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground hover:underline" onClick={() => actions.openCase!(m.caseId!)}>{m.label}</button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-foreground">{m.label}</span>
              )}
              <span className="shrink-0 text-label-sm text-tertiary">{relativeTime(m.at, now, i18n.language)}</span>
            </li>
          ))}
        </ul>
      )}
    </Info_Section>
  )
}

export function StartBlock({ page, actions }: { page: MwRecordPage; actions?: RecordPageActions }) {
  const { t } = useTranslation()
  if (page.start.length === 0) return null
  return (
    <Info_Section title={t('memwise.record.startHere')}>
      <div className="flex flex-col gap-1 p-2" data-start>
        {page.start.map(s => (
          <Button key={s.workflowId} variant="ghost" size="sm" className="justify-start" onClick={() => actions?.startPlaybook?.(s.workflowId)} disabled={!actions?.startPlaybook} data-start-playbook={s.workflowId}>
            <Play />
            {s.title}
          </Button>
        ))}
      </div>
    </Info_Section>
  )
}

// ---------------------------------------------------------------- history

export function HistoryBlock({ page, actions, now }: { page: MwRecordPage; actions?: RecordPageActions; now?: number }) {
  const { t, i18n } = useTranslation()
  const [exporting, setExporting] = React.useState<'json' | 'pdf' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const fieldLabel = (name: string) => page.fields.find(f => f.name === name)?.label ?? humanize(name)
  const run = async (format: 'json' | 'pdf') => {
    if (!actions?.exportAudit) return
    setExporting(format)
    setError(null)
    try { await actions.exportAudit(format) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setExporting(null) }
  }
  return (
    <Info_Section
      title={t('memwise.record.history')}
      count={page.history.length}
      description={page.regulated ? t('memwise.record.historyRegulated') : undefined}
      actions={actions?.exportAudit ? (
        <div className="flex items-center gap-1" data-audit-export>
          <span className="hidden text-label-sm text-tertiary sm:inline">{t('memwise.record.exportAudit')}</span>
          <Button variant="ghost" size="sm" onClick={() => void run('pdf')} disabled={!!exporting} data-action="export-pdf"><Download />PDF</Button>
          <Button variant="ghost" size="sm" onClick={() => void run('json')} disabled={!!exporting} data-action="export-json"><Download />JSON</Button>
        </div>
      ) : undefined}
    >
      {error && <div className="p-3"><Info_Alert variant="error" inline icon={<AlertTriangle />}><Info_Alert.Title>{error}</Info_Alert.Title></Info_Alert></div>}
      {page.signatures.length > 0 && (
        <div className="border-b border-separator" data-signatures>
          <p className="px-3.5 pt-2.5 text-label-sm font-medium text-secondary">{t('memwise.record.signatures')}</p>
          <ul className="divide-y divide-separator">
            {page.signatures.map(s => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2 text-label" data-signature={s.id}>
                <span className="font-medium text-foreground">{s.name}</span>
                <span className="text-secondary">“{s.meaning}”</span>
                <span className="text-label-sm text-tertiary">{absoluteTime(s.at, i18n.language)}</span>
                {s.changedSince
                  ? <Info_Badge color="destructive" className="ml-auto" data-changed-since>{t('memwise.record.changedSinceSigned')}</Info_Badge>
                  : <Info_Badge color="success" className="ml-auto">{t('memwise.record.signatureMatches')}</Info_Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {page.history.length === 0 ? (
        <p className="px-3.5 py-3 text-label text-tertiary">{t('memwise.record.noHistory')}</p>
      ) : (
        <ol className="divide-y divide-separator" data-versions>
          {page.history.map(v => (
            <li key={v.version} className="px-3.5 py-2 text-label">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium tabular-nums text-foreground">{t('memwise.record.version', { version: v.version })}</span>
                {/* Named by its step and playbook; the step run's id stays for the audit, on hover. */}
                <span className="text-secondary" title={v.byLabel && v.via ? v.via : undefined}>{v.byLabel ?? v.by}{v.via && !v.byLabel ? ` · ${v.via}` : ''}</span>
                <span className="text-label-sm text-tertiary" title={absoluteTime(v.at, i18n.language)}>{relativeTime(v.at, now, i18n.language)}</span>
              </div>
              <div className="mt-0.5 text-label-sm text-secondary">
                {t('memwise.record.changed', { fields: v.changed.map(fieldLabel).join(', ') })}
                {v.reason && <span className="text-tertiary"> · {t('memwise.record.because', { reason: v.reason })}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Info_Section>
  )
}

/** A link back out to another page (breadcrumbs, the case's record). */
export function OpenLink({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  if (!onClick) return <span>{children}</span>
  return (
    <button type="button" className="inline-flex items-center gap-1 hover:underline" onClick={onClick}>
      {children}
      <ExternalLink className="size-3" />
    </button>
  )
}
