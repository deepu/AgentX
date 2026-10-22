/**
 * Kernel types → the app API shapes (packages/shared/src/protocol/memwise.ts). The renderer only
 * ever sees these. Pure functions over the indexed definitions, so they are easy to test.
 */
import type {
  CaseTypeDef, Diagnostic, DraftEdit, DraftMeta, DraftReport, EffectClass, EntityTypeDef, FieldDef, FileChange, Impact,
  JournalEntry, ProjectDefs, RecordTypeDef, StepDef, StepRecord, StructuralDiff, WorkflowDef, WorkflowVersion, WriteDef,
} from '@memwise/defs'
import type { CompiledPolicy, RuleOrigin, Sourced } from '@memwise/policy'
import type {
  BindingDef, BindingGap, BindingReport, IdentityCandidate, IdentityLink, MappedRecord, McpServerDef, PluginToolDef,
  PolicyDoc, WorkflowOrigin,
} from '@memwise/defs'
import type {
  BindingState, BindingView, CaseSummary, CaseView, EntityRecordView, EntityRow, Person, PluginDetail, PluginSummary, Role,
  StepRunSummary, TransitionRecord,
} from '@memwise/runtime'
import type {
  MwCase, MwCaseSummary, MwCaseValue, MwDiagnostic, MwEffectClass, MwEntityRow, MwEntityType, MwField, MwJournalEntry,
  MwPerformer, MwPerson, MwPlaybook, MwPolicyRule, MwRole, MwState, MwStep, MwStepRecord, MwStepRunSummary, MwToolRef,
  MwTransition, MwDraftStage, MwDraftSummary, MwDraftEdit, MwFileChange, MwStructuralDiff, MwImpact, MwDraftReport, MwVersion,
  MwTreatment,
  MwBinding, MwBindingGap, MwBindingReport, MwBindingState, MwBindingVersion, MwBindingView, MwClassSource, MwEntityLinkBadge,
  MwEntityRecord, MwIdentityCandidate, MwIdentityLink, MwInboxItem, MwMappedRecord, MwMatchMethod, MwPluginDetail,
  MwPluginSummary, MwPluginTool, MwPolicyDoc, MwPolicyLine, MwTransform, MwWorkflowOrigin,
  MwDelivery, MwExternalLink, MwExtractResult, MwExtractSuggestion, MwProvenance,
} from '@memwise/shared/protocol'
import type { Provenance } from '@memwise/defs'
import type { Delivery, ExternalLinkSummary, ExtractResult, ExtractSuggestion } from '@memwise/defs/external'
import { isConversationStep } from './conversation'
import { toCaseLink, toEntityDefinition, toWaiting } from './dto-records'

export * from './dto-records'

type JsonSchemaFn = (type: FieldDef['type'], recordTypes?: Record<string, { fields: Record<string, FieldDef> }>) => Record<string, unknown>

/** Tool facts the screens show (name, description, effect class, plugin). */
export interface ToolInfo { name: string; description?: string; effect?: EffectClass; plugin?: string }

/**
 * The tools of a project as the kernel binds them, for the screens: the caller's own tools first,
 * then the entity tools (`literature.topic.get` reads), then what frozen bindings bind (with the
 * binding's class, e.g. `PubMed.search_articles` reads), then the builtins plugin routes run on.
 * `entity` and `plugin` are @memwise/defs' `entityTools` and `boundPluginTools` of the project.
 */
export function projectToolInfo(
  direct: Map<string, ToolInfo>,
  builtins: Map<string, ToolInfo>,
  entity: Record<string, { effect: EffectClass }>,
  plugin: Record<string, { effect?: EffectClass; plugin: string; description: string }>,
): Map<string, ToolInfo> {
  const out = new Map(direct)
  for (const [name, t] of Object.entries(entity)) if (!out.has(name)) out.set(name, { name, effect: t.effect })
  for (const [name, t] of Object.entries(plugin)) {
    if (out.has(name)) continue
    const description = t.description || builtins.get(name)?.description
    out.set(name, { name, ...(description ? { description } : {}), ...(t.effect ? { effect: t.effect } : {}), plugin: t.plugin })
  }
  for (const [name, t] of builtins) if (!out.has(name)) out.set(name, t)
  return out
}

export interface DtoContext {
  project: ProjectDefs
  diagnostics: Diagnostic[]
  tools: Map<string, ToolInfo>
  /** The tools for another set of definitions (a draft's own bindings and entities). */
  toolsFor?: (project: ProjectDefs) => Map<string, ToolInfo>
  jsonSchema: JsonSchemaFn
}

const EFFECTS: EffectClass[] = ['read', 'draft', 'write', 'outbound', 'irreversible']

// ---------------------------------------------------------------- people

export function toPerson(p: Person): MwPerson {
  return { id: p.id, name: p.name, email: p.email, roles: [...p.roles] }
}

export function toRole(r: Role): MwRole {
  return { id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) }
}

export function toDiagnostic(d: Diagnostic): MwDiagnostic {
  return {
    severity: d.severity, code: d.code,
    message: d.path && !d.line ? `${d.message} (${d.path})` : d.message,
    ...(d.file ? { file: d.file } : {}), ...(d.line ? { line: d.line } : {}),
  }
}

// ---------------------------------------------------------------- titles

/** `needs_person` → "Needs person". */
/** Words that read as initials in labels ("PMID", "DOI"), like the renderer's own labels. */
const ACRONYMS = new Set(['id', 'pmid', 'pmc', 'doi', 'ci', 'url', 'api', 'ai'])

export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim()
  if (!words) return id
  const parts = words.split(' ').map((w, i) => (ACRONYMS.has(w.toLowerCase()) && (i > 0 || w !== 'id') ? w.toUpperCase() : w))
  const out = parts.join(' ')
  return out[0]!.toUpperCase() + out.slice(1)
}

export function stateTitle(wf: WorkflowDef | undefined, state: string): string {
  if (state === 'end') return 'Finished'
  if (state === 'needs_person') return 'Needs a person'
  return wf?.steps[state]?.title ?? humanize(state)
}

/** The bind-plugin playbook's case type (22 §4): its cases are named by the plugin, never the draft. */
const PLUGIN_BINDING_CASE = 'plugin_binding'

/**
 * A readable case title: the client's name, the legal name, the first text value, else a short
 * reference. A plugin binding case is "Bind Client intake" (the installed plugin's title, else its id).
 */
const plainValue = (v: unknown) => (v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v)

/** The records a case's Ref values point at, in the case type's field order. */
export function caseRefs(values: Record<string, unknown>, caseType?: CaseTypeDef): { field: string; entity: string; id: string }[] {
  const out: { field: string; entity: string; id: string }[] = []
  for (const [field, f] of Object.entries(caseType?.fields ?? {})) {
    if (f.type.kind !== 'ref') continue
    const v = plainValue(values[field])
    if (typeof v === 'string' && v) out.push({ field, entity: f.type.entity, id: v })
  }
  return out
}

/**
 * The record a case is about: its first Ref value (a site's activation, a document's filing). A
 * case with nothing typed of its own is named after that record (`caseTitle`'s `subjectTitle`).
 */
export function caseSubject(values: Record<string, unknown>, caseType?: CaseTypeDef): { field: string; entity: string; id: string } | undefined {
  return caseRefs(values, caseType)[0]
}

/** The record type a list or named field holds its rows in (`List<ScreeningRow>` → ScreeningRow's fields). */
function rowFields(type: FieldDef['type'], caseType: CaseTypeDef | undefined): Record<string, FieldDef> | undefined {
  const inner = type.kind === 'list' ? type.of : type
  return inner.kind === 'named' ? caseType?.types?.[inner.name]?.fields : undefined
}

/**
 * The records a case's lists point at: each id of a `List<Ref<X>>`, and the Ref fields of the
 * rows of a list of records (`screening[].article`), in field order.
 */
export function caseNestedRefs(values: Record<string, unknown>, caseType?: CaseTypeDef): { field: string; entity: string; id: string }[] {
  const out: { field: string; entity: string; id: string }[] = []
  for (const [field, f] of Object.entries(caseType?.fields ?? {})) {
    const v = plainValue(values[field])
    if (f.type.kind === 'list' && f.type.of.kind === 'ref') {
      const entity = f.type.of.entity
      if (Array.isArray(v)) for (const id of v) if (typeof id === 'string' && id) out.push({ field, entity, id })
      continue
    }
    const rows = rowFields(f.type, caseType)
    if (!rows) continue
    for (const row of Array.isArray(v) ? v : [v]) {
      if (!row || typeof row !== 'object') continue
      for (const [col, cf] of Object.entries(rows)) {
        const id = (row as Record<string, unknown>)[col]
        if (cf.type.kind === 'ref' && typeof id === 'string' && id) out.push({ field, entity: cf.type.entity, id })
      }
    }
  }
  return out
}

