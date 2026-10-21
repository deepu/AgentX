/**
 * Phase 6 kernel shapes → the app API (docs/memwise/24-phase-6-interfaces.md §13): domains,
 * record pages, queries, the page tree, dashboards, views, automations, the audit trail, and the
 * case and inbox additions. Pure functions like the rest of dto.ts (which re-exports these).
 *
 * Labels are made here in plain words ("Start up pack complete", "Agent, from File a TMF
 * document"); the screens only translate their own words around them.
 */
import type { EntityTypeDef, LifecycleDef, PageLayoutDef, ProjectDefs, TriggerDef, ViewDef } from '@memwise/defs'
import type {
  AuditTrail, CaseLinkView, ChartData, DashboardData, DocumentValue, DomainSummary, InboxItem, RecordField, RecordFieldSource, RecordKeepResult,
  RecordKpi, RecordPage, RecordQueryResult, RecordReview, RecordTextView, RecordTransitionOption, RecordWriteResult, SignatureView, TreeNode,
  TriggerSummary, WaitingCondition,
} from '@memwise/runtime'
import type {
  MwAuditTrail, MwCaseLink, MwChartData, MwCheckResult, MwDashboard, MwDashboardBlock, MwDocument, MwDomain, MwDomainHome, MwEntityDefinition, MwInboxItem,
  MwPageBlock, MwPageLayout, MwProposedValue, MwRecordField, MwRecordFieldSource, MwRecordKeepResult, MwRecordKpi, MwRecordPage,
  MwRecordQueryResult, MwRecordReview, MwRecordWriteResult, MwSignature, MwTextView, MwTransitionOption, MwTreeNode, MwTrigger, MwView,
  MwWaitingCondition,
} from '@memwise/shared/protocol'
import type { DtoContext } from './dto'
import { humanize, pluginTitle, policyDocLines, stateTitle, toProvenance } from './dto'

const DAY_MS = 24 * 3600_000
const DEFAULT_DOMAIN = 'domain'

/** Kernel `retentionMs` → whole days for the screens ("Kept 25 years"). */
export function retentionDays(ms: number | undefined): number | undefined {
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / DAY_MS) : undefined
}

/** A domain's display name: its `domain.yaml` name, "Main" for the default domain, else its id in words. */
export function domainName(project: Pick<ProjectDefs, 'domains'>, domain: string | undefined): string {
  const id = domain ?? DEFAULT_DOMAIN
  return project.domains?.[id]?.name ?? (id === DEFAULT_DOMAIN ? 'Main' : humanize(id))
}

