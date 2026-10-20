/**
 * The binding review screen (22 §10): how one plugin is bound into this domain. Tools with their
 * class and where it came from, capabilities, entities and field renames, record mappings with the
 * dry run's sample records before and after, identity rules, the plugin's default policy beside
 * the domain's tightening, and the dry-run report. In edit mode (the bind-plugin `fix` step, or
 * the plugin page while a binding is being made) the choices are editable and saved into the
 * binding draft; the caller renders the step's buttons through `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Save, XCircle } from 'lucide-react'
import type {
  MwBinding, MwBindingView, MwEffectClass, MwFieldMapping, MwMappedRecord, MwRole, MwTreatment, MwWriteDraftResult,
} from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { absoluteTime, formatValueInline, humanize, relativeTime, resultMessage } from '../format'
import { EffectBadge, Pill } from '../playbook/Tags'
import { effectLabel, subjectLabel, valueLabel } from '../playbook/labels'
import { DiagnosticList, ExampleRow } from '../draft/ChecksView'
import {
  allowedClasses, applyBindingSections, changedSections, EFFECT_ORDER, loosens, parseTransformText, setCapability, setEntity,
  setFieldRename, setIdentity, setPolicyEffect, setRecordEntity, setRecordField, setRole, setToolClass, toolChoice, transformLabel,
  transformText, TREATMENT_ORDER, type ToolChoice,
} from './binding-model'
import { beforeValue, classSourceLabel, samplesOf } from './plugin-model'

export type BindingReviewMode = 'edit' | 'review' | 'view'

export interface BindingReviewActionsContext {
  /** Unsaved edits. */
  dirty: boolean
  /** Saves the edits into the draft; resolves false when it was refused. */
  save: () => Promise<boolean>
  busy: boolean
}

export interface BindingReviewProps {
  view: MwBindingView
  /** The domain's roles, for the role mapping. */
  roles?: MwRole[]
  mode: BindingReviewMode
  /** Writes the binding file into the draft (`memwise:drafts:write`). */
  onSave?: (input: { path: string; content: string; summary: string }) => Promise<MwWriteDraftResult>
  /** The step's buttons (Done, Approve / Ask for changes), rendered under the review. */
  actions?: (ctx: BindingReviewActionsContext) => React.ReactNode
  now?: number
}

const NONE = '__none__'