/**
 * Ref values with their record's title (`titles`, by record id), so a screen shows the title, not
 * the id; a list of refs, or rows with Ref columns, carry `refTitles` (id → title); a list of
 * records carries its columns' types (`itemTypes`), so its cells read as dates, choices and years.
 */
export function withRefTitles(values: Record<string, MwCaseValue>, caseType: CaseTypeDef | undefined, titles?: ReadonlyMap<string, string>): Record<string, MwCaseValue> {
  const out = { ...values }
  for (const [field, f] of Object.entries(caseType?.fields ?? {})) {
    const v = out[field]
    if (!v || v.hidden) continue
    if (f.type.kind === 'ref') {
      const title = typeof v.value === 'string' ? titles?.get(v.value) : undefined
      if (title) out[field] = { ...v, refTitle: title }
      continue
    }
    const rows = rowFields(f.type, caseType)
    if (rows) out[field] = { ...out[field]!, itemTypes: Object.fromEntries(Object.entries(rows).map(([col, cf]) => [col, cf.typeSource])) }
    if (!titles?.size) continue
    const found: Record<string, string> = {}
    for (const r of caseNestedRefs({ [field]: v.value }, { ...caseType!, fields: { [field]: f } })) {
      const title = titles.get(r.id)
      if (title) found[r.id] = title
    }
    if (Object.keys(found).length) out[field] = { ...out[field]!, refTitles: found }
  }
  return out
}

export function caseTitle(values: Record<string, unknown>, caseId: string, caseType?: CaseTypeDef, project?: Pick<ProjectDefs, 'plugins'>, subjectTitle?: string): string {
  const plain = plainValue
  if (caseType?.id === PLUGIN_BINDING_CASE) {
    const plugin = plain(values.plugin)
    if (typeof plugin === 'string' && plugin.trim()) return `Bind ${project ? pluginTitle(project, plugin.trim()) : plugin.trim()}`
  }
  // `page_title`: a page's refresh is named after the page.
  for (const key of ['client_name', 'legal_name', 'title', 'subject', 'page_title']) {
    const v = plain(values[key])
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // The first text in the order the case type lists its fields (values come back in any order:
  // a document's "version" must not name it before its "artifact").
  const fields = Object.keys(caseType?.fields ?? {})
  // A case type whose first field is the record it is about ("Set up a watch" on a Topic, "Read
  // a paper" on an Article) is named after that record, not after the first text a step wrote
  // (the drafted PubMed query).
  const first = fields[0]
  if (subjectTitle?.trim() && first && caseType?.fields[first]?.type.kind === 'ref' && plain(values[first])) return subjectTitle.trim()
  for (const key of [...fields, ...Object.keys(values).filter((k) => !fields.includes(k))]) {
    const v = plain(values[key])
    const type = caseType?.fields[key]?.type
    const texty = !type || (type.kind === 'scalar' && (type.name === 'Text' || type.name === 'PersonName'))
    if (texty && typeof v === 'string' && v.trim()) return v.trim()
  }
  if (subjectTitle?.trim()) return subjectTitle.trim()
  // Nothing typed yet: a short, readable reference rather than the full id.
  return `New case ${caseId.slice(-6)}`
}

export function waitingOn(wf: WorkflowDef | undefined, state: string, status: string): MwCaseSummary['waitingOn'] {
  if (status !== 'active' || !wf) return undefined
  const step = wf.steps[state]
  if (step) {
    // A conversation step (building or changing a playbook by chat) waits for its person to
    // answer in the chat, not for the agent.
    if (isConversationStep(step)) {
      const role = step.assignee ?? wf.states[state]?.assignee ?? wf.owner
      return { kind: 'role', ...(role ? { role } : {}) }
    }
    if (step.performer === 'agent') return { kind: 'agent' }
    if (step.performer === 'system') return { kind: 'system' }
    return { kind: 'role', ...(step.assignee ? { role: step.assignee } : {}) }
  }
  // Phase 6: a hand-off block runs by itself; `wait_until` waits on a record's data, not on a person.
  const block = wf.states[state]?.block
  if (block) return { kind: block.kind === 'wait_until' ? 'condition' : 'system' }
  const role = wf.states[state]?.assignee ?? wf.owner
  return { kind: 'role', ...(role ? { role } : {}) }
}

// ---------------------------------------------------------------- fields

function recordTypesFor(project: ProjectDefs, caseType?: CaseTypeDef): Record<string, RecordTypeDef | { fields: Record<string, FieldDef> }> {
  const out: Record<string, { fields: Record<string, FieldDef> }> = {}
  for (const e of Object.values(project.entities)) out[e.entity] = { fields: e.fields }
  for (const [k, t] of Object.entries(caseType?.types ?? {})) out[k] = t
  return out
}

export function toField(ctx: DtoContext, name: string, def: FieldDef | WriteDef, caseType?: CaseTypeDef): MwField {
  const field = 'from' in def ? undefined : def
  const caseField = caseType?.fields[name]
  const access = (field?.access ?? caseField?.access)
  const description = field?.description ?? caseField?.description
  return {
    name,
    type: def.typeSource,
    schema: ctx.jsonSchema(def.type, recordTypesFor(ctx.project, caseType)),
    ...(def.required ? { required: true } : {}),
    ...(description ? { description } : {}),
    ...(access?.length ? { access: [...access] } : {}),
  }
}

export function caseFields(ctx: DtoContext, caseType: CaseTypeDef): MwField[] {
  return Object.entries(caseType.fields).map(([name, def]) => toField(ctx, name, def, caseType))
}

export function stepWriteFields(ctx: DtoContext, wf: WorkflowDef, step: StepDef): MwField[] {
  return Object.values(step.writes).map((w) => toField(ctx, w.field, w, wf.caseType))
}

/** Case field names a step reads (`case.pan` → `pan`). */
export function readFields(step: StepDef): string[] {
  return step.reads.map((r) => r.replace(/^case\./, '').split('.')[0]!).filter(Boolean)
}

// ---------------------------------------------------------------- policy

const TREATMENT_WORDS: Record<string, string> = {
  allow: 'allowed', preview: 'runs with a preview', approve: 'needs approval', deny: 'denied',
}

export function layerName(project: ProjectDefs, origin: RuleOrigin): string {
  switch (origin.layer) {
    case 'platform': return 'Built-in defaults'
    case 'plugin': return `Plugin ${origin.name}`
    case 'workspace': return 'Workspace house rules'
    case 'domain': return 'Domain policy'
    case 'workflow': {
      const wf = project.workflows[origin.name]
      return `Playbook "${wf?.title ?? origin.name}"`
    }
    case 'step': {
      const [wfId, stepId] = origin.name.split('/')
      const step = wfId && stepId ? project.workflows[wfId]?.steps[stepId] : undefined
      return `Step "${step?.title ?? origin.name}"`
    }
  }
  return origin.name
}

function duration(ms: number): string {
  const units: [string, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000], ['second', 1000]]
  for (const [unit, size] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size
      return `${n} ${unit}${n === 1 ? '' : 's'}`
    }
  }
  return `${Math.round(ms / 1000)} seconds`
}

const num = (n: number) => n.toLocaleString('en-US')

/** The effective policy as rows, each with the layer that set it, in plain words. */
export function policyRules(project: ProjectDefs, compiled: CompiledPolicy): MwPolicyRule[] {
  const e = compiled.effective
  const rows: MwPolicyRule[] = []
  const add = (subject: string, value: string, s: Sourced<unknown>, extra: Partial<MwPolicyRule> = {}) => {
    rows.push({
      subject, value, layer: s.origin.layer, layerName: layerName(project, s.origin),
      ...(s.origin.source ? { source: s.origin.source } : {}), ...extra,
    })
  }
  for (const cls of EFFECTS) {
    const t = e.effects[cls]
    if (t) add(cls, TREATMENT_WORDS[t.value] ?? t.value, t)
  }
  if (e.tools.allowed) add('tools allowed', e.tools.allowed.value.join(', ') || 'none', e.tools.allowed)
  for (const d of e.tools.denied) add(d.value, 'denied', d)
  for (const r of e.tools.required) add(r.value, 'must be used', r)
  for (const [tool, rule] of Object.entries(e.tools.perTool)) {
    if (rule.treatment) add(tool, TREATMENT_WORDS[rule.treatment.value] ?? rule.treatment.value, rule.treatment)
    if (rule.rateLimit) add(`${tool} rate limit`, `${num(rule.rateLimit.value.count)} per ${duration(rule.rateLimit.value.perMs)}`, rule.rateLimit)
  }
  const b = e.budgets
  if (b.tokens) add('tokens', num(b.tokens.value), b.tokens)
  if (b.timeMs) add('time', duration(b.timeMs.value), b.timeMs)
  if (b.modelCalls) add('model calls', num(b.modelCalls.value), b.modelCalls)
  if (b.money) add('money', `${num(b.money.value.amount)} ${b.money.value.currency}`, b.money)
  if (e.modelRoles) add('model roles', e.modelRoles.value.join(', ') || 'none', e.modelRoles)
  add('taint', e.taint.enabled.value ? 'on' : 'off', e.taint.enabled)
  add('outbound when tainted', TREATMENT_WORDS[e.taint.outboundWhenTainted.value] ?? e.taint.outboundWhenTainted.value, e.taint.outboundWhenTainted)
  const approvers = (e as { approvers?: Sourced<string[]> }).approvers
  if (approvers) add('approvals by', approvers.value.join(', ') || 'nobody', approvers)
  return rows
}

