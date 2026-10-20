/**
 * The binding review's edit model (22 §3, §10): pure edits over a binding (tool classes,
 * capabilities, entity and field renames, roles, record mappings, identity rules, the domain's
 * policy tightening), and writing them back into the binding file's YAML.
 *
 * Writing back replaces only the top-level sections that were edited (`tools:`, `records:`...),
 * each rewritten from the model in the file's snake_case format; every other line (plugin,
 * plugin_version, version, frozen, dry_run, comments between sections) stays exactly as written.
 * Comments inside an edited section are not kept. The result is saved through
 * `memwise:drafts:write`, like any other draft file.
 */

import type {
  MwBinding, MwEffectClass, MwFieldMapping, MwIdentityRules, MwPolicyDoc, MwRecordBinding, MwTransform, MwTreatment,
} from '@memwise/shared/protocol'
import { yamlScalar } from '../draft/step-file'

export type BindingSection = 'tools' | 'capabilities' | 'entities' | 'roles' | 'records' | 'policy'

/** In the order the file reads (and the binding format lists them). */
export const BINDING_SECTIONS: readonly BindingSection[] = ['tools', 'capabilities', 'entities', 'roles', 'records', 'policy']

/** Strictest last: a binding may tighten a declared class, never loosen it (22 §3). */
export const EFFECT_ORDER: readonly MwEffectClass[] = ['read', 'draft', 'write', 'outbound', 'irreversible']
export const TREATMENT_ORDER: readonly MwTreatment[] = ['allow', 'preview', 'approve', 'deny']
export const SIMPLE_TRANSFORMS = ['trim', 'lower', 'upper', 'digits', 'squash'] as const

/** What a person picks for a tool: a class, off (not bound), or nothing (the declared class). */
export type ToolChoice = MwEffectClass | 'off' | 'unset'

// ---------------------------------------------------------------- edits (each returns a new binding)

export function toolChoice(b: MwBinding, tool: string): ToolChoice {
  const t = b.tools[tool]
  if (t?.off) return 'off'
  return t?.effect ?? 'unset'
}

export function setToolClass(b: MwBinding, tool: string, choice: ToolChoice): MwBinding {
  const tools = { ...b.tools }
  if (choice === 'unset') delete tools[tool]
  else if (choice === 'off') tools[tool] = { off: true }
  // A person's choice replaces the binder's reason, which was about its own choice.
  else tools[tool] = { effect: choice }
  return { ...b, tools }
}

/** Classes a person may pick for a tool: none looser than the class it declares. */
export function allowedClasses(declared?: MwEffectClass): MwEffectClass[] {
  const from = declared ? EFFECT_ORDER.indexOf(declared) : 0
  return EFFECT_ORDER.slice(Math.max(0, from))
}

/** True when `chosen` is looser than `declared` (the checks refuse it). */
export function loosens(declared: MwEffectClass | undefined, chosen: MwEffectClass | undefined): boolean {
  if (!declared || !chosen) return false
  return EFFECT_ORDER.indexOf(chosen) < EFFECT_ORDER.indexOf(declared)
}

const without = <T>(map: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...map }
  delete next[key]
  return next
}

export function setCapability(b: MwBinding, capability: string, tool: string | undefined): MwBinding {
  return { ...b, capabilities: tool ? { ...b.capabilities, [capability]: tool } : without(b.capabilities, capability) }
}

export function setRole(b: MwBinding, pluginRole: string, domainRole: string | undefined): MwBinding {
  return { ...b, roles: domainRole ? { ...b.roles, [pluginRole]: domainRole } : without(b.roles, pluginRole) }
}

/** Map a plugin entity onto a domain entity; changing the entity keeps the field renames that still apply. */
export function setEntity(b: MwBinding, pluginEntity: string, domainEntity: string | undefined): MwBinding {
  if (!domainEntity) return { ...b, entities: without(b.entities, pluginEntity) }
  const cur = b.entities[pluginEntity]
  return { ...b, entities: { ...b.entities, [pluginEntity]: { entity: domainEntity, fields: { ...(cur?.fields ?? {}) } } } }
}