/** The entity's name in words, without its domain (`etmf.ExpectedDocument` → "Expected document"). */
export function entityLabel(key: string): string {
  const bare = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key
  return humanize(bare.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
}

const plainDoc = (d: DocumentValue): MwDocument => ({ id: d.id, name: d.name, mime: d.mime, size: d.size, sha256: d.sha256 })

// ---------------------------------------------------------------- domains

export function toDomain(ctx: Pick<DtoContext, 'project'>, s: DomainSummary): MwDomain {
  const def = ctx.project.domains?.[s.id]
  const days = retentionDays(s.retentionMs)
  const home = toDomainHome(ctx.project, s.id)
  return {
    id: s.id,
    name: s.name || domainName(ctx.project, s.id),
    ...(s.description ? { description: s.description } : {}),
    regulated: !!s.regulated,
    ...(s.owner ? { owner: s.owner } : {}),
    ...(days ? { retentionDays: days } : {}),
    entities: s.entities.map((e) => ({
      key: e.key, entity: e.entity, title: e.title || entityLabel(e.entity), count: e.count,
      ...(e.parent ? { parent: e.parent } : {}), ...(e.lifecycle ? { lifecycle: [...e.lifecycle] } : {}),
    })),
    workflows: [...s.workflows],
    pages: s.pages.map((p) => ({ id: p.id, title: p.title, ...(p.under ? { under: { entity: p.under.entity } } : {}) })),
    views: s.views.map((v) => ({ id: v.id, title: v.title, entity: v.entity })),
    flags: s.flags,
    detail: {
      houseRules: policyDocLines(def?.policy),
      workspaceRules: policyDocLines(ctx.project.workspace?.policy),
      acceptsFrom: [...(def?.acceptsFrom ?? [])],
      ...(def?.intake?.address ? { intake: def.intake.address } : {}),
    },
    ...(home ? { home } : {}),
  }
}

/** The domain's `home:` with its entity resolved, or undefined when it has none (or it doesn't resolve). */
export function toDomainHome(project: ProjectDefs, domainId: string): MwDomainHome | undefined {
  const home = project.domains?.[domainId]?.home
  const def = home ? project.entities[home.entity] ?? Object.values(project.entities).find((e) => (e.domain ?? DEFAULT_DOMAIN) === domainId && e.entity === home.entity) : undefined
  const chart = def?.lifecycleChart
  if (!home || !def || !chart) return undefined
  return {
    ...(home.ask ? { ask: home.ask } : {}),
    ...(home.placeholder ? { placeholder: home.placeholder } : {}),
    entity: !def.domain || def.domain === DEFAULT_DOMAIN ? def.entity : `${def.domain}.${def.entity}`,
    entityTitle: entityLabel(def.entity),
    draftState: chart.initial,
    endStates: Object.values(chart.states).filter((s) => Object.keys(s.on).length === 0).map((s) => s.name),
    suggested: [...home.suggested],
  }
}

// ---------------------------------------------------------------- record pages

/** Where a value comes from, with the names the badge shows (plugin title, domain name, person, playbook). */
export function toFieldSource(project: ProjectDefs, s: RecordFieldSource, names: Map<string, string> = new Map()): MwRecordFieldSource {
  switch (s.kind) {
    case 'domain': return { kind: 'domain' }
    case 'calculated': return { kind: 'calculated' }
    case 'plugin': return { kind: 'plugin', plugin: s.plugin, title: pluginTitle(project, s.plugin) }
    case 'link': return {
      kind: 'link', domain: s.domain, domainName: domainName(project, s.domain), entity: s.entity, ...(s.recordId ? { recordId: s.recordId } : {}),
    }
    case 'step': {
      const wf = s.workflowId ? project.workflows[s.workflowId] : undefined
      return {
        kind: 'step', stepRunId: s.stepRunId, ...(s.workflowId ? { workflowId: s.workflowId } : {}),
        ...(wf || s.workflowId ? { label: wf?.title ?? humanize(s.workflowId!) } : {}),
      }
    }
    case 'person': {
      const name = s.name ?? names.get(s.personId)
      return { kind: 'person', personId: s.personId, ...(name ? { name } : {}) }
    }
    case 'source': return { kind: 'source', source: s.source }
  }
  return s
}

export function toRecordField(project: ProjectDefs, f: RecordField, names: Map<string, string> = new Map()): MwRecordField {
  return {
    name: f.name,
    label: f.name === 'status' ? 'Status' : humanize(f.name),
    type: f.type,
    value: f.hidden ? null : f.value,
    ...(f.hidden ? { hidden: true } : {}),
    ...(f.ref ? { ref: { entity: f.ref.entity, id: f.ref.id, title: f.ref.title, ...((f.ref as { status?: string }).status ? { status: (f.ref as { status?: string }).status } : {}) } } : {}),
    source: toFieldSource(project, f.source, names),
    editable: !!f.editable && !f.hidden,
    ...(f.calculated ? { calculated: true } : {}),
    ...(f.followed ? { followed: true } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.controlled ? { controlled: true } : {}),
  }
}

/** The layout as written (`PageLayoutDef`): areas copied block by block, so the screens never share the kernel's objects. */
export function toPageLayout(l: PageLayoutDef): MwPageLayout {
  const areas: MwPageLayout['areas'] = {}
  for (const [area, blocks] of Object.entries(l.areas) as [keyof MwPageLayout['areas'], PageLayoutDef['areas'][keyof PageLayoutDef['areas']]][]) {
    if (blocks) areas[area] = blocks.map((b) => ({ ...b, ...('fields' in b ? { fields: [...b.fields] } : {}), ...('relationships' in b ? { relationships: [...b.relationships] } : {}) }) as MwPageBlock)
  }
  return { layout: l.layout, header: [...l.header], areas, ...(l.isDefault ? { isDefault: true } : {}) }
}

// ---------------------------------------------------------------- Literature (doc 25 §4–§6)

const refOf = (r: { entity: string; id: string; title: string; status?: string }) => ({ entity: r.entity, id: r.id, title: r.title, ...(r.status ? { status: r.status } : {}) })

/** A chart's rows (record page `chart` blocks and free page `chart:` blocks). */
export function toChartData(c: ChartData): MwChartData {
  return {
    kind: c.kind, ...(c.title ? { title: c.title } : {}), ...(c.unit ? { unit: c.unit } : {}),
    data: c.data.map((d) => ({
      label: d.label, value: d.value,
      ...(typeof d.low === 'number' ? { low: d.low } : {}), ...(typeof d.high === 'number' ? { high: d.high } : {}),
      ...(d.unit ? { unit: d.unit } : {}), ...(d.key !== undefined ? { key: d.key } : {}), ...(d.record ? { record: refOf(d.record) } : {}),
    })),
    total: c.total, ...(c.skipped ? { skipped: c.skipped } : {}),
  }
}

export function toRecordKpi(k: RecordKpi): MwRecordKpi {
  return { field: k.field, value: k.value, type: k.type, ...(k.description ? { description: k.description } : {}) }
}

/** A Text viewer's text and quotes, each labelled with its field in words. */
export function toTextView(t: RecordTextView): MwTextView {
  return {
    text: t.text,
    highlights: t.highlights.map((h) => ({
      quote: h.quote, field: h.field, label: humanize(h.field), kind: h.kind,
      ...(h.value !== undefined ? { value: h.value } : {}), ...(h.record ? { record: refOf(h.record) } : {}),
      found: !!h.found, ...(typeof h.start === 'number' && typeof h.end === 'number' ? { start: h.start, end: h.end } : {}),
    })),
  }
}

export function toKeepResult(r: RecordKeepResult): MwRecordKeepResult {
  return {
    entity: r.entity,
    rows: r.rows.map((x) => ({
      ...(x.id ? { id: x.id } : {}), ...(typeof x.quoteFound === 'boolean' ? { quoteFound: x.quoteFound } : {}),
      ...(x.error ? { error: x.error } : {}), ...(x.errors ? { errors: x.errors } : {}),
    })),
  }
}

export function toSignature(s: SignatureView): MwSignature {
  return {
    id: s.id, stepRunId: s.stepRunId, caseId: s.caseId, personId: s.personId, name: s.name, meaning: s.meaning, at: s.at,
    entity: s.entity, recordId: s.recordId, contentHash: s.contentHash, changedSince: !!s.changedSince,
  }
}

/** The person the version's `by` names, a step (`step:<id>`), a source, or the system, in words. */
export function versionByLabel(by: string, names: Map<string, string>, given?: string, project?: Pick<ProjectDefs, 'domains' | 'plugins'>): string {
  if (given) return given
  if (names.has(by)) return names.get(by)!
  if (by === 'system') return 'MemWise'
  if (by.startsWith('step:')) return 'A playbook step'
  if (by.startsWith('source:')) return sourceLabel(by.slice('source:'.length), project)
  return by
}

/** A source in words: a linked domain by its name (`domain:edc` → "EDC"), a plugin by its title. */
export function sourceLabel(source: string, project?: Pick<ProjectDefs, 'domains' | 'plugins'>): string {
  if (source.startsWith('domain:')) return project ? domainName(project, source.slice('domain:'.length)) : humanize(source.slice('domain:'.length))
  return project?.plugins?.[source] ? pluginTitle(project, source) : humanize(source)
}

export function toReview(project: ProjectDefs, r: RecordReview): MwRecordReview {
  const wf = project.workflows[r.workflowId]
  return {
    stepRunId: r.stepRunId, runId: r.runId, caseId: r.caseId, workflowId: r.workflowId, stepId: r.stepId,
    title: r.title || stateTitle(wf, r.stepId),
    ...(r.instructions ? { instructions: r.instructions } : {}),
    proposed: r.proposed.map((p): MwProposedValue => ({
      field: p.field, label: humanize(p.field), type: p.type, value: p.value,
      ...(p.provenance ? { provenance: toProvenance(p.provenance) } : {}),
      ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}),
      ...(typeof p.page === 'number' ? { page: p.page } : {}),
      ...(p.quote ? { quote: p.quote } : {}),
      ...(p.document ? { document: p.document } : {}),
      ...(p.required ? { required: true } : {}),
      ...(p.ref ? { ref: { entity: p.ref.entity, id: p.ref.id, title: p.ref.title } } : {}),
    })),
    checks: r.checks.map((c): MwCheckResult => ({ rule: c.rule, verdict: c.passed ? 'pass' : 'flag', ...(c.reason ? { note: c.reason } : {}), stepRunId: c.stepRunId })),
    outcomes: [...r.outcomes],
    ...(r.sign ? { sign: { meaning: r.sign.meaning, as: { personId: r.sign.as.personId, name: r.sign.as.name, roles: [...r.sign.as.roles] } } } : {}),
    ...(r.returnedComments?.length ? { returnedComments: r.returnedComments.map((c) => ({ by: c.by, comment: c.comment, at: c.at })) } : {}),
  }
}