/** Why an effect needs approval, e.g. "outbound needs approval (Domain policy)". */
/** Effect classes in plain words, for people deciding approvals. */
const EFFECT_WORDS: Record<string, string> = {
  read: 'Looking things up',
  write: 'Changing records',
  outbound: 'Sending anything outside the firm',
  irreversible: 'Anything that cannot be undone',
}

export function approvalReason(project: ProjectDefs, compiled: CompiledPolicy | undefined, tool: string, effect: EffectClass): string {
  const what = EFFECT_WORDS[effect] ?? humanize(effect)
  if (!compiled) return `${what} needs approval first.`
  const perTool = compiled.effective.tools.perTool[tool]?.treatment
  if (perTool?.value === 'approve') return `"${tool}" needs approval first (set by: ${layerName(project, perTool.origin)}).`
  const cls = compiled.effective.effects[effect]
  if (cls?.value === 'approve') return `${what} needs approval first (set by: ${layerName(project, cls.origin)}).`
  const taint = compiled.effective.taint
  if (effect === 'outbound' && taint.outboundWhenTainted.value === 'approve') {
    return `The step read an uploaded document, so sending needs approval first (set by: ${layerName(project, taint.outboundWhenTainted.origin)}).`
  }
  return `${what} needs approval first.`
}

// ---------------------------------------------------------------- playbooks

function toolRef(ctx: DtoContext, name: string, required: boolean): MwToolRef {
  const info = ctx.tools.get(name)
  const domain = /^domain\.[^.]+\.(create|get)$/.exec(name)
  const effect = info?.effect ?? (domain ? (domain[1] === 'create' ? 'write' : 'read') : name.startsWith('recall.') ? 'read' : undefined)
  return {
    name,
    ...(info?.description ? { description: info.description } : {}),
    effect: (effect ?? 'irreversible') as MwEffectClass,
    classified: !!effect,
    required,
    ...(info?.plugin ? { plugin: info.plugin } : {}),
  }
}

export function toStep(ctx: DtoContext, wf: WorkflowDef, step: StepDef, policy?: CompiledPolicy): MwStep {
  const required = new Set(step.tools.required)
  return {
    id: step.id,
    title: step.title,
    performer: step.performer as MwPerformer,
    ...(step.assignee ? { assignee: step.assignee } : {}),
    strictness: step.strictness,
    instructions: step.instructions,
    reads: [...step.reads],
    writes: stepWriteFields(ctx, wf, step),
    tools: step.tools.allowed.map((t) => toolRef(ctx, t, required.has(t))),
    ...(step.model ? { modelRole: step.model } : {}),
    checkpoint: [...step.checkpoint],
    outcomes: [...step.outcomes],
    policy: policy ? policyRules(ctx.project, policy) : [],
    file: step.file,
  }
}

/** States in reading order: start first, then breadth-first along the declared transitions. */
export function orderStates(wf: WorkflowDef): string[] {
  const seen = new Set<string>()
  const queue = [wf.start]
  const out: string[] = []
  while (queue.length) {
    const s = queue.shift()!
    if (seen.has(s) || !wf.states[s]) continue
    seen.add(s)
    out.push(s)
    for (const target of Object.values(wf.states[s]!.on)) if (!seen.has(target)) queue.push(target)
    const timeout = wf.states[s]!.wait?.timeout?.target
    if (timeout && !seen.has(timeout)) queue.push(timeout)
  }
  for (const s of Object.keys(wf.states)) if (!seen.has(s)) out.push(s)
  return out
}

export function toState(wf: WorkflowDef, name: string): MwState {
  const s = wf.states[name]!
  const wait = s.wait
  return {
    id: name,
    ...(s.step || wf.steps[name] ? { stepId: s.step ?? name } : {}),
    on: { ...s.on },
    ...(wait ? {
      wait: {
        ...(wait.remindMs !== undefined ? { remindMs: wait.remindMs } : {}),
        ...(wait.timeout ? { timeout: { afterMs: wait.timeout.afterMs, target: wait.timeout.target } } : {}),
      },
    } : {}),
    ...(s.assignee ? { assignee: s.assignee } : !wf.steps[name] && wf.owner ? { assignee: wf.owner } : {}),
  }
}

export function workflowDiagnostics(ctx: DtoContext, wf: WorkflowDef): MwDiagnostic[] {
  const dir = wf.dir.replace(/\/$/, '')
  return ctx.diagnostics.filter((d) => d.file?.startsWith(`${dir}/`) || d.file === dir).map(toDiagnostic)
}

export function toPlaybook(ctx: DtoContext, wf: WorkflowDef, policies: Record<string, CompiledPolicy | undefined>): MwPlaybook {
  return {
    id: wf.id,
    version: wf.version,
    hash: wf.hash,
    title: wf.title ?? humanize(wf.id),
    start: wf.start,
    states: orderStates(wf).map((s) => toState(wf, s)),
    steps: Object.fromEntries(Object.values(wf.steps).map((st) => [st.id, toStep(ctx, wf, st, policies[st.id])])),
    caseFields: caseFields(ctx, wf.caseType),
    diagnostics: workflowDiagnostics(ctx, wf),
    ...(wf.origin ? { origin: toWorkflowOrigin(ctx.project, wf.origin) } : {}),
  }
}

// ---------------------------------------------------------------- cases

/**
 * A value's provenance as the screens show it: the kernel's own fields (`tainted`) are left out,
 * a tool value keeps the document and confidence it was read with (Phase 5), and a value a client
 * typed through a link keeps the link and the client's label.
 */
export function toProvenance(p: Provenance | MwProvenance): MwProvenance {
  switch (p.kind) {
    case 'input': return { kind: 'input', at: p.at, ...(p.by ? { by: p.by } : {}) }
    case 'tool': return {
      kind: 'tool', at: p.at, stepRunId: p.stepRunId, tool: p.tool, callId: p.callId,
      ...(p.document ? { document: p.document } : {}),
      ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}),
      ...(p.confirmedBy ? { confirmedBy: p.confirmedBy } : {}),
    }
    case 'judgement': return {
      kind: 'judgement', at: p.at, stepRunId: p.stepRunId, ...(p.rationale ? { rationale: p.rationale } : {}), ...(p.chatId ? { chatId: p.chatId } : {}),
    }
    case 'person': return { kind: 'person', at: p.at, by: p.by, ...(p.stepRunId ? { stepRunId: p.stepRunId } : {}) }
    case 'system': return { kind: 'system', at: p.at, ...(p.note ? { note: p.note } : {}) }
    case 'external': return { kind: 'external', at: p.at, by: p.by, linkId: p.linkId, stepRunId: p.stepRunId }
  }
  return p
}

export function toCaseValue(v: { value: unknown; provenance: Provenance | MwProvenance; hidden?: boolean; tainted?: boolean } | undefined): MwCaseValue | undefined {
  if (!v) return undefined
  // What a client typed is untrusted input (D67), whatever the view says.
  const tainted = v.tainted || v.provenance.kind === 'external'
  return {
    value: v.hidden ? null : v.value,
    provenance: toProvenance(v.provenance),
    ...(tainted ? { tainted: true } : {}),
    ...(v.hidden ? { hidden: true } : {}),
  }
}

export function toCaseValues(values: Record<string, Parameters<typeof toCaseValue>[0]>, only?: string[]): Record<string, MwCaseValue> {
  const out: Record<string, MwCaseValue> = {}
  for (const key of only ?? Object.keys(values)) {
    const v = toCaseValue(values[key])
    if (v) out[key] = v
  }
  return out
}

