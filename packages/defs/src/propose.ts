/**
 * The binding proposer (Phase 4, 22 §4 `propose`): a first binding of a plugin into a domain,
 * made deterministically from names and types, no model. What it can't decide becomes a gap for
 * the binder agent or the person reviewing the binding.
 */
import { bindingPath, bindingToYaml } from './binding-file.ts';
import { pinnedPlugin } from './project-plugins.ts';
import type { BindingDef, BindingGap, BindingProposal, FieldMapping, InstalledPlugin, RecordBinding, Transform } from './plugin-types.ts';
import { sha256 } from './source.ts';
import type { EffectClass, FieldDef, ProjectDefs, ValueType } from './types.ts';
import { IDENTIFIER_PATTERNS } from './values.ts';
import { formatValueType, parseValueType, sameValueType } from './value-types.ts';

export interface ProposeBindingInput {
  plugin: InstalledPlugin;
  project: ProjectDefs;
  /** The current binding, for an upgrade or a second pass: kept as it is, only what's new is filled in. */
  previous?: BindingDef;
  /** Sample records by record source (from its list tool), to recognise untyped fields (emails, GSTINs). */
  sampleRecords?: Record<string, unknown[]>;
}

/** Names that mean the same field. `tax` matches only Identifier(GSTIN) fields. */
const SYNONYMS: { names: string[]; gstinOnly?: boolean }[] = [
  { names: ['name', 'full_name', 'fullname', 'company_name', 'display_name', 'client_name', 'customer_name'] },
  { names: ['email', 'email_address', 'mail', 'e_mail'] },
  { names: ['phone', 'mobile', 'phone_number', 'mobile_number', 'telephone'] },
  { names: ['tax_id', 'gstin', 'gst_number', 'gst_no', 'gst'], gstinOnly: true },
];

const norm = (s: string) => s.toLowerCase().replace(/[-\s]+/g, '_');
const flat = (s: string) => norm(s).replace(/_/g, '');
const isGstin = (t?: ValueType) => t?.kind === 'identifier' && t.scheme.toUpperCase() === 'GSTIN';

interface Named { name: string; type?: ValueType }

/**
 * The field of `targets` that `field` stands for: the same name, then a synonym, then the only
 * target with the same identifier scheme. `suggestions` (when there's no match) are targets of
 * the same type.
 */
export function matchField(field: Named, targets: Named[], taken: Set<string> = new Set()): { match?: string; suggestions: string[] } {
  const free = targets.filter((t) => !taken.has(t.name));
  const exact = free.find((t) => flat(t.name) === flat(field.name));
  if (exact) return { match: exact.name, suggestions: [] };
  for (const group of SYNONYMS) {
    if (!group.names.includes(norm(field.name))) continue;
    // A tax id is a GSTIN only when one side says so and the other doesn't say otherwise.
    const fits = (a?: ValueType, b?: ValueType) => !group.gstinOnly
      || ((isGstin(a) || isGstin(b)) && [a, b].every((t) => !t || isGstin(t) || (t.kind === 'scalar' && t.name === 'Text')));
    const hit = free.find((t) => group.names.includes(norm(t.name)) && fits(field.type, t.type));
    if (hit) return { match: hit.name, suggestions: [] };
  }
  if (field.type?.kind === 'identifier') {
    const scheme = field.type.scheme.toUpperCase();
    const same = free.filter((t) => t.type?.kind === 'identifier' && t.type.scheme.toUpperCase() === scheme);
    if (same.length === 1) return { match: same[0]!.name, suggestions: [] };
  }
  const suggestions = field.type ? free.filter((t) => t.type && sameValueType(t.type, field.type!)).map((t) => t.name) : [];
  return { suggestions };
}