export function toTransitionOption(t: RecordTransitionOption): MwTransitionOption {
  return {
    name: t.name, label: t.label ?? humanize(t.name), to: t.to, allowed: !!t.allowed,
    ...(t.label ? { custom: true } : {}),
    ...(t.primary ? { primary: true } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.guard ? { guard: { condition: t.guard.condition, holds: !!t.guard.holds } } : {}),
    ...(t.signed ? { signed: true } : {}),
    ...(t.automatic ? { automatic: true } : {}),
  }
}

export function toRecordPage(ctx: Pick<DtoContext, 'project'>, p: RecordPage, names: Map<string, string> = new Map()): MwRecordPage {
  const project = ctx.project
  const wfTitle = (id: string) => project.workflows[id]?.title ?? humanize(id)
  return {
    entity: p.entity,
    domain: p.domain,
    domainName: domainName(project, p.domain),
    entityName: p.entityName || entityLabel(p.entity),
    regulated: !!p.regulated,
    id: p.id,
    title: p.title,
    ...(p.status ? { status: p.status } : {}),
    layout: toPageLayout(p.layout),
    fields: p.fields.map((f) => toRecordField(project, f, names)),
    parents: p.parents.map((r) => ({ entity: r.entity, id: r.id, title: r.title, ...(r.status ? { status: r.status } : {}) })),
    related: Object.fromEntries(Object.entries(p.related).map(([name, r]) => [name, {
      entity: r.entity, label: humanize(name), total: r.total,
      rows: r.rows.map((x) => ({ entity: x.entity, id: x.id, title: x.title, ...(x.status ? { status: x.status } : {}), values: { ...x.values } })),
      ...(r.types ? { types: { ...r.types } } : {}),
    }])),
    cases: p.cases.map((c) => ({
      caseId: c.caseId, runId: c.runId, workflowId: c.workflowId, title: c.title || wfTitle(c.workflowId),
      state: stateTitle(project.workflows[c.workflowId], c.state), status: c.status, updatedAt: c.updatedAt,
      ...(c.waitingOn ? { waitingOn: names.get(c.waitingOn) ?? project.roles?.[c.waitingOn]?.title ?? humanize(c.waitingOn) } : {}),
    })),
    ...(p.lifecycle ? { lifecycle: { states: [...p.lifecycle.states], ...(p.lifecycle.current ? { current: p.lifecycle.current } : {}), ...(p.lifecycle.passed ? { passed: [...p.lifecycle.passed] } : {}), transitions: p.lifecycle.transitions.map(toTransitionOption) } } : {}),
    flags: p.flags.map((f) => ({ ...f })),
    signatures: p.signatures.map(toSignature),
    ...(p.notes ? { notes: { body: p.notes.body, version: p.notes.version, by: names.get(p.notes.by) ?? p.notes.by, at: p.notes.at } } : {}),
    mentions: p.mentions.map((m) => ({ ...m })),
    start: p.start.map((s) => ({ workflowId: s.workflowId, title: s.title || wfTitle(s.workflowId) })),
    documents: Object.fromEntries(Object.entries(p.documents).map(([k, d]) => [k, d ? plainDoc(d) : null])),
    history: p.history.map((v) => ({
      version: v.version, at: v.at, by: v.by, byLabel: versionByLabel(v.by, names, v.byLabel, project),
      ...(v.via ? { via: v.via } : {}), ...(v.reason ? { reason: v.reason } : {}), changed: [...v.changed], hash: v.hash,
    })),
    ...(p.review ? { review: toReview(project, p.review) } : {}),
    ...(p.kpis ? { kpis: Object.fromEntries(Object.entries(p.kpis).map(([k, v]) => [k, toRecordKpi(v)])) } : {}),
    ...(p.charts ? { charts: Object.fromEntries(Object.entries(p.charts).map(([k, v]) => [k, toChartData(v)])) } : {}),
    ...(p.texts ? { texts: Object.fromEntries(Object.entries(p.texts).map(([k, v]) => [k, toTextView(v)])) } : {}),
  }
}