/** `subjects`: the titles of the records cases are about, by record id (`caseSubject`). */
export function toCaseSummary(project: ProjectDefs, s: CaseSummary, subjects?: ReadonlyMap<string, string>): MwCaseSummary {
  const wf = project.workflows[s.workflowId]
  const wait = waitingOn(wf, s.state, s.status)
  const subject = caseSubject(s.values, wf?.caseType)
  return {
    caseId: s.caseId,
    runId: s.runId,
    workflowId: s.workflowId,
    workflowVersion: s.workflowVersion,
    title: caseTitle(s.values, s.caseId, wf?.caseType, project, subject && subjects?.get(subject.id)),
    state: s.state,
    stateTitle: stateTitle(wf, s.state),
    status: s.status,
    ...(s.stopReason ? { stopReason: s.stopReason } : {}),
    ...(wait ? { waitingOn: wait } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(wf?.domain ? { domain: wf.domain } : {}),
    ...(s.project ? { project: s.project } : {}),
  }
}

export function toStepRunSummary(project: ProjectDefs, workflowId: string, r: StepRunSummary): MwStepRunSummary {
  const wf = project.workflows[workflowId]
  return {
    stepRunId: r.stepRunId,
    stepId: r.stepId,
    title: stateTitle(wf, r.stepId),
    performer: r.performer as MwPerformer,
    attempt: r.attempt,
    status: r.status,
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.rationale ? { rationale: r.rationale } : {}),
    ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
    ...(r.comment ? { comment: r.comment } : {}),
    tainted: r.tainted,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
  }
}

export function toTransition(t: TransitionRecord): MwTransition {
  const { type, ...rest } = t.event
  const note = t.note ?? (typeof rest.comment === 'string' ? rest.comment : undefined)
  return {
    seq: t.seq, from: t.from, to: t.to, event: type, source: t.source, accepted: t.accepted,
    ...(note ? { note } : {}), ...(t.stepRunId ? { stepRunId: t.stepRunId } : {}), at: t.at,
  }
}

// ---------------------------------------------------------------- external links and deliveries (Phase 5)

export function toExternalLink(l: ExternalLinkSummary): MwExternalLink {
  const out: MwExternalLink = {
    id: l.id, kind: l.kind, status: l.status, runId: l.runId, caseId: l.caseId,
    participant: { ...(l.participant.name ? { name: l.participant.name } : {}), ...(l.participant.email ? { email: l.participant.email } : {}), ...(l.participant.phone ? { phone: l.participant.phone } : {}) },
    createdAt: l.createdAt, expiresAt: l.expiresAt,
  }
  const optional = ['stepId', 'stepRunId', 'via', 'note', 'createdBy', 'sentAt', 'firstOpenedAt', 'lastOpenedAt', 'draftSavedAt', 'usedAt', 'closedAt', 'closedReason', 'personId', 'itemId'] as const
  for (const k of optional) if (l[k] !== undefined && l[k] !== null) (out as unknown as Record<string, unknown>)[k] = l[k]
  return out
}

export function toDelivery(d: Delivery): MwDelivery {
  return {
    id: d.id, channel: d.channel, to: d.to, purpose: d.purpose, status: d.status, at: d.at,
    ...(d.linkId ? { linkId: d.linkId } : {}), ...(d.personId ? { personId: d.personId } : {}), ...(d.itemId ? { itemId: d.itemId } : {}),
    ...(d.error ? { error: d.error } : {}), ...(d.providerId ? { providerId: d.providerId } : {}),
  }
}

export function toExtractSuggestion(x: ExtractSuggestion): MwExtractSuggestion {
  return {
    id: x.id, field: x.field, value: x.value, confidence: x.confidence, document: x.document, documentId: x.documentId,
    ...(x.quote ? { quote: x.quote } : {}), found: x.found, prefill: x.prefill,
  }
}

export function toExtractResult(r: ExtractResult): MwExtractResult {
  return { suggestions: r.suggestions.map(toExtractSuggestion), ...(r.notes?.length ? { notes: [...r.notes] } : {}) }
}

/** What an input item's form may read from its documents (`extract:` on the step, 23 §5). */
export function toInboxExtract(step: StepDef | undefined): { documentsField: string; fields: string[]; minConfidence: number } | undefined {
  const x = step?.extract
  if (!x) return undefined
  return { documentsField: x.documents, fields: [...new Set(Object.values(x.fields))], minConfidence: x.minConfidence }
}

/** `subjects`: the titles of the records the case points at (its Ref values, what it waits on), by record id. */
export function toCase(ctx: DtoContext, view: CaseView, extra: { links?: ExternalLinkSummary[]; deliveries?: Delivery[]; subjects?: ReadonlyMap<string, string>; linkTitles?: ReadonlyMap<string, string> } = {}): MwCase {
  const wf = ctx.project.workflows[view.summary.workflowId]
  const values = Object.fromEntries(Object.entries(view.values).map(([k, v]) => [k, v.hidden ? undefined : v.value]))
  const subject = caseSubject(values, wf?.caseType)
  return {
    ...toCaseSummary(ctx.project, view.summary, extra.subjects),
    title: caseTitle(values, view.summary.caseId, wf?.caseType, ctx.project, subject && extra.subjects?.get(subject.id)),
    fields: wf ? caseFields(ctx, wf.caseType) : [],
    values: withRefTitles(toCaseValues(view.values), wf?.caseType, extra.subjects),
    timeline: view.stepRuns.map((r) => toStepRunSummary(ctx.project, view.summary.workflowId, r)),
    transitions: view.transitions.map(toTransition),
    path: [...view.path],
    ...(extra.links ? { links: [...extra.links].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toExternalLink) } : {}),
    ...(extra.deliveries ? { deliveries: [...extra.deliveries].sort((a, b) => b.at.localeCompare(a.at)).map(toDelivery) } : {}),
    // Phase 6: hand-offs, the `wait_until` condition, the domain
    ...(view.links?.length ? { caseLinks: view.links.map((l) => toCaseLink(ctx.project, l, extra.linkTitles?.get(l.caseId))) } : {}),
    ...(view.waiting ? { waiting: toWaiting(view.waiting, ctx.project, extra.subjects) } : {}),
    ...(view.domain ?? wf?.domain ? { domain: view.domain ?? wf?.domain } : {}),
  }
}

/** `redacted`: the bodies (request, response, error text) are left out; names, kinds and timings stay. */
export function toJournalEntry(j: JournalEntry, redacted = false): MwJournalEntry {
  return {
    key: j.journalKey,
    kind: j.kind,
    name: j.name,
    ...(j.callId ? { callId: j.callId } : {}),
    ...(redacted ? { redacted: true } : {
      request: j.request,
      ...(j.response !== undefined ? { response: j.response } : {}),
      ...(j.error ? { error: j.error } : {}),
    }),
    ...(redacted && j.error ? { failed: true } : {}),
    ...(j.effect ? { effect: j.effect } : {}),
    startedAt: j.startedAt,
    ...(j.durationMs !== undefined ? { durationMs: j.durationMs } : {}),
  }
}

// ---------------------------------------------------------------- restricted fields (19 §3)

/** Who reads a record: a person's roles. Fields with `access:` show only to those roles. */
export interface Viewer { roles: readonly string[] }

export function maySee(viewer: Viewer, field: { access?: readonly string[] } | undefined): boolean {
  return !field?.access?.length || field.access.some((r) => viewer.roles.includes(r))
}

/** Values for this viewer: a field they may not see keeps its provenance, its value is nulled and marked hidden. */
export function visibleCaseValues(
  values: Record<string, Parameters<typeof toCaseValue>[0]>,
  fields: Record<string, FieldDef>,
  viewer: Viewer,
): Record<string, MwCaseValue> {
  const out: Record<string, MwCaseValue> = {}
  for (const [k, raw] of Object.entries(values)) {
    if (!raw) continue
    const v = maySee(viewer, fields[k]) ? raw : { ...raw, hidden: true }
    const mapped = toCaseValue(v)
    if (mapped) out[k] = mapped
  }
  return out
}

/**
 * Restricted case fields a step touches (reads, writes, was given or recorded) that this viewer
 * may not see. When there are any, the step's model prompts and tool calls may carry them, so
 * the journal bodies are left out for this viewer.
 */
export function hiddenStepFields(wf: WorkflowDef | undefined, r: Pick<StepRecord, 'stepId' | 'outputs' | 'context'>, viewer: Viewer): string[] {
  const fields = wf?.caseType.fields ?? {}
  const step = wf?.steps[r.stepId]
  const touched = new Set<string>([
    ...(step ? readFields(step) : []),
    ...(step ? Object.values(step.writes).map((w) => w.field) : []),
    ...Object.keys(r.outputs ?? {}),
    ...Object.keys(r.context?.pushed ?? {}),
  ])
  return [...touched].filter((k) => !maySee(viewer, fields[k]))
}

/**
 * The journal as the screens list it. Each model call is journaled twice, once before it is sent
 * (`<key>#<attempt>`, kept so a call cut off mid-request leaves a trace) and once with its answer
 * (`<key>`); the first is dropped when the answer is there, so the list counts calls like usage does.
 */
