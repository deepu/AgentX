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
  CaseSummary, CaseView, EntityRow, Person, Role, StepRunSummary, TransitionRecord,
} from '@memwise/runtime'
import type {
  MwCase, MwCaseSummary, MwCaseValue, MwDiagnostic, MwEffectClass, MwEntityRow, MwEntityType, MwField, MwJournalEntry,
  MwPerformer, MwPerson, MwPlaybook, MwPolicyRule, MwRole, MwState, MwStep, MwStepRecord, MwStepRunSummary, MwToolRef,
  MwTransition, MwDraftStage, MwDraftSummary, MwDraftEdit, MwFileChange, MwStructuralDiff, MwImpact, MwDraftReport, MwVersion,
  MwTreatment,
} from '@memwise/shared/protocol'
import { isConversationStep } from './conversation'

type JsonSchemaFn = (type: FieldDef['type'], recordTypes?: Record<string, { fields: Record<string, FieldDef> }>) => Record<string, unknown>

/** Tool facts the screens show (name, description, effect class, plugin). */
export interface ToolInfo { name: string; description?: string; effect?: EffectClass; plugin?: string }

export interface DtoContext {
  project: ProjectDefs
  diagnostics: Diagnostic[]
  tools: Map<string, ToolInfo>
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
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : id
}

export function stateTitle(wf: WorkflowDef | undefined, state: string): string {
  if (state === 'end') return 'Finished'
  if (state === 'needs_person') return 'Needs a person'
  return wf?.steps[state]?.title ?? humanize(state)
}

/** A readable case title: the client's name, the legal name, the first text value, else a short reference. */
export function caseTitle(values: Record<string, unknown>, caseId: string, caseType?: CaseTypeDef): string {
  const plain = (v: unknown) => (v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v)
  for (const key of ['client_name', 'legal_name', 'title']) {
    const v = plain(values[key])
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const [key, raw] of Object.entries(values)) {
    const v = plain(raw)
    const type = caseType?.fields[key]?.type
    const texty = !type || (type.kind === 'scalar' && (type.name === 'Text' || type.name === 'PersonName'))
    if (texty && typeof v === 'string' && v.trim()) return v.trim()
  }
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
  }
}

// ---------------------------------------------------------------- cases

export function toCaseValue(v: { value: unknown; provenance: MwCaseValue['provenance']; hidden?: boolean; tainted?: boolean } | undefined): MwCaseValue | undefined {
  if (!v) return undefined
  return {
    value: v.hidden ? null : v.value,
    provenance: v.provenance,
    ...(v.tainted ? { tainted: true } : {}),
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

export function toCaseSummary(project: ProjectDefs, s: CaseSummary): MwCaseSummary {
  const wf = project.workflows[s.workflowId]
  const wait = waitingOn(wf, s.state, s.status)
  return {
    caseId: s.caseId,
    runId: s.runId,
    workflowId: s.workflowId,
    workflowVersion: s.workflowVersion,
    title: caseTitle(s.values, s.caseId, wf?.caseType),
    state: s.state,
    stateTitle: stateTitle(wf, s.state),
    status: s.status,
    ...(s.stopReason ? { stopReason: s.stopReason } : {}),
    ...(wait ? { waitingOn: wait } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
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

export function toCase(ctx: DtoContext, view: CaseView): MwCase {
  const wf = ctx.project.workflows[view.summary.workflowId]
  return {
    ...toCaseSummary(ctx.project, view.summary),
    title: caseTitle(Object.fromEntries(Object.entries(view.values).map(([k, v]) => [k, v.hidden ? undefined : v.value])), view.summary.caseId, wf?.caseType),
    fields: wf ? caseFields(ctx, wf.caseType) : [],
    values: toCaseValues(view.values),
    timeline: view.stepRuns.map((r) => toStepRunSummary(ctx.project, view.summary.workflowId, r)),
    transitions: view.transitions.map(toTransition),
    path: [...view.path],
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

export function toEntityType(ctx: DtoContext, e: EntityTypeDef): MwEntityType {
  return {
    name: e.entity,
    fields: Object.entries(e.fields).map(([name, def]) => toField(ctx, name, def)),
    ...(e.lifecycle ? { lifecycle: [...e.lifecycle] } : {}),
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

export function toVersion(v: WorkflowVersion, names: Map<string, string>): MwVersion {
  const publishedByName = v.publishedBy ? names.get(v.publishedBy) : undefined
  return {
    version: v.version, hash: v.hash, publishedAt: v.publishedAt,
    ...(v.publishedBy ? { publishedBy: v.publishedBy } : {}), ...(publishedByName ? { publishedByName } : {}),
    source: v.source, ...(v.draftId ? { draftId: v.draftId } : {}), ...(v.runId ? { runId: v.runId } : {}),
    openCases: v.openCases, live: v.live,
  }
}
