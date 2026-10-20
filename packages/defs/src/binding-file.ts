/**
 * `domain/bindings/<slug>.yaml` (Phase 4, 22 §3): reading a binding into a BindingDef and writing
 * one back. YAML keys are snake_case (`plugin_version`, `plugin_hash`, `create_missing`, `dry_run`).
 */
import { stringify as stringifyYaml } from 'yaml';
import { bindingFormat, TRANSFORM_NAMES } from './formats.ts';
import { policyToRaw, toPolicyDoc } from './parse-policy.ts';
import { BINDINGS_DIR, type BindingDef, type FieldMapping, type IdentityRules, type MappingDirection, type RecordBinding, type Transform } from './plugin-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, sha256, type ParseResult } from './source.ts';
import { EFFECT_CLASSES, type EffectClass } from './types.ts';

/** `memwise/client-intake` → `memwise__client-intake`: the plugin's folder and binding file name. */
export const pluginSlug = (id: string): string => id.replace(/\//g, '__');
/** The plugin id a slug stands for (the first `__` is the `/`). */
export const pluginIdOfSlug = (slug: string): string => slug.replace('__', '/');
/** `domain/bindings/<slug>.yaml`, relative to the project root. */
export const bindingPath = (id: string): string => `${BINDINGS_DIR}/${pluginSlug(id)}.yaml`;

const DIRECTIONS: MappingDirection[] = ['read', 'write', 'both'];

/** One transform as written, or undefined when it is none of the fixed set. */
export function toTransform(raw: unknown): Transform | undefined {
  if (typeof raw === 'string') return (TRANSFORM_NAMES as readonly string[]).includes(raw) ? raw as Transform : undefined;
  if (!isRecord(raw) || Object.keys(raw).length !== 1) return undefined;
  if ('default' in raw) return { default: raw.default };
  if (isRecord(raw.map)) return { map: raw.map };
  if (typeof raw.money === 'string' && /^[A-Z]{3}$/.test(raw.money)) return { money: raw.money };
  if (typeof raw.template === 'string') return { template: raw.template };
  return undefined;
}

function fieldMapping(raw: unknown): FieldMapping | undefined {
  if (typeof raw === 'string') return { from: raw };
  if (!isRecord(raw)) return undefined;
  const transform = Array.isArray(raw.transform) ? raw.transform.map(toTransform).filter((t): t is Transform => t !== undefined) : undefined;
  return compact({
    from: asString(raw.from),
    transform,
    direction: DIRECTIONS.includes(raw.direction as MappingDirection) ? raw.direction as MappingDirection : undefined,
  });
}

function identityRules(raw: unknown): IdentityRules {
  const r = asRecord(raw);
  const f = asRecord(r.fuzzy);
  const fuzzy = typeof f.field === 'string' && typeof f.auto === 'number' && typeof f.review === 'number'
    ? { field: f.field, auto: f.auto, review: f.review }
    : undefined;
  return compact({ keys: asStrings(r.keys), fuzzy, createMissing: typeof r.create_missing === 'boolean' ? r.create_missing : undefined });
}

const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(asRecord(v)).filter(([, x]) => typeof x === 'string')) as Record<string, string>;

