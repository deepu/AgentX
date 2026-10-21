/**
 * The Entities page of a domain (24 §14): the types it keeps (how many, under what, their
 * statuses), and for one type its Records (a view: table or board, a filter that says plainly
 * what is wrong with it, sort, group, columns, shared views and "Save as my view") and its
 * Definition (fields with type, required, where each comes from and who can see it; connections;
 * the lifecycle with its moves and who may make them; rules; the playbooks that use it).
 * Presentational: the container runs the queries.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowUpDown, Boxes, Columns3, Database, Filter, Kanban, Link2, Save, Table2 } from 'lucide-react'
import type { MwDomain, MwEntityType, MwRecordQueryInput, MwRecordQueryResult, MwSaveViewInput, MwView } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { cn } from '@/lib/utils'
import { humanize } from '../format'
import { Pill } from '../playbook/Tags'
import { FieldSourceBadge, StatusPill } from '../records/RecordBlocks'
import { cardColumns, entityTitle, formatTypedValue, groupRows, statusLabel } from '../records/record-model'
import { LifecycleDiagram } from './LifecycleDiagram'

// ---------------------------------------------------------------- home

export function EntitiesHome({ domain, types, onOpenEntity }: { domain: MwDomain; types: MwEntityType[]; onOpenEntity: (key: string) => void }) {
  const { t } = useTranslation()
  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Boxes className="size-4" /></div>}
        title={t('memwise.entities.title')}
        tagline={t('memwise.entities.description')}
        meta={<span>{domain.name}</span>}
      />
      {domain.entities.length === 0 ? (
        <EntityListEmptyScreen icon={<Database />} title={t('memwise.entities.emptyTitle')} description={t('memwise.entities.emptyDescription')} />
      ) : (
        <Info_Section title={t('memwise.entities.all')} count={domain.entities.length}>
          <ul className="divide-y divide-separator" data-entity-types>
            {domain.entities.map(e => {
              const type = types.find(x => x.key === e.key)
              const usedBy = type?.definition?.usedBy.length ?? 0
              return (
                <li key={e.key}>
                  <button type="button" className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-fill-hover" onClick={() => onOpenEntity(e.key)} data-entity={e.key}>
                    <Database className="mt-0.5 size-4 shrink-0 text-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="text-label font-medium text-foreground">{e.title}</span>
                        <span className="text-label-sm tabular-nums text-tertiary">{t('memwise.entities.records', { count: e.count })}</span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-label-sm text-secondary">
                        {e.parent && <span>{t('memwise.entities.under', { parent: e.parent })}</span>}
                        {e.lifecycle?.length ? <span>{e.lifecycle.map(statusLabel).join(' → ')}</span> : null}
                        {usedBy > 0 && <span>{t('memwise.entities.usedByCount', { count: usedBy })}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Info_Section>
      )}
    </Info_Page.Content>
  )
}

// ---------------------------------------------------------------- records view state

export interface RecordsViewState {
  viewId?: string
  filter: string
  sort?: { field: string; desc?: boolean }
  group?: string
  columns?: string[]
  layout: 'table' | 'board'
}

export function viewToState(view?: MwView | null): RecordsViewState {
  if (!view) return { filter: '', layout: 'table' }
  return {
    viewId: view.id,
    filter: view.filter ?? '',
    ...(view.sort?.[0] ? { sort: view.sort[0] } : {}),
    ...(view.group ? { group: view.group } : view.layout === 'board' ? { group: 'status' } : {}),
    ...(view.columns ? { columns: view.columns } : {}),
    layout: view.layout,
  }
}

export function stateToQuery(entity: string, domain: string, s: RecordsViewState, limit = 100): MwRecordQueryInput {
  return {
    entity,
    domain,
    ...(s.filter.trim() ? { filter: s.filter.trim() } : {}),
    ...(s.sort ? { sort: [s.sort] } : {}),
    ...(s.layout === 'board' || s.group ? { group: s.group ?? 'status' } : {}),
    ...(s.columns ? { columns: s.columns } : {}),
    limit,
  }
}

// ---------------------------------------------------------------- one entity

export interface EntityViewProps {
  domain: MwDomain
  type: MwEntityType
  tab: 'records' | 'definition'
  onTab: (tab: 'records' | 'definition') => void
  views: MwView[]
  state: RecordsViewState
  onState: (s: RecordsViewState) => void
  result: MwRecordQueryResult | null
  /** The query failed: most often the filter can't be read. */
  error?: string | null
  loading?: boolean
  onOpenRecord?: (entity: string, id: string) => void
  onOpenPlaybook?: (workflowId: string) => void
  onSaveView?: (view: MwSaveViewInput['view']) => Promise<MwView>
}