export function visibleJournal(journal: JournalEntry[], redacted: boolean): MwJournalEntry[] {
  const keys = new Set(journal.map((j) => j.journalKey))
  return journal
    .filter((j) => {
      if (j.kind !== 'model') return true
      const m = /^(.*)#\d+$/.exec(j.journalKey)
      return !(m && keys.has(m[1]!))
    })
    .map((j) => toJournalEntry(j, redacted))
}

export function toStepRecord(project: ProjectDefs, r: StepRecord & { journal: JournalEntry[] }, summary: StepRunSummary | undefined, viewer: Viewer): MwStepRecord {
  const wf = project.workflows[r.workflowId]
  const step = wf?.steps[r.stepId]
  const fields = wf?.caseType.fields ?? {}
  const redacted = hiddenStepFields(wf, r, viewer).length > 0
  const decidedBy = summary?.decidedBy ?? (r as { decidedBy?: string }).decidedBy
  const comment = summary?.comment ?? (r as { comment?: string }).comment
  return {
    stepRunId: r.stepRunId,
    stepId: r.stepId,
    title: stateTitle(wf, r.stepId),
    performer: r.performer as MwPerformer,
    attempt: r.attempt,
    status: r.status,
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(r.rationale ? { rationale: r.rationale } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...(comment ? { comment } : {}),
    tainted: r.tainted,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    runId: r.runId,
    caseId: r.caseId,
    workflowId: r.workflowId,
    workflowVersion: r.workflowVersion,
    ...(r.context?.modelRole || step?.model ? { modelRole: r.context?.modelRole ?? step?.model } : {}),
    ...(r.context ? {
      context: { pushed: visibleCaseValues(r.context.pushed, fields, viewer), tools: r.context.tools.map((t) => t.tool), modelRole: r.context.modelRole },
    } : {}),
    outputs: visibleCaseValues(r.outputs, fields, viewer),
    checkpoint: r.checkpoint.map((c) => ({ rule: c.rule, kind: c.kind, passed: c.passed, ...(c.reason ? { reason: c.reason } : {}) })),
    journal: visibleJournal(r.journal, redacted),
    ...(redacted ? { restricted: true } : {}),
    usage: {
      tokens: r.usage.tokens, modelCalls: r.usage.modelCalls, durationMs: r.usage.durationMs,
      ...(r.usage.costUsd !== undefined ? { costUsd: r.usage.costUsd } : {}),
    },
  }
}

// ---------------------------------------------------------------- domain

export function toEntityType(ctx: DtoContext, e: EntityTypeDef, key?: string): MwEntityType {
  return {
    name: e.entity,
    fields: Object.entries(e.fields).map(([name, def]) => toField(ctx, name, def)),
    ...(e.lifecycle ? { lifecycle: [...e.lifecycle] } : {}),
    // Phase 6: the entity key, its domain, and its definition for the Entities page
    ...(key ? { key } : {}),
    ...(e.domain ? { domain: e.domain } : {}),
    ...(key ? { definition: toEntityDefinition(ctx.project, key, e) } : {}),
  }
}

export function toEntityRow(row: EntityRow): MwEntityRow {
  const hidden = new Set(row.hidden)
  const values: Record<string, MwCaseValue> = {}
  const provenance = { kind: 'system' as const, at: row.createdAt }
  for (const [k, v] of Object.entries(row.values)) {
    values[k] = hidden.has(k) ? { value: null, provenance, hidden: true } : { value: v, provenance }
  }
  for (const k of hidden) values[k] ??= { value: null, provenance, hidden: true }
  return { id: row.id, values, createdAt: row.createdAt }
}

// ---------------------------------------------------------------- Phase 3: drafts, versions (20 §6)

/** Facts about a draft the DTOs need beyond its files. */
export interface DraftFacts {
  meta: DraftMeta
  edits: DraftEdit[]
  report?: DraftReport
  contentHash: string
  /** The change run (create-playbook / change-playbook) and where it is; `inChat` while it waits at its conversation step. */
  run?: { runId: string; caseId: string; state: string; status: string; inChat?: boolean }
  changedFiles: number
  playbookTitle: string
  names: Map<string, string>
}

/** Where a draft is: published/discarded from its meta; in review while its change run waits at `review`; checked or failed when the last report covers the current content. */
export function draftStage(f: Pick<DraftFacts, 'meta' | 'report' | 'contentHash' | 'run'>): MwDraftStage {
  if (f.meta.status === 'published') return 'published'
  if (f.meta.status === 'discarded') return 'discarded'
  if (f.run && f.run.status === 'active' && f.run.state === 'review') return 'in_review'
  if (f.report && f.report.hash === f.contentHash) return f.report.outcome === 'passed' ? 'checked' : 'failed'
  return 'draft'
}

export function toDraftSummary(f: DraftFacts): MwDraftSummary {
  const m = f.meta
  const updatedAt = [m.createdAt, m.publishedAt, ...f.edits.map((e) => e.at), f.report?.at].filter((x): x is string => !!x).sort().at(-1) ?? m.createdAt
  const createdByName = f.names.get(m.createdBy)
  return {
    id: m.id,
    title: m.title,
    workflowId: m.workflowId,
    playbookTitle: f.playbookTitle,
    kind: m.kind,
    ...(m.plugin ? { plugin: { id: m.plugin.id, version: m.plugin.version } } : {}),
    stage: draftStage(f),
    createdBy: m.createdBy,
    ...(createdByName ? { createdByName } : {}),
    createdAt: m.createdAt,
    updatedAt,
    pendingEdits: f.edits.filter((e) => e.status === 'pending').length,
    changedFiles: f.changedFiles,
    ...(m.baseVersion !== undefined ? { baseVersion: m.baseVersion } : {}),
    ...(m.publishedVersion !== undefined ? { publishedVersion: m.publishedVersion } : {}),
    ...(f.run ? { runId: f.run.runId, caseId: f.run.caseId } : m.runId ? { runId: m.runId } : {}),
    ...(m.status === 'open' && f.run?.status === 'active' && f.run.inChat ? { inChat: true } : {}),
  }
}

export function toDraftEdit(e: DraftEdit, names: Map<string, string>): MwDraftEdit {
  const byName = names.get(e.by)
  return {
    id: e.id, at: e.at, by: e.by, ...(byName ? { byName } : {}), via: e.via,
    ...(e.chatId ? { sessionId: e.chatId } : {}), summary: e.summary, paths: e.files.map((x) => x.path), status: e.status,
  }
}

/** The pending chat edit that last touched each path (the editor highlights those). */
export function pendingEditByPath(edits: DraftEdit[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of edits) {
    if (e.status !== 'pending') continue
    for (const f of e.files) out.set(f.path, e.id)
  }
  return out
}

export function toFileChange(f: FileChange, pending: Map<string, string>): MwFileChange {
  const editId = pending.get(f.path)
  return {
    path: f.path, status: f.status,
    hunks: f.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines.map((l) => ({ kind: l.kind, text: l.text })) })),
    ...(f.conflict ? { conflict: true } : {}),
    ...(editId ? { pendingEditId: editId } : {}),
    ...(typeof f.before === 'string' ? { before: f.before } : {}),
    ...(typeof f.after === 'string' ? { after: f.after } : {}),
  }
}

export function toStructuralDiff(s: StructuralDiff): MwStructuralDiff {
  return {
    states: { ...s.states },
    transitions: s.transitions.map((t) => ({ ...t })),
    steps: Object.fromEntries(Object.entries(s.steps).map(([k, v]) => [k, { change: v.change, parts: [...v.parts] }])),
    caseFields: { added: [...s.caseFields.added], removed: [...s.caseFields.removed], changed: [...s.caseFields.changed] },
    tools: { added: [...s.tools.added], removed: [...s.tools.removed] },
    requiredTools: s.requiredTools.map((t) => ({ ...t })),
    roles: { added: [...s.roles.added], removed: [...s.roles.removed] },
    examples: { added: [...s.examples.added], removed: [...s.examples.removed], changed: [...s.examples.changed] },
    version: { ...(s.version.from !== undefined ? { from: s.version.from } : {}), ...(s.version.to !== undefined ? { to: s.version.to } : {}) },
    playbook: [...s.playbook],
  }
}

export function toImpact(i: Impact, ctx?: Pick<DtoContext, 'project'>): MwImpact {
  return {
    ...(i.liveVersion !== undefined ? { liveVersion: i.liveVersion } : {}),
    newVersion: i.newVersion,
    openCases: { total: i.openCases.total, byState: { ...i.openCases.byState } },
    removedStatesWithCases: i.removedStatesWithCases.map((r) => ({ ...r })),
    newTools: i.newTools.map((t) => ({
      name: t.name, bound: t.bound,
      ...(t.effect ? { effect: t.effect as MwEffectClass } : {}), ...(t.treatment ? { treatment: t.treatment as MwTreatment } : {}),
      ...(t.plugin ? { plugin: t.plugin } : {}),
    })),
    newRequiredTools: i.newRequiredTools.map((t) => ({ ...t })),
    caseFields: { added: [...i.caseFields.added], removed: [...i.caseFields.removed], changed: [...i.caseFields.changed] },
    otherPlaybooks: i.otherPlaybooks.map((p) => {
      const title = ctx?.project.workflows[p.id]?.title
      return {
        id: p.id, uses: [...p.uses], ...(title ? { title } : {}),
        ...(p.entities ? { entities: [...p.entities] } : {}), ...(p.roles ? { roles: [...p.roles] } : {}),
      }
    }),
    summary: [...i.summary],
  }
}