export function toRecordWriteResult(r: RecordWriteResult): MwRecordWriteResult {
  return {
    applied: !!r.applied, status: r.status,
    ...(r.message ? { message: r.message } : {}), ...(r.errors ? { errors: r.errors } : {}),
    ...(r.id ? { id: r.id } : {}), ...(typeof r.version === 'number' ? { version: r.version } : {}),
  }
}

// ---------------------------------------------------------------- views and queries

export function toQueryResult(r: RecordQueryResult): MwRecordQueryResult {
  return {
    entity: r.entity,
    columns: r.columns.map((c) => ({
      name: c.name, label: c.name === 'status' ? 'Status' : humanize(c.name), type: c.type,
      ...(c.calculated ? { calculated: true } : {}), ...(c.followed ? { followed: true } : {}),
    })),
    rows: r.rows.map((x) => ({
      entity: x.entity, id: x.id, title: x.title, ...(x.status ? { status: x.status } : {}), values: { ...x.values }, hidden: [...x.hidden],
      ...(x.refs ? { refs: Object.fromEntries(Object.entries(x.refs).map(([f, ref]) => [f, { entity: ref.entity, id: ref.id, title: ref.title, ...(ref.status ? { status: ref.status } : {}) }])) } : {}),
    })),
    total: r.total,
    ...(r.groups ? { groups: r.groups.map((g) => ({ key: g.key, count: g.count, ...(g.title ? { title: g.title } : {}) })) } : {}),
  }
}