export function setFieldRename(b: MwBinding, pluginEntity: string, pluginField: string, domainField: string | undefined): MwBinding {
  const cur = b.entities[pluginEntity]
  if (!cur) return b
  const fields = domainField ? { ...cur.fields, [pluginField]: domainField } : without(cur.fields, pluginField)
  return { ...b, entities: { ...b.entities, [pluginEntity]: { ...cur, fields } } }
}

function emptyRecord(entity: string): MwRecordBinding {
  return { entity, fields: {}, identity: { keys: [] } }
}

export function setRecordEntity(b: MwBinding, source: string, entity: string | undefined): MwBinding {
  if (!entity) return { ...b, records: without(b.records, source) }
  const cur = b.records[source]
  // Another entity has other fields: start the mapping over, keep nothing that no longer fits.
  const next = cur && cur.entity === entity ? cur : emptyRecord(entity)
  return { ...b, records: { ...b.records, [source]: next } }
}

/** Set (or, with undefined, remove) the mapping of one domain field of a record source. */
export function setRecordField(b: MwBinding, source: string, domainField: string, mapping: MwFieldMapping | undefined): MwBinding {
  const cur = b.records[source]
  if (!cur) return b
  const empty = !mapping || (!mapping.from && !(mapping.transform ?? []).some(t => typeof t === 'object' && 'template' in t))
  const fields = empty ? without(cur.fields, domainField) : { ...cur.fields, [domainField]: compactMapping(mapping!) }
  return { ...b, records: { ...b.records, [source]: { ...cur, fields } } }
}

function compactMapping(m: MwFieldMapping): MwFieldMapping {
  return {
    ...(m.from ? { from: m.from } : {}),
    ...(m.transform?.length ? { transform: m.transform } : {}),
    ...(m.direction && m.direction !== 'read' ? { direction: m.direction } : {}),
  }
}

export function setIdentity(b: MwBinding, source: string, rules: MwIdentityRules): MwBinding {
  const cur = b.records[source]
  if (!cur) return b
  return { ...b, records: { ...b.records, [source]: { ...cur, identity: rules } } }
}

/** The domain's treatment of an effect class for this plugin's work (undefined: the plugin's default stands). */
export function setPolicyEffect(b: MwBinding, cls: MwEffectClass, treatment: MwTreatment | undefined): MwBinding {
  const effects = { ...(b.policy?.effects ?? {}) }
  if (treatment) effects[cls] = treatment
  else delete effects[cls]
  const policy: MwPolicyDoc = { ...(b.policy ?? {}), effects }
  if (!Object.keys(effects).length) delete policy.effects
  return { ...b, ...(Object.keys(policy).length ? { policy } : { policy: undefined }) }
}

// ---------------------------------------------------------------- transforms in words

/** `trim`, `default: n/a`, `money: INR`, `template: {first} {last}`, `map (3)`. */
export function transformLabel(t: MwTransform): string {
  if (typeof t === 'string') return t
  if ('default' in t) return `default: ${typeof t.default === 'string' ? t.default : JSON.stringify(t.default)}`
  if ('money' in t) return `money: ${t.money}`
  if ('template' in t) return `template: ${t.template}`
  return `map (${Object.keys(t.map).length})`
}

/**
 * The transforms typed as words (`trim, upper`): the simple ones from the text, in its order,
 * followed by the structured ones (default, map, money, template) the list had, which the text
 * field does not edit. Unknown words are returned in `unknown`.
 */
export function parseTransformText(text: string, existing: MwTransform[] = []): { transform: MwTransform[]; unknown: string[] } {
  const words = text.split(/[\s,]+/).map(w => w.trim().toLowerCase()).filter(Boolean)
  const known = new Set<string>(SIMPLE_TRANSFORMS)
  const simple = words.filter(w => known.has(w)) as MwTransform[]
  const unknown = words.filter(w => !known.has(w))
  const structured = existing.filter(t => typeof t !== 'string')
  return { transform: [...new Set(simple)].concat(structured), unknown }
}

export function transformText(transform: MwTransform[] | undefined): string {
  return (transform ?? []).filter((t): t is Extract<MwTransform, string> => typeof t === 'string').join(', ')
}

// ---------------------------------------------------------------- dirty tracking