/** `ctx` names the other playbooks in the impact by their titles. */
export function toDraftReport(r: DraftReport, ctx?: Pick<DtoContext, 'project'>): MwDraftReport {
  return {
    hash: r.hash, at: r.at,
    diagnostics: r.diagnostics.map(toDiagnostic),
    errors: r.errors, warnings: r.warnings,
    examples: r.examples.map((e) => ({ name: e.name, status: e.status, differences: [...e.differences], ...(e.reason ? { reason: e.reason } : {}) })),
    pastCases: r.pastCases.map((p) => ({ caseId: p.caseId, title: p.title, status: p.status, differences: [...p.differences], livePath: [...p.livePath], draftPath: [...p.draftPath] })),
    ...(r.impact ? { impact: toImpact(r.impact, ctx) } : {}),
    outcome: r.outcome, summary: r.summary,
  }
}

export function toVersion(v: WorkflowVersion, names: Map<string, string>, origin?: MwWorkflowOrigin): MwVersion {
  const publishedByName = v.publishedBy ? names.get(v.publishedBy) : undefined
  return {
    version: v.version, hash: v.hash, publishedAt: v.publishedAt,
    ...(v.publishedBy ? { publishedBy: v.publishedBy } : {}), ...(publishedByName ? { publishedByName } : {}),
    source: v.source, ...(v.draftId ? { draftId: v.draftId } : {}), ...(v.runId ? { runId: v.runId } : {}),
    ...(origin ? { origin } : {}),
    openCases: v.openCases, live: v.live,
  }
}

/**
 * Where a version of a plugin playbook came from (22 §3): the index records the resolved workflow
 * as found in the files, but it is the binding that made it. The live hash is the workflow's own
 * origin; an older one is the binding frozen last before the version was indexed.
 */
export function versionOrigin(
  v: Pick<WorkflowVersion, 'hash' | 'publishedAt' | 'source'>, wf: Pick<WorkflowDef, 'hash' | 'origin'> | undefined,
  project: Pick<ProjectDefs, 'plugins'>, bindings: readonly Pick<MwBindingVersion, 'version' | 'pluginVersion' | 'frozenAt'>[],
): MwWorkflowOrigin | undefined {
  const o = wf?.origin
  if (v.source !== 'files' || o?.kind !== 'plugin') return undefined
  if (v.hash === wf!.hash) return toWorkflowOrigin(project, o)
  const at = Date.parse(v.publishedAt)
  const b = bindings
    .filter((x) => Date.parse(x.frozenAt) <= at)
    .sort((x, y) => Date.parse(y.frozenAt) - Date.parse(x.frozenAt) || y.version - x.version)[0]
  return b ? toWorkflowOrigin(project, { kind: 'plugin', plugin: o.plugin, pluginVersion: b.pluginVersion, bindingVersion: b.version }) : undefined
}

// ---------------------------------------------------------------- Phase 4: plugins, bindings, identity (22 §9)

const EFFECT_SET = new Set<string>(EFFECTS)
const asEffect = (e: unknown): MwEffectClass | undefined => (typeof e === 'string' && EFFECT_SET.has(e) ? e as MwEffectClass : undefined)
const plain = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T)

/** A plugin's title from the indexed project, else its id. */
export function pluginTitle(project: Pick<ProjectDefs, 'plugins'>, pluginId: string): string {
  return project.plugins?.[pluginId]?.manifest.title ?? pluginId
}

/** "from Client intake 1.0.0" */
export function toWorkflowOrigin(project: Pick<ProjectDefs, 'plugins'>, o: WorkflowOrigin): MwWorkflowOrigin {
  return {
    kind: o.kind, plugin: o.plugin, pluginTitle: pluginTitle(project, o.plugin), pluginVersion: o.pluginVersion,
    ...(o.bindingVersion !== undefined ? { bindingVersion: o.bindingVersion } : {}),
  }
}

export function toBindingState(b: BindingState, names: Map<string, string>): MwBindingState {
  switch (b.status) {
    case 'unbound': return { status: 'unbound' }
    case 'binding': return { status: 'binding', runId: b.runId, caseId: b.caseId, ...(b.draftId ? { draftId: b.draftId } : {}) }
    case 'bound': {
      const frozenByName = b.frozenBy ? names.get(b.frozenBy) : undefined
      return {
        status: 'bound', version: b.version, pluginVersion: b.pluginVersion,
        ...(b.frozenAt ? { frozenAt: b.frozenAt } : {}), ...(b.frozenBy ? { frozenBy: b.frozenBy } : {}),
        ...(frozenByName ? { frozenByName } : {}),
      }
    }
  }
}

export function toPluginSummary(p: PluginSummary, names: Map<string, string>): MwPluginSummary {
  return {
    id: p.id, version: p.version, versions: [...p.versions], title: p.title,
    ...(p.description ? { description: p.description } : {}),
    trust: p.trust, ...(p.imported ? { imported: p.imported } : {}),
    tools: p.tools, workflows: [...p.workflows], provides: [...p.provides], requires: [...p.requires],
    binding: toBindingState(p.binding, names),
    ...(p.upgradeAvailable ? { upgradeAvailable: true } : {}),
  }
}

/** The class MCP annotations suggest (06 §3): read-only → read, destructive → irreversible, otherwise none. */
export function classFromAnnotations(a: PluginToolDef['annotations']): MwEffectClass | undefined {
  if (!a) return undefined
  if (a.readOnlyHint) return 'read'
  if (a.destructiveHint) return 'irreversible'
  return undefined
}

function routeKind(t: PluginToolDef | undefined): MwPluginTool['route'] {
  if (!t) return 'builtin'
  return 'mcp' in t.run ? 'mcp' : 'command' in t.run ? 'command' : 'builtin'
}

/**
 * One tool for the screens: its effective class, where that came from, and what the manifest and
 * MCP hints said (so the review can show "declared read" next to the binding's choice).
 */
export function toPluginTool(
  name: string,
  def: PluginToolDef | undefined,
  effective: { effect?: EffectClass; from: MwClassSource; off?: boolean; description?: string },
  bound?: BindingDef['tools'][string],
  capability?: string,
): MwPluginTool {
  const effect = asEffect(effective.effect)
  const declared = asEffect(def?.effect)
  const hinted = classFromAnnotations(def?.annotations)
  const cap = capability ?? def?.capability
  return {
    name, description: effective.description ?? def?.description ?? '',
    ...(effect ? { effect } : {}), from: effective.from,
    ...(effective.off || bound?.off ? { off: true } : {}),
    ...(declared ? { declared } : {}), ...(hinted ? { hinted } : {}),
    ...(bound?.reason ? { reason: bound.reason } : {}),
    route: routeKind(def),
    ...(cap ? { capability: cap } : {}),
  }
}

function serverOf(name: string, s: McpServerDef): MwPluginDetail['servers'][number] {
  if ('source' in s) return { name, kind: 'source', detail: s.source }
  if ('url' in s) return { name, kind: 'url', detail: s.url }
  return { name, kind: 'command', detail: [s.command, ...(s.args ?? [])].join(' ') }
}

/** Tool name → the capability it provides, from the manifest's `provides`. */
function providedBy(provides: Record<string, { tool: string }>): Map<string, string> {
  return new Map(Object.entries(provides).map(([cap, p]) => [p.tool, cap]))
}

export interface PluginDetailFacts {
  project: Pick<ProjectDefs, 'workflows' | 'bindings' | 'plugins'>
  names: Map<string, string>
  history: MwBindingVersion[]
}