export function toTreeNode(n: TreeNode): MwTreeNode {
  switch (n.kind) {
    case 'record': return { kind: 'record', entity: n.entity, id: n.id, title: n.title, ...(n.status ? { status: n.status } : {}), hasChildren: !!n.hasChildren }
    case 'group': return {
      kind: 'group', entity: n.entity, ...(n.parent ? { parent: { ...n.parent } } : {}), title: n.title, count: n.count,
      ...(n.viewFilter ? { viewFilter: n.viewFilter } : {}),
    }
    case 'page': return { kind: 'page', pageId: n.pageId, title: n.title, params: { ...n.params } }
  }
}

export function toView(v: ViewDef & { personal: boolean; domain: string }): MwView {
  return {
    id: v.id, title: v.title, domain: v.domain, entity: v.entity,
    ...(v.filter ? { filter: v.filter } : {}),
    ...(v.sort?.length ? { sort: v.sort.map((s) => ({ field: s.field, ...(s.desc ? { desc: true } : {}) })) } : {}),
    ...(v.group ? { group: v.group } : {}),
    ...(v.columns?.length ? { columns: [...v.columns] } : {}),
    layout: v.layout === 'board' ? 'board' : 'table',
    personal: !!v.personal,
  }
}

export function toDashboard(domain: string, d: DashboardData): MwDashboard {
  return {
    pageId: d.pageId, domain, title: d.title, ...(d.description ? { description: d.description } : {}),
    params: { ...d.params }, computedAt: d.computedAt,
    blocks: d.blocks.map((b): MwDashboardBlock => {
      switch (b.kind) {
        case 'kpi': return {
          kind: 'kpi', label: b.label, value: b.value,
          ...(typeof b.target === 'number' ? { target: b.target } : {}), ...(b.format ? { format: b.format } : {}), ...(b.detail ? { detail: b.detail } : {}),
        }
        case 'table':
        case 'list': return { kind: b.kind, ...(b.title ? { title: b.title } : {}), result: toQueryResult(b.result) }
        case 'heatmap': return {
          kind: 'heatmap', ...(b.title ? { title: b.title } : {}), columns: [...b.columns],
          rows: b.rows.map((r) => ({ record: { entity: r.record.entity, id: r.record.id, title: r.record.title, ...(r.record.status ? { status: r.record.status } : {}) }, values: [...r.values] })),
        }
        case 'text': return { kind: 'text', markdown: b.markdown }
        case 'chart': return { kind: 'chart', chart: toChartData(b.chart) }
      }
    }),
  }
}