/** Parses a binding file; `file` is relative to the project root. `hash` is sha256 of the text. */
export function parseBindingFile(text: string, file: string): ParseResult<BindingDef> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected a binding: plugin, plugin_version, tools, entities, roles');
    return { diagnostics: report.diagnostics };
  }
  report.validate(bindingFormat, src.data);
  const data = src.data;

  const tools: BindingDef['tools'] = {};
  for (const [name, spec] of Object.entries(asRecord(data.tools))) {
    const t = asRecord(spec);
    tools[name] = compact({
      effect: (EFFECT_CLASSES as readonly unknown[]).includes(t.effect) ? t.effect as EffectClass : undefined,
      off: typeof t.off === 'boolean' ? t.off : undefined,
      reason: asString(t.reason),
    });
  }
  const entities: BindingDef['entities'] = {};
  for (const [name, spec] of Object.entries(asRecord(data.entities))) {
    const e = asRecord(spec);
    if (typeof e.entity === 'string') entities[name] = { entity: e.entity, fields: strings(e.fields) };
  }
  const records: Record<string, RecordBinding> = {};
  for (const [name, spec] of Object.entries(asRecord(data.records))) {
    const r = asRecord(spec);
    if (typeof r.entity !== 'string') continue;
    const fields: Record<string, FieldMapping> = {};
    for (const [field, m] of Object.entries(asRecord(r.fields))) {
      // Say which transform is wrong: the format check only says the mapping doesn't fit.
      const raw = isRecord(m) && Array.isArray(m.transform) ? m.transform : [];
      raw.forEach((t, i) => {
        if (!toTransform(t)) report.error('invalid-transform', `\`${JSON.stringify(t)}\` is not a transform: use trim, lower, upper, digits, squash, { default: v }, { map: { a: b } }, { money: INR } or { template: "{first} {last}" }`, ['records', name, 'fields', field, 'transform', i]);
      });
      const mapping = fieldMapping(m);
      if (mapping) fields[field] = mapping;
    }
    records[name] = { entity: r.entity, fields, identity: identityRules(r.identity) };
  }
  const frozen = isRecord(data.frozen) && typeof data.frozen.by === 'string' && typeof data.frozen.at === 'string'
    ? compact({ by: data.frozen.by, at: data.frozen.at, runId: asString(data.frozen.run) })
    : undefined;
  const d = asRecord(data.dry_run);
  const dryRun = typeof d.at === 'string' && typeof d.hash === 'string' && typeof d.passed === 'boolean' && typeof d.summary === 'string'
    ? { at: d.at, hash: d.hash, passed: d.passed, summary: d.summary }
    : undefined;

  const value: BindingDef = compact({
    plugin: asString(data.plugin) ?? '',
    pluginVersion: asString(data.plugin_version) ?? '',
    pluginHash: asString(data.plugin_hash) ?? '',
    version: typeof data.version === 'number' ? data.version : 0,
    frozen,
    tools,
    capabilities: strings(data.capabilities),
    entities,
    roles: strings(data.roles),
    records,
    policy: isRecord(data.policy) ? toPolicyDoc(data.policy, file) : undefined,
    dryRun,
    file,
    hash: sha256(text),
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

function mappingToRaw(m: FieldMapping): unknown {
  if (m.from !== undefined && !m.transform && !m.direction) return m.from;
  return compact({ from: m.from, transform: m.transform, direction: m.direction });
}

/**
 * A binding as YAML text, keys in a fixed order. `parseBindingFile(bindingToYaml(b), b.file).value`
 * equals `b` apart from `hash` (the hash of the new text).
 */
export function bindingToYaml(b: BindingDef): string {
  const doc = compact({
    plugin: b.plugin,
    plugin_version: b.pluginVersion,
    plugin_hash: b.pluginHash || undefined,
    version: b.version,
    frozen: b.frozen ? compact({ by: b.frozen.by, at: b.frozen.at, run: b.frozen.runId }) : undefined,
    tools: b.tools,
    capabilities: b.capabilities,
    entities: Object.fromEntries(Object.entries(b.entities).map(([name, e]) => [name, { entity: e.entity, fields: e.fields }])),
    roles: b.roles,
    records: Object.fromEntries(Object.entries(b.records).map(([name, r]) => [name, {
      entity: r.entity,
      fields: Object.fromEntries(Object.entries(r.fields).map(([f, m]) => [f, mappingToRaw(m)])),
      identity: compact({ keys: r.identity.keys, fuzzy: r.identity.fuzzy, create_missing: r.identity.createMissing }),
    }])),
    policy: b.policy ? policyToRaw(b.policy) : undefined,
    dry_run: b.dryRun,
  });
  return stringifyYaml(doc, { lineWidth: 0 });
}