export function toPluginDetail(p: PluginDetail, f: PluginDetailFacts): MwPluginDetail {
  const m = p.manifest
  const binding = f.project.bindings?.[p.id]
  const caps = providedBy(m.provides.capabilities)
  const live = new Set(Object.values(f.project.workflows).filter((w) => w.origin?.plugin === p.id).map((w) => w.id))
  return {
    ...toPluginSummary(p, f.names),
    dir: p.dir, hash: p.hash,
    toolList: p.toolClasses.map((tc) => toPluginTool(tc.name, m.tools[tc.name], tc, binding?.tools[tc.name], caps.get(tc.name))),
    workflowList: m.workflows.map((id) => ({ id, title: f.project.workflows[id]?.title ?? humanize(id), live: live.has(id) })),
    skills: p.skills.map((s) => ({ name: s.name, ...(s.description ? { description: s.description } : {}) })),
    providesList: Object.entries(m.provides.capabilities).map(([name, x]) => ({ name, tool: x.tool })),
    requiresList: Object.entries(m.requires.capabilities).map(([name, x]) => ({
      name, as: x.as, ...(x.optional ? { optional: true } : {}),
      ...(binding?.capabilities[name] ? { boundTo: binding.capabilities[name] } : {}),
    })),
    entities: Object.values(m.requires.entities).map((e) => ({
      name: e.name,
      fields: Object.entries(e.fields).map(([name, x]) => ({ name, type: x.typeSource, ...(x.required ? { required: true } : {}) })),
    })),
    roles: Object.entries(m.requires.roles).map(([id, r]) => ({ id, title: r.title ?? humanize(id) })),
    records: Object.values(m.records).map((r) => ({ name: r.name, ...(r.title ? { title: r.title } : {}), key: r.key, fields: { ...r.fields } })),
    servers: Object.entries(m.mcpServers).map(([name, s]) => serverOf(name, s)),
    notes: [...p.notes],
    ...(m.environment && (m.environment.runtime || m.environment.network) ? {
      environment: {
        ...(m.environment.runtime ? { runtime: m.environment.runtime } : {}),
        ...(m.environment.network ? { network: [...m.environment.network] } : {}),
      },
    } : {}),
    bindingHistory: f.history,
  }
}

/** A row of `mw.binding_versions`, newest first by the caller. */
export function toBindingVersion(r: {
  version: number; plugin_version: string; hash: string; frozen_by?: string | null; run_id?: string | null; draft_id?: string | null;
  frozen_at: string | Date
}, names: Map<string, string>): MwBindingVersion {
  const name = r.frozen_by ? names.get(r.frozen_by) : undefined
  return {
    version: Number(r.version), pluginVersion: r.plugin_version, hash: r.hash,
    ...(r.frozen_by ? { frozenBy: r.frozen_by } : {}), ...(name ? { frozenByName: name } : {}),
    ...(r.run_id ? { runId: r.run_id } : {}), ...(r.draft_id ? { draftId: r.draft_id } : {}),
    frozenAt: r.frozen_at instanceof Date ? r.frozen_at.toISOString() : String(r.frozen_at),
  }
}

export function toPolicyDoc(d: PolicyDoc): MwPolicyDoc {
  const { name: _name, file: _file, ...rest } = d
  return plain(rest) as MwPolicyDoc
}

/** A policy layer in plain words (the plugin's defaults, the binding's tightening). */
export function policyDocLines(d: PolicyDoc | MwPolicyDoc | undefined): MwPolicyLine[] {
  if (!d) return []
  const out: MwPolicyLine[] = []
  const words = (t: string) => TREATMENT_WORDS[t] ?? t
  for (const cls of EFFECTS) {
    const t = d.effects?.[cls]
    if (t) out.push({ subject: cls, value: words(t) })
  }
  if (d.tools?.allow) out.push({ subject: 'tools allowed', value: d.tools.allow.join(', ') || 'none' })
  for (const t of d.tools?.deny ?? []) out.push({ subject: t, value: 'denied' })
  for (const t of d.tools?.require ?? []) out.push({ subject: t, value: 'must be used' })
  for (const [tool, rule] of Object.entries(d.tools?.rules ?? {})) {
    if (rule.treatment) out.push({ subject: tool, value: words(rule.treatment) })
    if (rule.rateLimit) out.push({ subject: `${tool} rate limit`, value: `${num(rule.rateLimit.count)} per ${duration(rule.rateLimit.perMs)}` })
  }
  const b = d.budgets
  if (b?.tokens) out.push({ subject: 'tokens', value: num(b.tokens) })
  if (b?.timeMs) out.push({ subject: 'time', value: duration(b.timeMs) })
  if (b?.modelCalls) out.push({ subject: 'model calls', value: num(b.modelCalls) })
  if (b?.money) out.push({ subject: 'money', value: `${num(b.money.amount)} ${b.money.currency}` })
  if (d.modelRoles) out.push({ subject: 'model roles', value: d.modelRoles.join(', ') || 'none' })
  if (d.taint?.enabled !== undefined) out.push({ subject: 'taint', value: d.taint.enabled ? 'on' : 'off' })
  if (d.taint?.outboundWhenTainted) out.push({ subject: 'outbound when tainted', value: words(d.taint.outboundWhenTainted) })
  if (d.approvals?.by) out.push({ subject: 'approvals by', value: d.approvals.by.join(', ') || 'nobody' })
  return out
}

export function toBinding(b: BindingDef, names: Map<string, string>): MwBinding {
  const byName = b.frozen ? names.get(b.frozen.by) : undefined
  return {
    plugin: b.plugin, pluginVersion: b.pluginVersion, pluginHash: b.pluginHash, version: b.version,
    ...(b.frozen ? { frozen: { by: b.frozen.by, ...(byName ? { byName } : {}), at: b.frozen.at, ...(b.frozen.runId ? { runId: b.frozen.runId } : {}) } } : {}),
    tools: Object.fromEntries(Object.entries(b.tools).map(([k, v]) => [k, {
      ...(asEffect(v.effect) ? { effect: asEffect(v.effect)! } : {}), ...(v.off ? { off: true } : {}), ...(v.reason ? { reason: v.reason } : {}),
    }])),
    capabilities: { ...b.capabilities },
    entities: Object.fromEntries(Object.entries(b.entities).map(([k, v]) => [k, { entity: v.entity, fields: { ...v.fields } }])),
    roles: { ...b.roles },
    records: Object.fromEntries(Object.entries(b.records).map(([k, r]) => [k, {
      entity: r.entity,
      fields: Object.fromEntries(Object.entries(r.fields).map(([f, m]) => [f, {
        ...(m.from !== undefined ? { from: m.from } : {}),
        ...(m.transform ? { transform: plain(m.transform) as MwTransform[] } : {}),
        ...(m.direction ? { direction: m.direction } : {}),
      }])),
      identity: {
        keys: [...r.identity.keys],
        ...(r.identity.fuzzy ? { fuzzy: { ...r.identity.fuzzy } } : {}),
        ...(r.identity.createMissing !== undefined ? { createMissing: r.identity.createMissing } : {}),
      },
    }])),
    ...(b.policy ? { policy: toPolicyDoc(b.policy) } : {}),
    ...(b.dryRun ? { dryRun: { ...b.dryRun } } : {}),
  }
}

export function toBindingGap(g: BindingGap): MwBindingGap {
  return { kind: g.kind, subject: g.subject, message: g.message, ...(g.suggestions?.length ? { suggestions: [...g.suggestions] } : {}) }
}

export function toMappedRecord(r: MappedRecord & { raw?: unknown }): MwMappedRecord {
  const raw = r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw) ? plain(r.raw as Record<string, unknown>) : undefined
  return {
    source: r.source, externalId: r.externalId, ...(raw ? { raw } : {}),
    values: plain(r.values), extra: plain(r.extra), errors: [...r.errors], roundTrip: [...r.roundTrip],
  }
}

export function toBindingReport(r: BindingReport, project: Pick<ProjectDefs, 'workflows'>): MwBindingReport {
  return {
    hash: r.hash, at: r.at,
    diagnostics: r.diagnostics.map(toDiagnostic), errors: r.errors, warnings: r.warnings,
    examples: r.examples.map((e) => ({ name: e.name, status: e.status, differences: [...e.differences], ...(e.reason ? { reason: e.reason } : {}) })),
    records: r.records.map(toMappedRecord),
    ...(r.impact?.length ? {
      impact: r.impact.map((d) => ({ workflowId: d.workflowId, title: project.workflows[d.workflowId]?.title ?? humanize(d.workflowId), diff: toStructuralDiff(d) })),
    } : {}),
    outcome: r.outcome, summary: r.summary,
  }
}

export interface BindingViewFacts {
  project: Pick<ProjectDefs, 'entities' | 'plugins' | 'bindings' | 'workflows'>
  names: Map<string, string>
  /** The plugin as installed (the version the binding pins, else the newest). */
  plugin?: PluginDetail
  /** The draft is open. */
  editable: boolean
  run?: { runId: string; caseId: string; state: string }
  /** The binding draft's content hash now, to tell whether the report is stale. */
  contentHash?: string
}