// ---------------------------------------------------------------- automations

/** A trigger in plain words, when the kernel sends none: "When a Site enters Activating". */
export function triggerDescription(def: TriggerDef): string {
  const ent = (e: string) => entityLabel(e)
  const dur = (ms: number) => {
    const days = Math.round(ms / DAY_MS)
    if (days % 7 === 0 && days >= 7) return `${days / 7} week${days === 7 ? '' : 's'}`
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`
    const hours = Math.round(ms / 3600_000)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  switch (def.kind) {
    case 'entered': return `When a ${ent(def.entity).toLowerCase()} moves to ${humanize(def.state)}`
    case 'created': return `When a ${ent(def.entity).toLowerCase()} is added`
    case 'changed': return def.fields?.length
      ? `When a ${ent(def.entity).toLowerCase()}'s ${def.fields.map((f) => humanize(f).toLowerCase()).join(' or ')} changes`
      : `When a ${ent(def.entity).toLowerCase()} changes`
    case 'date': return `${dur(def.offsetMs)} ${def.direction} a ${ent(def.entity).toLowerCase()}'s ${humanize(def.field).toLowerCase()}`
    case 'every': return `Every ${dur(def.everyMs)}${def.on ? ` on ${humanize(def.on)}` : ''}${def.at ? ` at ${def.at}` : ''}`
    case 'message': return `When an email arrives at ${def.address}`
  }
}

export function toTrigger(project: ProjectDefs, t: TriggerSummary): MwTrigger {
  const wf = project.workflows[t.workflowId]
  return {
    id: t.id, workflowId: t.workflowId, workflowTitle: wf?.title ?? humanize(t.workflowId), domain: t.domain,
    kind: t.def.kind === 'date' ? 'date' : t.def.kind, description: t.description || triggerDescription(t.def),
    ...(t.lastFiredAt ? { lastFiredAt: t.lastFiredAt } : {}),
    ...(t.nextDue ? { nextDue: { at: t.nextDue.at, ...(t.nextDue.record ? { record: { entity: t.nextDue.record.entity, id: t.nextDue.record.id, title: t.nextDue.record.title, ...(t.nextDue.record.status ? { status: t.nextDue.record.status } : {}) } } : {}) } } : {}),
    firings: t.firings, held: t.held,
  }
}

// ---------------------------------------------------------------- audit

export function toAuditTrail(project: ProjectDefs, a: AuditTrail, names: Map<string, string> = new Map()): MwAuditTrail {
  const days = retentionDays(a.retentionMs)
  return {
    entity: a.entity, id: a.id, title: a.title, domain: a.domain, regulated: !!a.regulated, ...(days ? { retentionDays: days } : {}),
    values: { ...a.values },
    versions: a.versions.map((v) => ({
      version: v.version, at: v.at, by: v.by, byLabel: versionByLabel(v.by, names, v.byLabel, project),
      ...(v.via ? { via: v.via } : {}), ...(v.reason ? { reason: v.reason } : {}), changed: [...v.changed], hash: v.hash,
      values: { ...v.values }, prevHash: v.prevHash,
    })),
    chain: { ok: !!a.chain.ok, ...(typeof a.chain.brokenAt === 'number' ? { brokenAt: a.chain.brokenAt } : {}), ...(a.chain.message ? { message: a.chain.message } : {}) },
    signatures: a.signatures.map(toSignature),
    cases: a.cases.map((c) => ({
      caseId: c.caseId, workflowId: c.workflowId, title: c.title || (project.workflows[c.workflowId]?.title ?? humanize(c.workflowId)),
      stepRuns: c.stepRuns.map((s) => ({ ...s, ...(s.decidedBy ? { decidedBy: names.get(s.decidedBy) ?? s.decidedBy } : {}) })),
    })),
    flags: a.flags.map((f) => ({ ...f })),
    exportedAt: a.exportedAt,
  }
}