export function EntityView({ domain, type, tab, onTab, ...rest }: EntityViewProps) {
  const { t } = useTranslation()
  const summary = domain.entities.find(e => e.key === type.key)
  return (
    <Info_Page.Content wide={tab === 'records'}>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary"><Database className="size-4" /></div>}
        title={summary?.title ?? humanize(type.name)}
        meta={
          <>
            <span>{domain.name}</span>
            {summary && <span className="tabular-nums">{t('memwise.entities.records', { count: summary.count })}</span>}
            {type.definition?.parent && <span>{t('memwise.entities.eachUnder', { parent: entityTitle(domain.entities, type.definition.parent.entity) })}</span>}
          </>
        }
      />
      <Tabs value={tab} onValueChange={v => onTab(v as 'records' | 'definition')}>
        <TabsList>
          <TabsTrigger value="records"><Table2 />{t('memwise.entities.tabRecords')}</TabsTrigger>
          <TabsTrigger value="definition">{t('memwise.entities.tabDefinition')}</TabsTrigger>
        </TabsList>
        <TabsContent value="records" className="mt-4 space-y-4">
          <EntityRecordsTab domain={domain} type={type} {...rest} />
        </TabsContent>
        <TabsContent value="definition" className="mt-4 space-y-6">
          <EntityDefinitionTab domain={domain} type={type} onOpenPlaybook={rest.onOpenPlaybook} />
        </TabsContent>
      </Tabs>
    </Info_Page.Content>
  )
}

const NONE = '__none__'