/** Which sections differ between two bindings (what saving has to rewrite). */
export function changedSections(before: MwBinding, after: MwBinding): BindingSection[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
  return BINDING_SECTIONS.filter(s => !same(before[s], after[s]))
}

/** Key order and empty maps don't count as changes. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return entries.length ? Object.fromEntries(entries.map(([k, x]) => [k, normalize(x)])) : undefined
  }
  return v
}

// ---------------------------------------------------------------- YAML

const FLOW_MAX = 96

/** A scalar inside a flow collection (`{ a: b }`, `[a, b]`): commas and brackets need quotes there too. */
function flowScalar(value: string): string {
  const s = yamlScalar(value)
  return s.startsWith('"') || !/[,[\]{}]/.test(s) ? s : JSON.stringify(value)
}

function scalar(v: unknown, flow: boolean): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return flow ? flowScalar(v) : yamlScalar(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Inline form (`{ effect: read }`, `[trim, upper]`), always valid YAML. */
function flow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`
  if (isMap(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    return entries.length ? `{ ${entries.map(([k, x]) => `${flowScalar(k)}: ${flow(x)}`).join(', ')} }` : '{}'
  }
  return scalar(v, true)
}

/** `key: value` lines at `indent`: short maps and lists inline, longer ones as blocks. */
function emit(key: string, v: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const k = yamlScalar(key)
  if (!isMap(v) && !Array.isArray(v)) return [`${pad}${k}: ${scalar(v, false)}`]
  const inline = `${pad}${k}: ${flow(v)}`
  const nested = isMap(v) && Object.values(v).some(x => isMap(x) && Object.values(x).some(y => isMap(y) || (Array.isArray(y) && y.some(isMap))))
  // Sections themselves are always blocks, one entry per line; an empty one reads `tools: {}`.
  const section = indent === 0 && isMap(v) && Object.keys(v).length > 0
  if (inline.length <= FLOW_MAX && !nested && !section) return [inline]
  if (Array.isArray(v)) return [`${pad}${k}:`, ...v.map(x => `${pad}  - ${flow(x)}`)]
  const entries = Object.entries(v).filter(([, x]) => x !== undefined)
  if (!entries.length) return [`${pad}${k}: {}`]
  return [`${pad}${k}:`, ...entries.flatMap(([ck, cv]) => emit(ck, cv, indent + 2))]
}

/** `30/min`-style text for a rate the policy format reads back. */
function rateText(r: { count: number; perMs: number }): string {
  const units: [number, string][] = [[604_800_000, 'w'], [86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'm'], [1000, 's']]
  for (const [ms, u] of units) if (r.perMs % ms === 0) return `${r.count}/${r.perMs / ms === 1 ? '' : r.perMs / ms}${u}`
  return `${r.count}/${r.perMs}ms`
}

/** A section as it is written in `domain/bindings/<slug>.yaml` (snake_case where the format says so). */
export function sectionData(section: BindingSection, b: MwBinding): unknown {
  switch (section) {
    case 'tools':
      return Object.fromEntries(Object.entries(b.tools).map(([name, t]) => [name, {
        ...(t.effect ? { effect: t.effect } : {}), ...(t.off ? { off: true } : {}), ...(t.reason ? { reason: t.reason } : {}),
      }]))
    case 'capabilities':
      return { ...b.capabilities }
    case 'entities':
      return Object.fromEntries(Object.entries(b.entities).map(([name, e]) => [name, {
        entity: e.entity, ...(Object.keys(e.fields).length ? { fields: { ...e.fields } } : {}),
      }]))
    case 'roles':
      return { ...b.roles }
    case 'records':
      return Object.fromEntries(Object.entries(b.records).map(([name, r]) => [name, {
        entity: r.entity,
        fields: Object.fromEntries(Object.entries(r.fields).map(([field, m]) => [field,
          // A plain source field reads best as `name: company_name`.
          m.from && !m.transform?.length && (!m.direction || m.direction === 'read') ? m.from : compactMapping(m),
        ])),
        identity: {
          keys: [...r.identity.keys],
          ...(r.identity.fuzzy ? { fuzzy: { field: r.identity.fuzzy.field, auto: r.identity.fuzzy.auto, review: r.identity.fuzzy.review } } : {}),
          ...(r.identity.createMissing !== undefined ? { create_missing: r.identity.createMissing } : {}),
        },
      }]))
    case 'policy':
      return b.policy ? policyData(b.policy) : undefined
  }
}

function policyData(p: MwPolicyDoc): Record<string, unknown> | undefined {
  const tools = p.tools ? {
    ...(p.tools.allow ? { allow: [...p.tools.allow] } : {}),
    ...(p.tools.deny ? { deny: [...p.tools.deny] } : {}),
    ...(p.tools.require ? { require: [...p.tools.require] } : {}),
    ...(p.tools.rules ? {
      rules: Object.fromEntries(Object.entries(p.tools.rules).map(([tool, r]) => [tool, {
        ...(r.treatment ? { treatment: r.treatment } : {}), ...(r.rateLimit ? { rateLimit: rateText(r.rateLimit) } : {}),
      }])),
    } : {}),
  } : undefined
  const budgets = p.budgets ? {
    ...(p.budgets.tokens !== undefined ? { tokens: p.budgets.tokens } : {}),
    ...(p.budgets.timeMs !== undefined ? { time: `${p.budgets.timeMs}ms` } : {}),
    ...(p.budgets.modelCalls !== undefined ? { modelCalls: p.budgets.modelCalls } : {}),
    ...(p.budgets.money ? { money: { ...p.budgets.money } } : {}),
  } : undefined
  const out: Record<string, unknown> = {
    ...(p.effects && Object.keys(p.effects).length ? { effects: { ...p.effects } } : {}),
    ...(tools && Object.keys(tools).length ? { tools } : {}),
    ...(budgets && Object.keys(budgets).length ? { budgets } : {}),
    ...(p.modelRoles ? { modelRoles: [...p.modelRoles] } : {}),
    ...(p.taint && Object.keys(p.taint).length ? { taint: { ...p.taint } } : {}),
    ...(p.approvals?.by ? { approvals: { by: [...p.approvals.by] } } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

/** The lines of a section (`tools:` and its entries); none for an absent policy. */
export function sectionLines(section: BindingSection, b: MwBinding): string[] {
  const data = sectionData(section, b)
  if (data === undefined) return []
  return emit(section, data, 0)
}

/** The top-level block of `key`: its line, and the indented (or blank) lines after it. */
function topBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const re = new RegExp(`^${key}\\s*:`)
  const start = lines.findIndex(l => re.test(l))
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length && (lines[end]!.trim() === '' || /^[\s]/.test(lines[end]!) || /^-(\s|$)/.test(lines[end]!))) end++
  while (end > start + 1 && lines[end - 1]!.trim() === '') end--
  return { start, end }
}

/**
 * Writes the edited sections of `binding` into the binding file's text. Sections not named are
 * left exactly as they are; a missing section is added before `dry_run:` (else at the end); an
 * emptied policy is removed.
 */
export function applyBindingSections(text: string, binding: MwBinding, sections: readonly BindingSection[]): string {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n'
  let lines = text.split(/\r?\n/)
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === ''
  if (trailingNewline) lines = lines.slice(0, -1)
  for (const section of BINDING_SECTIONS) {
    if (!sections.includes(section)) continue
    const replacement = sectionLines(section, binding)
    const block = topBlock(lines, section)
    if (block) {
      lines = [...lines.slice(0, block.start), ...replacement, ...lines.slice(block.end)]
      continue
    }
    if (!replacement.length) continue
    const anchor = topBlock(lines, 'dry_run')
    if (anchor) {
      // Above the comment lines that introduce `dry_run:`
      let at = anchor.start
      while (at > 0 && /^#/.test(lines[at - 1]!)) at--
      lines = [...lines.slice(0, at), ...replacement, ...lines.slice(at)]
    }
    else {
      let at = lines.length
      while (at > 0 && lines[at - 1]!.trim() === '') at--
      lines = [...lines.slice(0, at), ...replacement, ...lines.slice(at)]
    }
  }
  return lines.join(nl) + (trailingNewline || !text ? nl : '')
}