/** A Text field whose sample values are all emails (or all GSTINs, PANs) is treated as one. */
function sniffType(type: ValueType | undefined, values: unknown[]): ValueType | undefined {
  if (type && !(type.kind === 'scalar' && type.name === 'Text')) return type;
  const texts = values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  if (!texts.length) return type;
  if (texts.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return { kind: 'scalar', name: 'Email' };
  for (const [scheme, pattern] of Object.entries(IDENTIFIER_PATTERNS)) {
    if (texts.every((v) => pattern.test(v.toUpperCase()))) return { kind: 'identifier', scheme };
  }
  return type;
}

/** Sensible transforms for a domain field's type: trim (and squash) text, lower-case emails, upper-case identifiers. */
function transformsFor(type: ValueType): Transform[] | undefined {
  if (type.kind === 'identifier') return ['trim', 'upper'];
  if (type.kind === 'scalar') {
    if (type.name === 'Email') return ['trim', 'lower'];
    if (type.name === 'Text' || type.name === 'PersonName') return ['trim', 'squash'];
    if (type.name === 'Phone') return ['trim'];
  }
  return undefined;
}

const entityFieldsOf = (fields: Record<string, FieldDef>): Named[] => Object.entries(fields).map(([name, f]) => ({ name, type: f.type }));

/** The domain type a plugin type stands for under the entity renames made so far. */
function inDomainTerms(type: ValueType, entities: BindingDef['entities']): ValueType {
  if (type.kind === 'list') return { kind: 'list', of: inDomainTerms(type.of, entities) };
  if (type.kind === 'ref') return { kind: 'ref', entity: entities[type.entity]?.entity ?? type.entity };
  if (type.kind === 'named' && entities[type.name]) return { kind: 'named', name: entities[type.name]!.entity };
  return type;
}

/** Picks the entity a set of fields belongs to: the same name, else the most fields matched (a tie decides nothing). */
function pickEntity(name: string, fields: Named[], project: ProjectDefs): { entity?: string; suggestions: string[] } {
  const names = Object.keys(project.entities);
  const byName = names.find((e) => flat(e) === flat(name) || flat(e) === flat(name).replace(/s$/, ''));
  if (byName) return { entity: byName, suggestions: [] };
  const scored = names.map((e) => {
    const targets = entityFieldsOf(project.entities[e]!.fields);
    const taken = new Set<string>();
    let score = 0;
    for (const f of fields) {
      const m = matchField(f, targets, taken).match;
      if (m) { taken.add(m); score++; }
    }
    return { e, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || (a.e < b.e ? -1 : 1));
  if (scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score)) return { entity: scored[0]!.e, suggestions: [] };
  return { suggestions: scored.map((s) => s.e) };
}

/**
 * Proposes a binding (22 §4): tool classes from the manifest, else MCP annotations
 * (readOnlyHint → read, destructiveHint → irreversible); entities by name, then by field overlap;
 * fields by name, synonym, then identifier scheme; roles by id; each capability by its only bound
 * provider; record sources onto entities with trimming transforms, identity keys from identifier
 * and email fields and fuzzy matching on the name. With `previous`, everything it decided stays.
 */
export function proposeBinding(input: ProposeBindingInput): BindingProposal {
  const { plugin, project, previous, sampleRecords = {} } = input;
  const m = plugin.manifest;
  const gaps: BindingGap[] = [];
  const classes: BindingProposal['classes'] = {};
  const binding: BindingDef = {
    plugin: m.id,
    pluginVersion: m.version,
    pluginHash: plugin.hash,
    version: previous?.version ?? 0,
    tools: structuredClone(previous?.tools ?? {}),
    capabilities: { ...previous?.capabilities },
    entities: structuredClone(previous?.entities ?? {}),
    roles: { ...previous?.roles },
    records: structuredClone(previous?.records ?? {}),
    ...(previous?.policy ? { policy: structuredClone(previous.policy) } : {}),
    file: previous?.file ?? bindingPath(m.id),
    hash: '',
  };

  // ---- tools
  for (const tool of Object.values(m.tools)) {
    const b = binding.tools[tool.name];
    if (b?.effect || b?.off) {
      classes[tool.name] = { ...(b.effect ? { effect: b.effect } : {}), from: 'binding' };
      continue;
    }
    let effect: EffectClass | undefined;
    let reason: string | undefined;
    if (tool.effect) effect = tool.effect;
    else if (tool.annotations?.readOnlyHint) { effect = 'read'; reason = 'the server marks it read-only (readOnlyHint)'; }
    else if (tool.annotations?.destructiveHint) { effect = 'irreversible'; reason = 'the server marks it destructive (destructiveHint)'; }
    if (effect) {
      binding.tools[tool.name] = { ...b, effect, ...(reason ? { reason } : {}) };
      classes[tool.name] = { effect, from: tool.effect ? 'declared' : 'annotations' };
    } else {
      classes[tool.name] = { from: 'none' };
      gaps.push({ kind: 'tool-unclassified', subject: tool.name, message: `${tool.name} has no effect class: until it is classified it counts as irreversible` });
    }
  }

  // ---- capabilities: the only bound provider (other plugins' frozen bindings, or this plugin)
  for (const [cap, spec] of Object.entries(m.requires.capabilities)) {
    if (binding.capabilities[cap]) continue;
    const providers: string[] = [];
    for (const other of Object.values(project.bindings ?? {})) {
      if (other.plugin === m.id) continue;
      const p = pinnedPlugin(project, other)?.manifest.provides.capabilities[cap];
      if (p && !other.tools[p.tool]?.off) providers.push(p.tool);
    }
    const own = m.provides.capabilities[cap];
    if (own) providers.push(own.tool);
    const unique = [...new Set(providers)].sort();
    if (unique.length === 1) binding.capabilities[cap] = unique[0]!;
    else if (unique.length > 1) gaps.push({ kind: 'capability-missing', subject: cap, message: `several bound plugins provide ${cap}; pick the one ${m.title}'s \`${spec.as}\` should use`, suggestions: unique });
    else if (!spec.optional) gaps.push({ kind: 'capability-missing', subject: cap, message: `${m.title} needs ${cap} (as \`${spec.as}\`), and no bound plugin provides it: bind one that does first` });
  }

  // ---- entities and their fields
  for (const [name, req] of Object.entries(m.requires.entities)) {
    const pluginFields: Named[] = Object.entries(req.fields).map(([f, d]) => ({ name: f, type: parseValueType(d.typeSource) }));
    if (!binding.entities[name]) {
      const pick = pickEntity(name, pluginFields, project);
      if (!pick.entity) {
        gaps.push({ kind: 'entity-unmapped', subject: name, message: `which of the domain's entities is ${m.title}'s ${name}?`, ...(pick.suggestions.length ? { suggestions: pick.suggestions } : {}) });
        continue;
      }
      binding.entities[name] = { entity: pick.entity, fields: {} };
    }
    const bound = binding.entities[name]!;
    const domain = project.entities[bound.entity];
    if (!domain) continue; // the check says so
    const targets = entityFieldsOf(domain.fields);
    const taken = new Set(Object.values(bound.fields));
    for (const f of pluginFields) {
      if (bound.fields[f.name] === undefined) {
        const r = matchField(f, targets, taken);
        if (!r.match) {
          gaps.push({ kind: 'field-unmapped', subject: `${name}.${f.name}`, message: `${bound.entity} has no field for ${name}.${f.name}${req.fields[f.name]?.required ? ' (the plugin needs it)' : ''}: map one, add one, or leave it out`, ...(r.suggestions.length ? { suggestions: r.suggestions } : {}) });
          continue;
        }
        bound.fields[f.name] = r.match;
        taken.add(r.match);
      }
      const target = domain.fields[bound.fields[f.name]!];
      if (f.type && target && !sameValueType(inDomainTerms(f.type, binding.entities), target.type)) {
        gaps.push({ kind: 'type-mismatch', subject: `${name}.${f.name}`, message: `${name}.${f.name} is ${formatValueType(f.type)} but ${bound.entity}.${bound.fields[f.name]} is ${target.typeSource}` });
      }
    }
  }

  // ---- roles
  const domainRoles = Object.keys(project.roles ?? {});
  for (const role of Object.keys(m.requires.roles)) {
    if (binding.roles[role] !== undefined) continue;
    if (!domainRoles.length || domainRoles.includes(role)) binding.roles[role] = role;
    else gaps.push({ kind: 'role-unmapped', subject: role, message: `which of the domain's roles does ${m.title}'s ${role} (${m.requires.roles[role]!.title}) stand for?`, suggestions: domainRoles });
  }

  // ---- record sources
  for (const source of Object.values(m.records)) {
    if (binding.records[source.name]) continue;
    const samples = sampleRecords[source.name] ?? [];
    const sourceFields: Named[] = Object.entries(source.fields).map(([f, t]) => ({
      name: f,
      type: sniffType(parseValueType(t), samples.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>)[f] : undefined))),
    }));
    const pick = pickEntity(source.name, sourceFields, project);
    if (!pick.entity || !project.entities[pick.entity]) {
      gaps.push({ kind: 'record-unmapped', subject: source.name, message: `which of the domain's entities are ${source.title ?? source.name} records?`, ...(pick.suggestions.length ? { suggestions: pick.suggestions } : {}) });
      continue;
    }
    const entity = project.entities[pick.entity]!;
    const fields: Record<string, FieldMapping> = {};
    const taken = new Set<string>([source.key]);
    for (const [name, def] of Object.entries(entity.fields)) {
      const r = matchField({ name, type: def.type }, sourceFields, taken);
      if (!r.match) continue;
      taken.add(r.match);
      const transform = transformsFor(def.type);
      fields[name] = { from: r.match, ...(transform ? { transform } : {}) };
    }
    const mappedOfType = (test: (t: ValueType) => boolean) => Object.keys(fields).filter((f) => test(entity.fields[f]!.type));
    const keys = [
      ...mappedOfType((t) => t.kind === 'identifier'),
      ...mappedOfType((t) => t.kind === 'scalar' && t.name === 'Email'),
    ];
    const nameField = fields.name ? 'name' : mappedOfType((t) => t.kind === 'scalar' && t.name === 'PersonName')[0];
    const record: RecordBinding = {
      entity: pick.entity,
      fields,
      identity: { keys, ...(nameField ? { fuzzy: { field: nameField, auto: 0.95, review: 0.75 } } : {}), createMissing: false },
    };
    binding.records[source.name] = record;
    if (!Object.keys(fields).length) gaps.push({ kind: 'record-unmapped', subject: source.name, message: `no field of ${source.name} matched a field of ${pick.entity}: map them by hand` });
  }

  binding.hash = sha256(bindingToYaml(binding));
  return { binding, gaps, classes };
}