/** The review screen's view of a binding: the binding, what the plugin needs, and what the domain offers. */
export function toBindingView(v: BindingView, f: BindingViewFacts): MwBindingView {
  const m = f.plugin?.manifest ?? f.project.plugins?.[v.pluginId]?.manifest
  const caps = providedBy(m?.provides.capabilities ?? {})
  const classes = new Map((f.plugin?.toolClasses ?? []).map((t) => [t.name, t]))
  const toolNames = [...new Set([...Object.keys(m?.tools ?? {}), ...Object.keys(v.binding.tools)])]
  const tools = toolNames.map((name) => {
    const def = m?.tools[name]
    const bound = v.binding.tools[name]
    // A draft's choice wins over what the installed plugin reports for the live binding.
    const effective = bound?.effect || bound?.off
      ? { effect: bound.effect, from: 'binding' as const, ...(bound.off ? { off: true } : {}) }
      : classes.get(name) ?? (def?.effect ? { effect: def.effect, from: 'declared' as const }
        : classFromAnnotations(def?.annotations) ? { effect: classFromAnnotations(def?.annotations), from: 'annotations' as const }
          : { from: 'none' as const })
    return toPluginTool(name, def, effective, bound, caps.get(name))
  })
  // Providers of each required capability: tools that bound (or this) plugin(s) say provide it.
  const providers = (cap: string): string[] => {
    const out = new Set<string>()
    for (const p of Object.values(f.project.plugins ?? {})) {
      const tool = p.manifest.provides.capabilities[cap]?.tool
      if (tool && (p.manifest.id === v.pluginId || f.project.bindings?.[p.manifest.id])) out.add(tool)
    }
    const current = v.binding.capabilities[cap]
    if (current) out.add(current)
    return [...out].sort()
  }
  return {
    pluginId: v.pluginId,
    pluginTitle: m?.title ?? v.pluginId,
    pluginVersion: v.binding.pluginVersion || m?.version || '',
    ...(v.draftId ? { draftId: v.draftId } : {}),
    editable: !!v.draftId && f.editable,
    binding: toBinding(v.binding, f.names),
    text: v.text,
    path: v.path,
    gaps: v.gaps.map(toBindingGap),
    ...(v.report ? { report: toBindingReport(v.report, f.project) } : {}),
    reportStale: !!v.report && !!f.contentHash && v.report.hash !== f.contentHash,
    tools,
    capabilities: Object.entries(m?.requires.capabilities ?? {}).map(([name, x]) => ({
      name, as: x.as, ...(x.optional ? { optional: true } : {}), providers: providers(name),
    })),
    entities: Object.values(m?.requires.entities ?? {}).map((e) => ({
      name: e.name,
      fields: Object.entries(e.fields).map(([name, x]) => ({ name, type: x.typeSource, ...(x.required ? { required: true } : {}) })),
    })),
    domainEntities: Object.values(f.project.entities).map((e) => ({
      name: e.entity, fields: Object.entries(e.fields).map(([name, x]) => ({ name, type: x.typeSource })),
    })),
    roles: Object.entries(m?.requires.roles ?? {}).map(([id, r]) => ({ id, title: r.title ?? humanize(id) })),
    records: Object.values(m?.records ?? {}).map((r) => ({ name: r.name, ...(r.title ? { title: r.title } : {}), key: r.key, fields: { ...r.fields } })),
    pluginPolicy: policyDocLines(m?.policy),
    bindingPolicy: policyDocLines(v.binding.policy),
    ...(f.run ? { run: { ...f.run } } : {}),
  }
}

export function toIdentityCandidate(c: IdentityCandidate, project: Pick<ProjectDefs, 'plugins'>, names: Map<string, string>, recordTitle?: string): MwIdentityCandidate {
  const decidedByName = c.decidedBy ? names.get(c.decidedBy) : undefined
  return {
    id: c.id, entity: c.entity, recordId: c.recordId, ...(recordTitle ? { recordTitle } : {}),
    plugin: c.plugin, pluginTitle: pluginTitle(project, c.plugin), source: c.source, externalId: c.externalId,
    score: c.score, reasons: [...c.reasons], external: plain(c.external), status: c.status,
    ...(c.decidedBy ? { decidedBy: c.decidedBy } : {}), ...(decidedByName ? { decidedByName } : {}),
    ...(c.decidedAt ? { decidedAt: c.decidedAt } : {}), createdAt: c.createdAt,
  }
}

export function toEntityLinkBadge(l: Pick<IdentityLink, 'plugin' | 'source' | 'method'>, project: Pick<ProjectDefs, 'plugins'>): MwEntityLinkBadge {
  return { plugin: l.plugin, pluginTitle: pluginTitle(project, l.plugin), source: l.source, method: l.method as MwMatchMethod }
}

export function toIdentityLink(
  l: IdentityLink & { values?: Record<string, unknown>; extra?: Record<string, unknown>; error?: string },
  project: Pick<ProjectDefs, 'plugins'>,
  names: Map<string, string>,
): MwIdentityLink {
  const linkedByName = l.linkedBy ? names.get(l.linkedBy) : undefined
  return {
    ...toEntityLinkBadge(l, project),
    id: l.id, externalId: l.externalId, score: l.score, reasons: [...l.reasons],
    ...(l.linkedBy ? { linkedBy: l.linkedBy } : {}), ...(linkedByName ? { linkedByName } : {}), at: l.at,
    ...(l.values ? { values: plain(l.values) } : {}), ...(l.extra ? { extra: plain(l.extra) } : {}),
    ...(l.error ? { error: l.error } : {}),
  }
}

/** A domain record's title: its name-like field, else the entity and a short id. */
export function recordTitle(entity: string, id: string, values: Record<string, unknown>): string {
  for (const key of ['name', 'legal_name', 'title', 'client_name', 'full_name', 'email']) {
    const v = values[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  const first = Object.values(values).find((v): v is string => typeof v === 'string' && !!v.trim())
  return first?.trim() ?? `${entity} ${id.slice(-6)}`
}

export function toEntityRecord(r: EntityRecordView, project: Pick<ProjectDefs, 'plugins'>, names: Map<string, string>): MwEntityRecord {
  const hidden = new Set(r.hidden)
  const provenance = { kind: 'system' as const, at: r.createdAt }
  const values: Record<string, MwCaseValue> = {}
  for (const [k, v] of Object.entries(r.values)) values[k] = hidden.has(k) ? { value: null, provenance, hidden: true } : { value: plain(v), provenance }
  for (const k of hidden) values[k] ??= { value: null, provenance, hidden: true }
  const visible = Object.fromEntries(Object.entries(r.values).filter(([k]) => !hidden.has(k)))
  return {
    entity: r.entity, id: r.id, title: recordTitle(r.entity, r.id, visible), values, createdAt: r.createdAt,
    // Linked values follow the same field access: hidden fields left out, and `extra` (unmapped,
    // possibly the same data) only when nothing on the record is hidden.
    links: r.links.map(({ values: linked, extra, ...l }) => toIdentityLink({
      ...l,
      ...(linked ? { values: Object.fromEntries(Object.entries(linked).filter(([k]) => !hidden.has(k))) } : {}),
      ...(extra && !hidden.size ? { extra } : {}),
    }, project, names)),
    readThrough: Object.fromEntries(Object.entries(r.readThrough).filter(([k]) => !hidden.has(k)).map(([k, x]) => [k, {
      plugin: x.plugin, pluginTitle: pluginTitle(project, x.plugin), value: plain(x.value),
    }])),
  }
}

/** Fields an identity card compares: the identity keys and fuzzy field first, then the rest both sides have. */
export function identityFields(binding: BindingDef | undefined, source: string, record: Record<string, unknown>, external: Record<string, unknown>): string[] {
  const rules = binding?.records[source]?.identity
  const first = [...(rules?.keys ?? []), ...(rules?.fuzzy ? [rules.fuzzy.field] : [])]
  const mapped = Object.keys(binding?.records[source]?.fields ?? {})
  const rest = [...mapped, ...Object.keys(external), ...Object.keys(record)]
  return [...new Set([...first, ...rest])].filter((f) => f in record || f in external)
}

/** An `identity` inbox item from a pending candidate and the domain record's visible values. */
export function toIdentityInboxItem(
  item: { id: string; candidate: IdentityCandidate; since: string },
  project: Pick<ProjectDefs, 'plugins' | 'bindings'>,
  record: Record<string, unknown>,
): Extract<MwInboxItem, { kind: 'identity' }> {
  const c = item.candidate
  const external = plain(c.external)
  const entityTitle = humanize(c.entity)
  return {
    kind: 'identity', id: item.id, candidateId: c.id,
    caseTitle: recordTitle(c.entity, c.recordId, record),
    stepTitle: `Same ${entityTitle.toLowerCase()}?`,
    entity: c.entity, recordId: c.recordId, plugin: c.plugin, pluginTitle: pluginTitle(project, c.plugin),
    source: c.source, externalId: c.externalId, score: c.score, reasons: [...c.reasons],
    record, external, fields: identityFields(project.bindings?.[c.plugin], c.source, record, external),
    since: item.since,
  }
}