/** `etmf.Document`, `doc_01` → `document-doc_01-audit.json`. */
export function auditFileName(entity: string, id: string, format: 'json' | 'pdf'): string {
  const bare = entity.includes('.') ? entity.slice(entity.indexOf('.') + 1) : entity
  return `${bare.toLowerCase()}-${id}-audit.${format}`
}

// ---------------------------------------------------------------- cases and the inbox

/** `caseTitle`: the linked case's own name (the paper a "Read a paper" case reads), when known. */
export function toCaseLink(project: ProjectDefs, l: CaseLinkView, caseTitle?: string): MwCaseLink {
  const wf = project.workflows[l.workflowId]
  const title = l.title || (wf?.title ?? humanize(l.workflowId))
  return {
    kind: l.kind, caseId: l.caseId, runId: l.runId, workflowId: l.workflowId,
    // The step's title ("Finished", "QC and sign"), not the state's id ("end").
    title, state: stateTitle(wf, l.state), status: l.status,
    ...(caseTitle && caseTitle !== title ? { caseTitle } : {}),
  }
}

/**
 * What a `wait_until` waits for. `project`: the values' types from the record's entity; `titles`:
 * the record's title as the viewer reads it (with its followed fields), by id.
 */
export function toWaiting(w: WaitingCondition, project?: Pick<ProjectDefs, 'entities'>, titles?: ReadonlyMap<string, string>): MwWaitingCondition {
  const def = project?.entities[w.record.entity]
  const typeOf = (k: string): string | undefined => {
    const c = def?.calculated?.[k]
    if (c) return c.kind === 'rollup' && c.rollup === 'percent' ? 'Percentage' : 'Number'
    return def?.fields[k]?.typeSource
  }
  const types = Object.fromEntries(Object.keys(w.values).flatMap((k) => { const t = typeOf(k); return t ? [[k, t]] : [] }))
  return {
    record: { entity: w.record.entity, id: w.record.id, title: titles?.get(w.record.id) ?? w.record.title, ...(w.record.status ? { status: w.record.status } : {}) },
    condition: w.condition, holds: !!w.holds, values: { ...w.values }, ...(Object.keys(types).length ? { types } : {}),
  }
}

/** The Phase 6 fields of an input or decision item: the domain, how it is reviewed, and the signature. */
export function inboxReviewFields(item: Extract<InboxItem, { kind: 'input' | 'decision' }>): Pick<Extract<MwInboxItem, { kind: 'input' }>, 'domain' | 'review' | 'sign'> {
  return {
    ...(item.domain ? { domain: item.domain } : {}),
    ...(item.review ? { review: { ...item.review } } : {}),
    ...(item.sign ? { sign: { meaning: item.sign.meaning } } : {}),
  }
}

export function toFlagInboxItem(project: ProjectDefs, item: Extract<InboxItem, { kind: 'flag' }>): Extract<MwInboxItem, { kind: 'flag' }> {
  return {
    kind: 'flag', id: item.id, caseTitle: item.title || entityLabel(item.flag.entity), stepTitle: item.flag.message,
    domain: item.domain, flag: { ...item.flag }, since: item.since,
  }
}

export function toTriggerHoldInboxItem(project: ProjectDefs, item: Extract<InboxItem, { kind: 'trigger-hold' }>): Extract<MwInboxItem, { kind: 'trigger-hold' }> {
  const title = project.workflows[item.workflowId]?.title ?? humanize(item.workflowId)
  return {
    kind: 'trigger-hold', id: item.id, caseTitle: title,
    stepTitle: `${item.held} case${item.held === 1 ? '' : 's'} would start`,
    triggerId: item.triggerId, workflowId: item.workflowId, held: item.held, description: item.description, since: item.since,
  }
}

// ---------------------------------------------------------------- entity definitions (the Entities page)