function Choice({ value, options, onChange, label, disabled, noneLabel, className }: {
  value: string | undefined
  options: { value: string; label: string }[]
  onChange: (value: string | undefined) => void
  label: string
  disabled?: boolean
  /** Offer "none" (clears the choice) with this label. */
  noneLabel?: string
  className?: string
}) {
  const known = options.some(o => o.value === value)
  const all = value && !known ? [{ value, label: value }, ...options] : options
  return (
    <Select value={value ?? NONE} onValueChange={v => onChange(v === NONE ? undefined : v)} disabled={disabled}>
      <SelectTrigger className={cn('h-control text-label-sm', className)} aria-label={label} data-choice={label}>
        <SelectValue placeholder={noneLabel} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {all.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12px] text-foreground', className)}>{children}</span>
}

function Row({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-label', className)} {...rest}>{children}</div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-label text-tertiary">{children}</p>
}

export function BindingReview({ view, roles = [], mode, onSave, actions, now }: BindingReviewProps) {
  const { t, i18n } = useTranslation()
  const editing = mode === 'edit' && view.editable
  const [binding, setBinding] = React.useState<MwBinding>(view.binding)
  const [busy, setBusy] = React.useState(false)
  const [saveResult, setSaveResult] = React.useState<MwWriteDraftResult | null>(null)

  // A new version of the file (saved here, or by the binder agent) replaces the local edits.
  React.useEffect(() => {
    setBinding(view.binding)
    setSaveResult(null)
  }, [view.text, view.draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirtySections = React.useMemo(() => changedSections(view.binding, binding), [view.binding, binding])
  const dirty = dirtySections.length > 0

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!dirty) return true
    if (!onSave) return false
    setBusy(true)
    try {
      const content = applyBindingSections(view.text, binding, dirtySections)
      const summary = t('memwise.binding.saveSummary', { sections: dirtySections.map(s => t(`memwise.binding.section.${s}`)).join(', ') })
      const r = await onSave({ path: view.path, content, summary })
      setSaveResult(r)
      return r.applied
    } catch (err) {
      setSaveResult({ applied: false, diagnostics: [], message: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      setBusy(false)
    }
  }, [dirty, onSave, view.text, view.path, binding, dirtySections, t])

  const edit = (next: MwBinding) => { if (editing) setBinding(next) }
  const domainEntities = view.domainEntities
  const entityOptions = domainEntities.map(e => ({ value: e.name, label: e.name }))
  const fieldsOf = (entity: string | undefined) => domainEntities.find(e => e.name === entity)?.fields ?? []

  return (
    <div className="space-y-6" data-binding-review={view.pluginId} data-binding-mode={editing ? 'edit' : mode}>
      {/* What is still open, and where the dry run stands */}
      {view.gaps.length > 0 && (
        <Info_Alert variant="warning" icon={<AlertTriangle />} data-binding-gaps={view.gaps.length}>
          <Info_Alert.Title>{t('memwise.binding.gapsTitle', { count: view.gaps.length })}</Info_Alert.Title>
          <Info_Alert.Description>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {view.gaps.map((g, i) => (
                <li key={`${g.kind}-${g.subject}-${i}`}>
                  <Mono>{g.subject}</Mono>: {g.message}
                  {g.suggestions?.length ? <span className="text-tertiary"> ({t('memwise.binding.suggestions', { list: g.suggestions.join(', ') })})</span> : null}
                </li>
              ))}
            </ul>
          </Info_Alert.Description>
        </Info_Alert>
      )}
      {!view.editable && view.draftId === undefined && view.binding.frozen && (
        <p className="text-label-sm text-tertiary" data-binding-frozen>
          {t('memwise.binding.frozen', {
            version: view.binding.version,
            name: view.binding.frozen.byName ?? view.binding.frozen.by,
            time: relativeTime(view.binding.frozen.at, now, i18n.language),
          })}
        </p>
      )}

      {/* Tools */}
      <Info_Section title={t('memwise.binding.section.tools')} count={view.tools.length} description={t('memwise.binding.toolsDescription')}>
        {view.tools.length === 0 ? <Empty>{t('memwise.binding.noTools')}</Empty> : (
          <ul className="divide-y divide-separator">
            {view.tools.map(tool => {
              const choice = toolChoice(binding, tool.name)
              const chosen = choice === 'off' || choice === 'unset' ? undefined : choice
              const shown: MwEffectClass | undefined = chosen ?? (choice === 'unset' ? tool.declared ?? tool.hinted : undefined)
              const options = [
                ...allowedClasses(tool.declared).map(c => ({ value: c, label: effectLabel(c, t) })),
                { value: 'off', label: t('memwise.binding.toolOff') },
              ]
              const changed = choice !== toolChoice(view.binding, tool.name)
              return (
                <li key={tool.name} className="px-4 py-2.5" data-tool={tool.name} data-tool-class={choice === 'unset' ? tool.effect ?? 'none' : choice}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Mono className="font-medium">{tool.name}</Mono>
                    {tool.capability && <Info_Badge color="muted">{t('memwise.binding.provides', { capability: tool.capability })}</Info_Badge>}
                    <span className="ml-auto flex items-center gap-2">
                      {editing ? (
                        <Choice
                          className="w-44"
                          label={t('memwise.binding.toolClassFor', { tool: tool.name })}
                          value={choice === 'unset' ? (tool.declared ?? undefined) : choice}
                          options={options}
                          noneLabel={tool.declared ? undefined : t('memwise.binding.unclassified')}
                          onChange={v => edit(setToolClass(binding, tool.name, (v ?? 'unset') as ToolChoice))}
                        />
                      ) : choice === 'off' || tool.off ? (
                        <Pill className="bg-fill-hover text-tertiary">{t('memwise.binding.toolOff')}</Pill>
                      ) : (
                        <EffectBadge effect={shown ?? tool.effect ?? 'irreversible'} classified={!!(shown ?? tool.effect)} />
                      )}
                    </span>
                  </div>
                  {tool.description && <p className="mt-0.5 text-label-sm text-secondary">{tool.description}</p>}
                  <p className="mt-0.5 text-label-sm text-tertiary" data-class-from={changed ? 'person' : tool.from}>
                    {changed ? t('memwise.plugins.classFrom.person') : classSourceLabel(tool.from, t, tool)}
                    {tool.declared && tool.from !== 'declared' && <> · {t('memwise.binding.declaredAs', { effect: effectLabel(tool.declared, t) })}</>}
                    {tool.hinted && tool.from !== 'annotations' && <> · {t('memwise.binding.hintedAs', { effect: effectLabel(tool.hinted, t) })}</>}
                    {!changed && tool.reason && <> · “{tool.reason}”</>}
                  </p>
                  {loosens(tool.declared, chosen) && (
                    <p className="mt-0.5 text-label-sm text-destructive" role="alert">{t('memwise.binding.loosens')}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Info_Section>

      {/* Capabilities */}
      {view.capabilities.length > 0 && (
        <Info_Section title={t('memwise.binding.section.capabilities')} count={view.capabilities.length} description={t('memwise.binding.capabilitiesDescription')}>
          <div className="divide-y divide-separator">
            {view.capabilities.map(cap => {
              const current = binding.capabilities[cap.name]
              return (
                <Row key={cap.name} data-capability={cap.name} data-provider={current ?? ''}>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{humanize(cap.name)}</span>
                    <span className="ml-2 text-label-sm text-tertiary">{t('memwise.binding.capabilityAs', { name: cap.as })}</span>
                    {cap.optional && <span className="ml-2 text-label-sm text-tertiary">{t('memwise.form.optional')}</span>}
                  </span>
                  {editing ? (
                    <Choice
                      className="w-56"
                      label={t('memwise.binding.providerFor', { capability: cap.name })}
                      value={current}
                      options={cap.providers.map(p => ({ value: p, label: p }))}
                      noneLabel={t('memwise.binding.noProvider')}
                      onChange={v => edit(setCapability(binding, cap.name, v))}
                    />
                  ) : current ? <Mono>{current}</Mono> : (
                    <span className={cn('text-label-sm', cap.optional ? 'text-tertiary' : 'text-destructive')}>{t('memwise.binding.noProvider')}</span>
                  )}
                </Row>
              )
            })}
          </div>
        </Info_Section>
      )}

      {/* Entities and field renames */}
      {view.entities.length > 0 && (
        <Info_Section title={t('memwise.binding.section.entities')} count={view.entities.length} description={t('memwise.binding.entitiesDescription')}>
          <div className="divide-y divide-separator">
            {view.entities.map(pe => {
              const mapped = binding.entities[pe.name]
              const domainFields = fieldsOf(mapped?.entity)
              return (
                <div key={pe.name} data-entity={pe.name} data-maps-to={mapped?.entity ?? ''}>
                  <Row>
                    <span className="min-w-0 flex-1 font-medium">{pe.name}</span>
                    <span className="text-label-sm text-tertiary">→</span>
                    {editing ? (
                      <Choice className="w-48" label={t('memwise.binding.entityFor', { entity: pe.name })} value={mapped?.entity} options={entityOptions}
                        noneLabel={t('memwise.binding.notMapped')} onChange={v => edit(setEntity(binding, pe.name, v))} />
                    ) : <span className="font-medium">{mapped?.entity ?? <span className="text-destructive">{t('memwise.binding.notMapped')}</span>}</span>}
                  </Row>
                  {mapped && (
                    <table className="mb-2 w-full text-label-sm">
                      <tbody>
                        {pe.fields.map(f => {
                          const to = mapped.fields[f.name]
                          return (
                            <tr key={f.name} className="align-middle" data-field={f.name} data-renamed-to={to ?? ''}>
                              <td className="w-1/2 py-1 pr-2 pl-8"><Mono>{f.name}</Mono> <span className="text-tertiary">{f.type}{f.required ? ' *' : ''}</span></td>
                              <td className="py-1 pr-4">
                                {editing ? (
                                  <Choice label={t('memwise.binding.fieldFor', { field: f.name })} value={to}
                                    options={domainFields.map(d => ({ value: d.name, label: `${d.name} · ${d.type}` }))}
                                    noneLabel={t('memwise.binding.notMapped')} onChange={v => edit(setFieldRename(binding, pe.name, f.name, v))} />
                                ) : to ? <Mono>{to}</Mono> : <span className={f.required ? 'text-destructive' : 'text-tertiary'}>{t('memwise.binding.notMapped')}</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        </Info_Section>
      )}

      {/* Roles */}
      {view.roles.length > 0 && (
        <Info_Section title={t('memwise.binding.section.roles')} count={view.roles.length}>
          <div className="divide-y divide-separator">
            {view.roles.map(r => {
              const to = binding.roles[r.id]
              return (
                <Row key={r.id} data-role={r.id} data-maps-to={to ?? ''}>
                  <span className="min-w-0 flex-1">{r.title} <span className="text-label-sm text-tertiary">({r.id})</span></span>
                  <span className="text-label-sm text-tertiary">→</span>
                  {editing ? (
                    <Choice className="w-48" label={t('memwise.binding.roleFor', { role: r.id })} value={to}
                      options={roles.map(x => ({ value: x.id, label: x.title }))} noneLabel={t('memwise.binding.notMapped')}
                      onChange={v => edit(setRole(binding, r.id, v))} />
                  ) : <span>{(to && roles.find(x => x.id === to)?.title) ?? to ?? <span className="text-destructive">{t('memwise.binding.notMapped')}</span>}</span>}
                </Row>
              )
            })}
          </div>
        </Info_Section>
      )}

      {/* Record mappings, samples and identity rules */}
      {view.records.map(src => (
        <RecordMapping
          key={src.name}
          source={src}
          binding={binding}
          editing={editing}
          entityOptions={entityOptions}
          domainFields={fieldsOf(binding.records[src.name]?.entity)}
          samples={samplesOf(view.report?.records, src.name)}
          onChange={edit}
        />
      ))}

      {/* Policy: the plugin's defaults and the domain's tightening */}
      <Info_Section title={t('memwise.binding.section.policy')} description={t('memwise.binding.policyDescription')}>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <div data-policy="plugin">
            <h4 className="mb-1.5 text-label-sm font-semibold text-secondary">{t('memwise.binding.pluginPolicy')}</h4>
            {view.pluginPolicy.length === 0 ? <p className="text-label-sm text-tertiary">{t('memwise.binding.noPolicy')}</p> : (
              <ul className="space-y-1 text-label">
                {view.pluginPolicy.map((l, i) => <li key={i}><span className="text-secondary">{subjectLabel(l.subject, t)}:</span> {valueLabel(l.value, t)}</li>)}
              </ul>
            )}
          </div>
          <div data-policy="domain">
            <h4 className="mb-1.5 text-label-sm font-semibold text-secondary">{t('memwise.binding.domainPolicy')}</h4>
            {editing ? (
              <div className="space-y-1.5">
                {EFFECT_ORDER.map(cls => (
                  <div key={cls} className="flex items-center gap-2 text-label">
                    <span className="w-28 shrink-0 text-secondary">{effectLabel(cls, t)}</span>
                    <Choice className="flex-1" label={t('memwise.binding.treatmentFor', { effect: cls })} value={binding.policy?.effects?.[cls]}
                      options={TREATMENT_ORDER.map(x => ({ value: x, label: valueLabel(x, t) }))} noneLabel={t('memwise.binding.pluginDefault')}
                      onChange={v => edit(setPolicyEffect(binding, cls, v as MwTreatment | undefined))} />
                  </div>
                ))}
              </div>
            ) : view.bindingPolicy.length === 0 ? <p className="text-label-sm text-tertiary">{t('memwise.binding.noTightening')}</p> : (
              <ul className="space-y-1 text-label">
                {view.bindingPolicy.map((l, i) => <li key={i}><span className="text-secondary">{subjectLabel(l.subject, t)}:</span> {valueLabel(l.value, t)}</li>)}
              </ul>
            )}
          </div>
        </div>
      </Info_Section>

      {/* The dry run */}
      <DryRunReport view={view} now={now} />

      {/* Save, then the step's own buttons */}
      {editing && onSave && (
        <div className="flex flex-wrap items-center justify-end gap-2" data-binding-dirty={dirty || undefined}>
          {dirty && <span className="mr-auto text-label-sm text-secondary">{t('memwise.binding.unsaved', { count: dirtySections.length })}</span>}
          <Button variant="ghost" onClick={() => setBinding(view.binding)} disabled={!dirty || busy}>{t('memwise.binding.reset')}</Button>
          <Button variant="secondary" onClick={() => void save()} disabled={!dirty || busy} data-action="save-binding">
            <Save />
            {busy ? t('memwise.binding.saving') : t('memwise.binding.save')}
          </Button>
        </div>
      )}
      {saveResult && !saveResult.applied && (
        <Info_Alert variant="error" inline icon={<XCircle />}>
          <Info_Alert.Title>{t('memwise.binding.saveFailed')}</Info_Alert.Title>
          {(saveResult.code || saveResult.message) && <Info_Alert.Description>{resultMessage(saveResult, t)}</Info_Alert.Description>}
        </Info_Alert>
      )}
      {saveResult?.applied && saveResult.diagnostics.length > 0 && (
        <Info_Section title={t('memwise.binding.afterSave')}>
          <DiagnosticList diagnostics={saveResult.diagnostics} />
        </Info_Section>
      )}
      {actions?.({ dirty, save, busy })}
      {view.report && <p className="text-right text-label-sm text-tertiary" title={absoluteTime(view.report.at, i18n.language)}>{t('memwise.binding.reportAt', { time: relativeTime(view.report.at, now, i18n.language) })}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- records

function RecordMapping({ source, binding, editing, entityOptions, domainFields, samples, onChange }: {
  source: MwBindingView['records'][number]
  binding: MwBinding
  editing: boolean
  entityOptions: { value: string; label: string }[]
  domainFields: { name: string; type: string }[]
  samples: MwMappedRecord[]
  onChange: (b: MwBinding) => void
}) {
  const { t, i18n } = useTranslation()
  const rec = binding.records[source.name]
  const sourceFields = Object.keys(source.fields)
  const rows = rec ? [...new Set([...domainFields.map(f => f.name), ...Object.keys(rec.fields)])] : []
  const setMapping = (field: string, m: MwFieldMapping | undefined) => onChange(setRecordField(binding, source.name, field, m))
  const identity = rec?.identity

  return (
    <Info_Section
      title={t('memwise.binding.recordsTitle', { source: source.title ?? humanize(source.name) })}
      description={t('memwise.binding.recordsDescription', { key: source.key })}
      actions={editing ? (
        <Choice className="w-48" label={t('memwise.binding.entityFor', { entity: source.name })} value={rec?.entity} options={entityOptions}
          noneLabel={t('memwise.binding.notMapped')} onChange={v => onChange(setRecordEntity(binding, source.name, v))} />
      ) : rec ? <Info_Badge>{t('memwise.binding.asEntity', { entity: rec.entity })}</Info_Badge> : undefined}
    >
      <div data-record-source={source.name} data-record-entity={rec?.entity ?? ''}>
        {!rec ? <Empty>{t('memwise.binding.recordUnmapped')}</Empty> : (
          <>
            <table className="w-full text-label-sm" data-mapping-table>
              <thead>
                <tr className="border-b border-separator text-left text-tertiary">
                  <th className="px-4 py-2 font-medium">{t('memwise.binding.col.domainField')}</th>
                  <th className="px-2 py-2 font-medium">{t('memwise.binding.col.sourceField')}</th>
                  <th className="px-2 py-2 font-medium">{t('memwise.binding.col.transforms')}</th>
                  <th className="px-4 py-2 font-medium">{t('memwise.binding.col.direction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {rows.map(field => {
                  const m = rec.fields[field]
                  const structured = (m?.transform ?? []).filter(x => typeof x !== 'string')
                  return (
                    <tr key={field} className="align-middle" data-mapped-field={field} data-from={m?.from ?? ''}>
                      <td className="px-4 py-1.5"><Mono>{field}</Mono>{(identity?.keys.includes(field)) && <Info_Badge className="ml-1.5" color="muted">{t('memwise.binding.key')}</Info_Badge>}</td>
                      <td className="px-2 py-1.5">
                        {editing ? (
                          <Choice label={t('memwise.binding.sourceFor', { field })} value={m?.from}
                            options={sourceFields.map(s => ({ value: s, label: `${s} · ${source.fields[s]}` }))} noneLabel={t('memwise.binding.notMapped')}
                            onChange={v => setMapping(field, { ...(m ?? {}), from: v })} />
                        ) : m?.from ? <Mono>← {m.from}</Mono> : <span className="text-tertiary">{m ? '' : t('memwise.binding.notMapped')}</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {editing && m ? (
                          <TransformInput mapping={m} onChange={next => setMapping(field, next)} label={t('memwise.binding.transformsFor', { field })} />
                        ) : <span className="text-secondary">{(m?.transform ?? []).map(transformLabel).join(', ')}</span>}
                        {editing && structured.length > 0 && <span className="ml-1 text-tertiary">+ {structured.map(transformLabel).join(', ')}</span>}
                      </td>
                      <td className="px-4 py-1.5">
                        {editing && m ? (
                          <Choice label={t('memwise.binding.directionFor', { field })} value={m.direction ?? 'read'}
                            options={(['read', 'write', 'both'] as const).map(d => ({ value: d, label: t(`memwise.binding.direction.${d}`) }))}
                            onChange={v => setMapping(field, { ...m, direction: (v ?? 'read') as MwFieldMapping['direction'] })} />
                        ) : m ? <span className="text-secondary">{t(`memwise.binding.direction.${m.direction ?? 'read'}`)}</span> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {/* Identity rules */}
            <div className="border-t border-separator px-4 py-3" data-identity-rules>
              <h4 className="mb-1.5 text-label-sm font-semibold text-secondary">{t('memwise.binding.identity.title')}</h4>
              {editing && identity ? (
                <IdentityEditor rules={identity} fields={rows} onChange={r => onChange(setIdentity(binding, source.name, r))} />
              ) : identity ? (
                <ul className="space-y-0.5 text-label">
                  <li>{t('memwise.binding.identity.keys')}: {identity.keys.length ? identity.keys.map(k => <Mono key={k} className="mr-1.5">{k}</Mono>) : <span className="text-tertiary">{t('memwise.binding.identity.noKeys')}</span>}</li>
                  {identity.fuzzy && <li>{t('memwise.binding.identity.fuzzyLine', { field: identity.fuzzy.field, auto: identity.fuzzy.auto, review: identity.fuzzy.review })}</li>}
                  <li>{identity.createMissing ? t('memwise.binding.identity.createMissing') : t('memwise.binding.identity.leaveUnlinked')}</li>
                </ul>
              ) : null}
            </div>

            {/* Sample records from the dry run, before and after */}
            <div className="border-t border-separator px-4 py-3" data-samples={samples.length}>
              <h4 className="mb-1.5 text-label-sm font-semibold text-secondary">{t('memwise.binding.samples.title')}</h4>
              {samples.length === 0 ? <p className="text-label-sm text-tertiary">{t('memwise.binding.samples.none')}</p> : (
                <div className="space-y-3">
                  {samples.map(s => (
                    <div key={s.externalId} className="rounded-md bg-fill-hover/40 p-2" data-sample={s.externalId}>
                      <p className="mb-1 text-label-sm text-tertiary">{t('memwise.binding.samples.record', { id: s.externalId })}</p>
                      <table className="w-full text-label-sm">
                        <thead>
                          <tr className="text-left text-tertiary">
                            <th className="py-0.5 pr-2 font-medium">{t('memwise.binding.col.domainField')}</th>
                            <th className="py-0.5 pr-2 font-medium">{t('memwise.binding.samples.before')}</th>
                            <th className="py-0.5 font-medium">{t('memwise.binding.samples.after')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(s.values).map(([field, after]) => {
                            const before = beforeValue(s, rec.fields[field]?.from)
                            return (
                              <tr key={field}>
                                <td className="py-0.5 pr-2"><Mono>{field}</Mono></td>
                                <td className="py-0.5 pr-2 text-secondary">{before === undefined ? '—' : formatValueInline(before, t, i18n.language)}</td>
                                <td className="py-0.5">{formatValueInline(after, t, i18n.language)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      {Object.keys(s.extra).length > 0 && (
                        <p className="mt-1 text-label-sm text-tertiary">{t('memwise.binding.samples.extra', { fields: Object.keys(s.extra).join(', ') })}</p>
                      )}
                      {s.errors.map((e, i) => <p key={`e${i}`} className="mt-1 text-label-sm text-destructive">{e}</p>)}
                      {s.roundTrip.map((e, i) => <p key={`r${i}`} className="mt-1 text-label-sm text-info">{t('memwise.binding.samples.roundTrip', { note: e })}</p>)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Info_Section>
  )
}

function TransformInput({ mapping, onChange, label }: { mapping: MwFieldMapping; onChange: (m: MwFieldMapping) => void; label: string }) {
  const { t } = useTranslation()
  const [text, setText] = React.useState(() => transformText(mapping.transform))
  const [unknown, setUnknown] = React.useState<string[]>([])
  React.useEffect(() => { setText(transformText(mapping.transform)) }, [mapping.transform])
  const commit = () => {
    const r = parseTransformText(text, mapping.transform)
    setUnknown(r.unknown)
    onChange({ ...mapping, transform: r.transform })
  }
  return (
    <div>
      <Input className="h-control text-label-sm" aria-label={label} value={text} placeholder="trim, lower" onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
      {unknown.length > 0 && <p className="mt-0.5 text-label-sm text-destructive">{t('memwise.binding.unknownTransforms', { list: unknown.join(', ') })}</p>}
    </div>
  )
}

function IdentityEditor({ rules, fields, onChange }: { rules: MwBinding['records'][string]['identity']; fields: string[]; onChange: (r: MwBinding['records'][string]['identity']) => void }) {
  const { t } = useTranslation()
  const [keys, setKeys] = React.useState(rules.keys.join(', '))
  React.useEffect(() => { setKeys(rules.keys.join(', ')) }, [rules.keys])
  const fuzzy = rules.fuzzy
  const num = (v: string, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
  }
  return (
    <div className="space-y-2 text-label">
      <label className="flex items-center gap-2">
        <span className="w-36 shrink-0 text-secondary">{t('memwise.binding.identity.keys')}</span>
        <Input className="h-control text-label-sm" value={keys} onChange={e => setKeys(e.target.value)} aria-label={t('memwise.binding.identity.keys')}
          onBlur={() => onChange({ ...rules, keys: keys.split(/[\s,]+/).map(k => k.trim()).filter(k => fields.includes(k) || !fields.length) })} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-36 shrink-0 text-secondary">{t('memwise.binding.identity.fuzzy')}</span>
        <Choice className="w-40" label={t('memwise.binding.identity.fuzzyField')} value={fuzzy?.field} options={fields.map(f => ({ value: f, label: f }))}
          noneLabel={t('memwise.binding.identity.noFuzzy')}
          onChange={v => onChange({ ...rules, ...(v ? { fuzzy: { field: v, auto: fuzzy?.auto ?? 0.95, review: fuzzy?.review ?? 0.75 } } : { fuzzy: undefined }) })} />
        {fuzzy && (
          <>
            <label className="flex items-center gap-1 text-label-sm text-secondary">
              {t('memwise.binding.identity.auto')}
              <Input className="h-control w-20 text-label-sm" type="number" step="0.01" min="0" max="1" defaultValue={fuzzy.auto}
                onBlur={e => onChange({ ...rules, fuzzy: { ...fuzzy, auto: num(e.target.value, fuzzy.auto) } })} />
            </label>
            <label className="flex items-center gap-1 text-label-sm text-secondary">
              {t('memwise.binding.identity.review')}
              <Input className="h-control w-20 text-label-sm" type="number" step="0.01" min="0" max="1" defaultValue={fuzzy.review}
                onBlur={e => onChange({ ...rules, fuzzy: { ...fuzzy, review: num(e.target.value, fuzzy.review) } })} />
            </label>
          </>
        )}
      </div>
      <label className="flex items-center gap-2">
        <span className="w-36 shrink-0 text-secondary">{t('memwise.binding.identity.createMissingLabel')}</span>
        <Switch checked={!!rules.createMissing} onCheckedChange={v => onChange({ ...rules, createMissing: v })} aria-label={t('memwise.binding.identity.createMissingLabel')} />
      </label>
    </div>
  )
}

// ---------------------------------------------------------------- the dry run

function DryRunReport({ view, now }: { view: MwBindingView; now?: number }) {
  const { t, i18n } = useTranslation()
  const r = view.report
  if (!r) {
    return (
      <Info_Section title={t('memwise.binding.section.dryRun')}>
        <Empty>{t('memwise.binding.noReport')}</Empty>
      </Info_Section>
    )
  }
  const passed = r.outcome === 'passed'
  return (
    <Info_Section
      title={t('memwise.binding.section.dryRun')}
      actions={<Info_Badge color={passed ? 'success' : 'destructive'} icon={passed ? <CheckCircle2 /> : <XCircle />}>{t(passed ? 'memwise.binding.passed' : 'memwise.binding.failed')}</Info_Badge>}
    >
      <div data-dry-run={r.outcome}>
        {view.reportStale && (
          <div className="flex items-center gap-2 border-b border-separator px-4 py-2 text-label-sm text-info" data-report-stale>
            <Clock className="size-3.5" />
            {t('memwise.binding.reportStale')}
          </div>
        )}
        <p className="px-4 py-2.5 text-label" title={absoluteTime(r.at, i18n.language)}>
          {r.summary} <span className="text-tertiary">· {relativeTime(r.at, now, i18n.language)}</span>
        </p>
        {r.diagnostics.length > 0 && <div className="border-t border-separator"><DiagnosticList diagnostics={r.diagnostics} /></div>}
        {r.examples.length > 0 && (
          <div className="border-t border-separator">
            <h4 className="px-4 pt-2.5 text-label-sm font-semibold text-secondary">{t('memwise.binding.examples', { count: r.examples.length })}</h4>
            <ul className="divide-y divide-separator">{r.examples.map(e => <ExampleRow key={e.name} example={e} />)}</ul>
          </div>
        )}
        {r.impact && r.impact.length > 0 && (
          <div className="border-t border-separator px-4 py-2.5" data-impact>
            <h4 className="mb-1 text-label-sm font-semibold text-secondary">{t('memwise.binding.impact')}</h4>
            <ul className="space-y-0.5 text-label">
              {r.impact.map(i => {
                const states = Object.keys(i.diff.states).length
                const steps = Object.keys(i.diff.steps).length
                const tools = i.diff.tools.added.length + i.diff.tools.removed.length
                const nothing = !states && !steps && !tools && !i.diff.transitions.length
                return (
                  <li key={i.workflowId} data-impact-workflow={i.workflowId}>
                    <span className="font-medium">{i.title}</span>{': '}
                    <span className="text-secondary">{nothing ? t('memwise.binding.impactNone') : t('memwise.binding.impactLine', { states, steps, tools })}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </Info_Section>
  )
}