export function EntityRecordsTab({ domain, type, views, state, onState, result, error, loading, onOpenRecord, onSaveView }: Omit<EntityViewProps, 'tab' | 'onTab' | 'onOpenPlaybook'>) {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = React.useState(state.filter)
  const [choosingColumns, setChoosingColumns] = React.useState(false)
  const [saving, setSaving] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  React.useEffect(() => setFilter(state.filter), [state.filter])
  const mine = views.filter(v => v.entity === (type.key ?? type.name))
  const allColumns = result?.columns ?? type.fields.map(f => ({ name: f.name, label: humanize(f.name), type: f.type }))
  const shownColumns = state.columns ? allColumns.filter(c => state.columns!.includes(c.name)) : allColumns
  const apply = () => onState({ ...state, filter, viewId: undefined })

  const save = async () => {
    if (!onSaveView || !saving?.trim()) return
    setSaveError(null)
    try {
      const view = await onSaveView({
        id: '',
        title: saving.trim(),
        entity: type.key ?? type.name,
        layout: state.layout,
        ...(state.filter ? { filter: state.filter } : {}),
        ...(state.sort ? { sort: [state.sort] } : {}),
        ...(state.group ? { group: state.group } : {}),
        ...(state.columns ? { columns: state.columns } : {}),
      })
      setSaving(null)
      onState({ ...state, viewId: view.id })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5" data-views>
        <Button size="sm" variant={!state.viewId ? 'secondary' : 'ghost'} onClick={() => onState({ filter: '', layout: 'table' })}>{t('memwise.entities.allRecords')}</Button>
        {mine.map(v => (
          <Button key={v.id} size="sm" variant={state.viewId === v.id ? 'secondary' : 'ghost'} onClick={() => onState(viewToState(v))} data-view={v.id}>
            {v.layout === 'board' ? <Kanban /> : null}
            {v.title}
            {v.personal && <span className="text-tertiary">· {t('memwise.entities.mine')}</span>}
          </Button>
        ))}
        {onSaveView && saving === null && (
          <Button size="sm" variant="ghost" onClick={() => setSaving('')} data-action="save-view"><Save />{t('memwise.entities.saveAsMine')}</Button>
        )}
      </div>
      {saving !== null && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void save() }}>
          <Input className="h-8 w-64" value={saving} onChange={e => setSaving(e.target.value)} placeholder={t('memwise.entities.viewName')} autoFocus aria-label={t('memwise.entities.viewName')} />
          <Button size="sm" type="submit" variant="primary" disabled={!saving.trim()}>{t('common.save')}</Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => { setSaving(null); setSaveError(null) }}>{t('common.cancel')}</Button>
          {saveError && <span className="text-label-sm text-destructive" role="alert">{saveError}</span>}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2" data-view-controls>
        <form className="flex min-w-[16rem] flex-1 items-center gap-2" onSubmit={e => { e.preventDefault(); apply() }}>
          <Filter className="size-4 shrink-0 text-tertiary" />
          <Input className="h-8 flex-1 font-mono text-label-sm" value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('memwise.entities.filterPlaceholder')} aria-label={t('memwise.entities.filter')} aria-invalid={!!error || undefined} data-filter />
          {filter !== state.filter && <Button size="sm" type="submit" variant="secondary">{t('memwise.entities.applyFilter')}</Button>}
        </form>
        <Select value={state.sort?.field ?? NONE} onValueChange={v => onState({ ...state, viewId: undefined, sort: v === NONE ? undefined : { field: v, desc: state.sort?.desc } })}>
          <SelectTrigger className="h-8 w-auto gap-1.5" aria-label={t('memwise.entities.sort')}><ArrowUpDown className="size-3.5" /><SelectValue placeholder={t('memwise.entities.sort')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('memwise.entities.noSort')}</SelectItem>
            {allColumns.map(c => <SelectItem key={c.name} value={c.name}>{t('memwise.entities.sortBy', { field: c.label })}</SelectItem>)}
          </SelectContent>
        </Select>
        {state.sort && (
          <Button size="sm" variant="ghost" onClick={() => onState({ ...state, viewId: undefined, sort: { ...state.sort!, desc: !state.sort!.desc } })} data-action="sort-direction">
            {state.sort.desc ? t('memwise.entities.descending') : t('memwise.entities.ascending')}
          </Button>
        )}
        <Select value={state.group ?? NONE} onValueChange={v => onState({ ...state, viewId: undefined, group: v === NONE ? undefined : v })}>
          <SelectTrigger className="h-8 w-auto" aria-label={t('memwise.entities.group')}><SelectValue placeholder={t('memwise.entities.group')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('memwise.entities.noGroup')}</SelectItem>
            {state.group && !allColumns.some(c => c.name === state.group) && <SelectItem value={state.group}>{t('memwise.entities.groupBy', { field: humanize(state.group) })}</SelectItem>}
            {allColumns.map(c => <SelectItem key={c.name} value={c.name}>{t('memwise.entities.groupBy', { field: c.label })}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setChoosingColumns(v => !v)} aria-expanded={choosingColumns} data-action="columns"><Columns3 />{t('memwise.entities.columns')}</Button>
        <span className="inline-flex rounded-md bg-fill-hover p-0.5">
          <Button size="sm" variant={state.layout === 'table' ? 'secondary' : 'ghost'} onClick={() => onState({ ...state, viewId: undefined, layout: 'table' })} aria-label={t('memwise.entities.table')}><Table2 /></Button>
          <Button size="sm" variant={state.layout === 'board' ? 'secondary' : 'ghost'} onClick={() => onState({ ...state, viewId: undefined, layout: 'board', group: state.group ?? 'status' })} aria-label={t('memwise.entities.board')}><Kanban /></Button>
        </span>
      </div>

      {choosingColumns && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md bg-fill-hover/50 px-3 py-2" data-column-chooser>
          {allColumns.map(c => {
            const on = !state.columns || state.columns.includes(c.name)
            return (
              <label key={c.name} className="flex items-center gap-1.5 text-label-sm text-foreground">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const current = state.columns ?? allColumns.map(x => x.name)
                    const next = on ? current.filter(n => n !== c.name) : [...current, c.name]
                    onState({ ...state, viewId: undefined, columns: next })
                  }}
                />
                {c.label}
              </label>
            )
          })}
        </div>
      )}

      {error ? (
        <Info_Alert variant="error" icon={<AlertTriangle />} data-filter-error>
          <Info_Alert.Title>{state.filter ? t('memwise.entities.filterError') : t('memwise.entities.queryError')}</Info_Alert.Title>
          <Info_Alert.Description>{error}</Info_Alert.Description>
        </Info_Alert>
      ) : !result ? (
        <p className="text-label text-tertiary">{loading ? t('memwise.entities.loading') : ''}</p>
      ) : result.rows.length === 0 ? (
        <EntityListEmptyScreen icon={<Database />} title={t('memwise.records.emptyTitle')} description={state.filter ? t('memwise.entities.noMatch') : t('memwise.records.emptyDescription')} />
      ) : state.layout === 'board' ? (
        <Board result={result} group={state.group ?? 'status'} columns={shownColumns} onOpenRecord={onOpenRecord} />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-raised shadow-elev-1">
          <table className="w-full text-label" data-records-table={type.key}>
            <thead>
              <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                <th className="px-4 py-2 font-medium">{humanize(type.name)}</th>
                {shownColumns.map(c => (
                  <th key={c.name} className="px-4 py-2 font-medium">
                    {c.label}
                    {'calculated' in c && c.calculated ? <span className="ml-1 font-normal">· {t('memwise.record.source.calculated').toLowerCase()}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(state.group ? groupRows(result, state.group) : [{ key: null, title: null, count: result.rows.length, rows: result.rows }]).map(g => (
                <React.Fragment key={g.key ?? NONE}>
                  {state.group && (
                    <tr className="border-b border-separator bg-fill-hover/50" data-table-group={g.key ?? ''}>
                      <td colSpan={shownColumns.length + 1} className="px-4 py-1.5 text-label-sm font-medium text-secondary">
                        {state.group === 'status' ? <StatusPill status={g.key ?? undefined} /> : (g.title ?? t('memwise.entities.noValue'))}
                        <span className="ml-2 tabular-nums text-tertiary">{g.count}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(row => (
                    <tr key={row.id} className={cn('border-b border-separator last:border-0', onOpenRecord && 'cursor-pointer hover:bg-fill-hover')} onClick={() => onOpenRecord?.(row.entity, row.id)} data-row={row.id}>
                      <td className="px-4 py-2 font-medium text-foreground">{row.title}</td>
                      {shownColumns.map(c => (
                        <td key={c.name} className="px-4 py-2 text-secondary">
                          {row.hidden.includes(c.name) ? <span className="text-tertiary">{t('memwise.case.restrictedValue')}</span>
                            : c.type === 'Lifecycle' || c.name === 'status' ? <StatusPill status={(row.values[c.name] ?? (c.name === 'status' ? row.status : undefined)) as string | undefined} />
                            : formatTypedValue(c.type, row.values[c.name], t, i18n.language, row.refs?.[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          <p className="border-t border-separator px-4 py-2 text-label-sm text-tertiary">{t('memwise.entities.showing', { shown: result.rows.length, total: result.total })}</p>
        </div>
      )}
    </>
  )
}

function Board({ result, group, columns, onOpenRecord }: { result: MwRecordQueryResult; group: string; columns: MwRecordQueryResult['columns']; onOpenRecord?: (entity: string, id: string) => void }) {
  const { t, i18n } = useTranslation()
  // A group by a reference is named by the record's title; a card skips what its title already says.
  const extra = cardColumns(columns, result.rows, group)
  return (
    <div className="flex gap-3 overflow-x-auto pb-2" data-board={group}>
      {groupRows(result, group).map(({ key: k, title, count, rows }) => {
        return (
          <div key={k ?? NONE} className="w-64 shrink-0 space-y-2 rounded-lg bg-fill-hover/50 p-2" data-board-column={k ?? ''}>
            <div className="flex items-center gap-2 px-1 text-label-sm font-medium text-secondary">
              {group === 'status' ? <StatusPill status={k ?? undefined} /> : <span>{title ?? t('memwise.entities.noValue')}</span>}
              <span className="tabular-nums text-tertiary">{count}</span>
            </div>
            {rows.map(row => (
              <button key={row.id} type="button" className="block w-full rounded-md bg-raised p-2.5 text-left shadow-elev-1 hover:bg-fill-hover" onClick={() => onOpenRecord?.(row.entity, row.id)}>
                <span className="block text-label font-medium text-foreground">{row.title}</span>
                {extra.map(c => (
                  <span key={c.name} className="block text-label-sm text-secondary">{row.hidden.includes(c.name) ? t('memwise.case.restrictedValue') : formatTypedValue(c.type, row.values[c.name], t, i18n.language, row.refs?.[c.name])}</span>
                ))}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- definition

export function EntityDefinitionTab({ domain, type, onOpenPlaybook }: { domain: MwDomain; type: MwEntityType; onOpenPlaybook?: (workflowId: string) => void }) {
  const { t } = useTranslation()
  const def = type.definition
  const fields = [...type.fields]
  for (const c of def?.calculated ?? []) if (!fields.some(f => f.name === c.name)) fields.push({ name: c.name, type: c.kind === 'rollup' ? 'Rollup' : 'Formula', schema: {} })
  const calc = new Map((def?.calculated ?? []).map(c => [c.name, c]))
  return (
    <>
      <Info_Section title={t('memwise.entities.fields')} count={fields.length} description={t('memwise.entities.fieldsHint')}>
        <div className="overflow-x-auto">
          <table className="w-full text-label" data-definition-fields>
            <thead>
              <tr className="border-b border-separator text-left text-label-sm text-tertiary">
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.field')}</th>
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.type')}</th>
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.required')}</th>
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.comesFrom')}</th>
                <th className="px-3.5 py-2 font-medium">{t('memwise.entities.whoSees')}</th>
              </tr>
            </thead>
            <tbody>
              {fields.map(f => {
                const source = def?.sources[f.name]
                const c = calc.get(f.name)
                return (
                  <tr key={f.name} className="border-b border-separator align-top last:border-0" data-definition-field={f.name}>
                    <td className="px-3.5 py-2 font-medium text-foreground">{humanize(f.name)}</td>
                    <td className="px-3.5 py-2 text-secondary">
                      {typeInWords(f.type, domain, t)}
                      {f.description && <span className="block text-label-sm text-tertiary">{f.description}</span>}
                      {c && <span className="block text-label-sm text-tertiary">{c.summary}</span>}
                    </td>
                    <td className="px-3.5 py-2 text-secondary">{f.required ? t('memwise.form.yes') : t('memwise.form.no')}</td>
                    <td className="px-3.5 py-2">{source ? <FieldSourceBadge source={source} /> : <span className="text-tertiary">—</span>}</td>
                    <td className="px-3.5 py-2 text-secondary">{f.access?.length ? t('memwise.entities.onlyRoles', { roles: f.access.map(humanize).join(', ') }) : t('memwise.entities.everyone')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Info_Section>

      {def && (def.relationships.length > 0 || def.links.length > 0) && (
        <Info_Section title={t('memwise.entities.connections')}>
          <ul className="divide-y divide-separator" data-connections>
            {def.relationships.map(r => (
              <li key={r.name} className="flex flex-wrap items-center gap-x-2 px-3.5 py-2 text-label">
                <span className="text-secondary">{r.cardinality === 'one' ? t('memwise.entities.belongsTo') : t('memwise.entities.hasMany')}</span>
                <span className="font-medium text-foreground">{entityTitle(domain.entities, r.target)}</span>
                {r.via && <span className="text-label-sm text-tertiary">{t('memwise.entities.via', { via: r.via })}</span>}
                {def.parent?.relationship === r.name && <Pill className="bg-fill-hover text-secondary">{t('memwise.entities.pageParent')}</Pill>}
              </li>
            ))}
            {def.links.map(l => (
              <li key={l.target} className="flex flex-wrap items-center gap-x-2 px-3.5 py-2 text-label" data-link={l.target}>
                <Link2 className="size-3.5 text-tertiary" />
                <span className="text-secondary">{t('memwise.entities.linkedTo')}</span>
                <span className="font-medium text-foreground">{l.target}</span>
                <span className="text-label-sm text-tertiary">
                  {t('memwise.entities.matchedOn', { fields: Object.keys(l.match).map(humanize).join(', ') })}
                  {l.follow.length > 0 && ` · ${t('memwise.entities.follows', { fields: l.follow.map(humanize).join(', ') })}`}
                </span>
              </li>
            ))}
          </ul>
        </Info_Section>
      )}

      {def?.lifecycle && (
        <Info_Section title={t('memwise.record.lifecycle')} description={t('memwise.entities.lifecycleHint')}>
          <LifecycleDiagram lifecycle={def.lifecycle} />
        </Info_Section>
      )}

      {def && def.invariants.length > 0 && (
        <Info_Section title={t('memwise.entities.rules')} count={def.invariants.length}>
          <ul className="divide-y divide-separator" data-invariants>
            {def.invariants.map((rule, i) => <li key={i} className="px-3.5 py-2 text-label text-foreground">{rule}</li>)}
          </ul>
        </Info_Section>
      )}

      {def && def.usedBy.length > 0 && (
        <Info_Section title={t('memwise.entities.usedBy')} count={def.usedBy.length}>
          <div className="flex flex-wrap gap-1.5 p-3" data-used-by>
            {def.usedBy.map(u => (
              <Button key={u.workflowId} size="sm" variant="ghost" onClick={() => onOpenPlaybook?.(u.workflowId)} disabled={!onOpenPlaybook}>{u.title}</Button>
            ))}
          </div>
        </Info_Section>
      )}
      {!def && <Info_Badge color="muted">{t('memwise.entities.noDefinition')}</Info_Badge>}
    </>
  )
}

/** `Ref<Study>` → "Link to Study", `List<Person>` → "List of People", others by name. */
function typeInWords(type: string, domain: MwDomain, t: ReturnType<typeof useTranslation>['t']): string {
  const m = /^(Ref|List)<\s*([\w.]+)\s*>$/.exec(type)
  if (m) {
    const target = domain.entities.find(e => e.entity === m[2] || e.key === m[2] || e.key.endsWith(`.${m[2]!.toLowerCase()}`))
    const name = m[1] === 'Ref' ? (target?.entity ?? m[2]!) : (target?.title ?? m[2]!)
    return m[1] === 'Ref' ? t('memwise.entities.linkTo', { entity: humanize(name) }) : t('memwise.entities.listOf', { entity: name })
  }
  return humanize(type)
}