function lifecycleOf(project: ProjectDefs, chart: LifecycleDef | undefined): MwEntityDefinition['lifecycle'] {
  if (!chart) return undefined
  const dur = (ms: number) => (ms % (7 * DAY_MS) === 0 ? `${ms / (7 * DAY_MS)}w` : ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / 3600_000)}h`)
  const by = (b: LifecycleDef['transitions'][string]['by'][number]) => {
    switch (b.kind) {
      case 'step': return 'A playbook step'
      case 'role': return humanize(b.role)
      case 'source': return sourceLabel(b.source, project)
      case 'system': return 'MemWise'
    }
  }
  return {
    initial: chart.initial,
    states: Object.values(chart.states).map((s) => ({
      name: s.name, label: humanize(s.name),
      on: Object.entries(s.on).map(([transition, to]) => ({ transition, to })),
      timers: (s.after ?? []).map((a) => (a.remind ? `After ${dur(a.afterMs)}: remind ${humanize(a.remind).toLowerCase()}` : `After ${dur(a.afterMs)}: ${humanize(a.transition ?? '').toLowerCase()}`)),
    })),
    transitions: Object.values(chart.transitions).map((t) => ({
      name: t.name, label: humanize(t.name), by: t.by.map(by), ...(t.guard ? { guard: t.guard } : {}), ...(t.signed ? { signed: true } : {}),
    })),
    ...(chart.fromList ? { fromList: true } : {}),
  }
}

function calculatedSummary(c: NonNullable<EntityTypeDef['calculated']>[string]): string {
  if (c.kind === 'formula') return c.formula
  const where = c.where ? ` where ${c.where}` : ''
  switch (c.rollup) {
    case 'count': return `Count of ${humanize(c.of).toLowerCase()}${where}`
    case 'percent': return `Percent of ${humanize(c.of).toLowerCase()}${where}`
    default: return `${humanize(c.rollup)} of ${humanize(c.of).toLowerCase()}${c.field ? `.${c.field}` : ''}${where}`
  }
}

/** The Definition tab: where each field comes from, connections, calculated fields, links, lifecycle, rules, and who uses it. */
export function toEntityDefinition(project: ProjectDefs, key: string, e: EntityTypeDef): MwEntityDefinition {
  const sources: Record<string, MwRecordFieldSource> = {}
  for (const name of Object.keys(e.fields)) {
    const owner = e.ownership?.[name]
    sources[name] = owner && owner !== 'domain' ? { kind: 'plugin', plugin: owner, title: pluginTitle(project, owner) } : { kind: 'domain' }
  }
  for (const name of Object.keys(e.calculated ?? {})) sources[name] = { kind: 'calculated' }
  for (const link of Object.values(e.links ?? {})) {
    const dot = link.target.indexOf('.')
    const domain = dot > 0 ? link.target.slice(0, dot) : DEFAULT_DOMAIN
    for (const f of link.follow) sources[f] = { kind: 'link', domain, domainName: domainName(project, domain), entity: link.target }
  }
  const parentRel = e.parent ? e.relationships[e.parent] : undefined
  const parentField = e.parent && !parentRel ? e.fields[e.parent] : undefined
  const parentEntity = parentRel?.target ?? (parentField ? /Ref<([^>]+)>/.exec(parentField.typeSource)?.[1] : undefined)
  // Playbooks whose case reads or writes a Ref to it, or that start from it
  const bare = e.entity
  const usedBy = Object.values(project.workflows)
    .filter((wf) => (wf.startsOn ?? []).some((t) => 'entity' in t && (t.entity === bare || t.entity === key))
      || Object.values(wf.caseType.fields).some((f) => new RegExp(`\\b(Ref|List)<\\s*${bare.replace('.', '\\.')}\\s*>`).test(f.typeSource) || f.typeSource.includes(`<${key}>`)))
    .map((wf) => ({ workflowId: wf.id, title: wf.title ?? humanize(wf.id) }))
  return {
    ...(e.title ? { title: e.title } : {}),
    ...(e.parent && parentEntity ? { parent: { relationship: e.parent, entity: parentEntity } } : {}),
    sources,
    relationships: Object.entries(e.relationships).map(([name, r]) => ({ name, cardinality: r.cardinality, target: r.target, ...(r.via ? { via: r.via } : {}) })),
    calculated: Object.entries(e.calculated ?? {}).map(([name, c]) => ({ name, kind: c.kind, summary: calculatedSummary(c), ...(c.description ? { description: c.description } : {}) })),
    links: Object.values(e.links ?? {}).map((l) => ({ target: l.target, match: { ...l.match }, follow: [...l.follow] })),
    ...(e.lifecycleChart ? { lifecycle: lifecycleOf(project, e.lifecycleChart) } : {}),
    invariants: [...(e.invariants ?? [])],
    usedBy,
    ...(e.list?.length ? { list: [...e.list] } : {}),
  }
}
