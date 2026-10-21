/** `case.yaml` and `domain/entities/*.yaml`: fields made of value types. */
import { caseFormat, entityFormat, rolesFormat } from './formats.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, sha256, type ParseResult, type PathKey } from './source.ts';
import { SCALAR_TYPES, type CaseTypeDef, type EntityTypeDef, type FieldDef, type RecordTypeDef, type RoleDef } from './types.ts';
import { parseValueType } from './value-types.ts';
import { parseCalculated, parseLifecycle, parseLinks, parsePageLayout, parseRelationships } from './parse-records.ts';

/** Parses a type expression, reporting `invalid-type` at the path when it can't be read. */
export function typeAt(src: unknown, report: Reporter, path: PathKey[]) {
  if (typeof src !== 'string') return undefined; // the format check already said so
  const type = parseValueType(src);
  if (!type) report.error('invalid-type', `\`${src}\` is not a type: expected Text, Money, Identifier(GSTIN), Quantity(kg), Enum[a, b], List<T>, Ref<Entity> or a record type name`, path);
  return type;
}

/** `article.abstract` (a field's `quote_of`, 25 §4) → `{ ref, field }`. */
function quoteOf(raw: unknown): FieldDef['quoteOf'] {
  const m = typeof raw === 'string' ? /^\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*$/.exec(raw) : null;
  return m ? { ref: m[1]!, field: m[2]! } : undefined;
}

/** A `fields:` map. A field may be a type expression or `{ type, required, description, access, controlled, quote_of }`. */
export function parseFields(raw: unknown, report: Reporter, path: PathKey[]): Record<string, FieldDef> {
  const out: Record<string, FieldDef> = {};
  for (const [name, spec] of Object.entries(asRecord(raw))) {
    const obj = isRecord(spec) ? spec : undefined;
    const typeSource = obj ? obj.type : spec;
    const type = typeAt(typeSource, report, obj ? [...path, name, 'type'] : [...path, name]);
    if (!type) continue;
    out[name] = compact({
      type,
      typeSource: (typeSource as string).trim(),
      required: obj && typeof obj.required === 'boolean' ? obj.required : undefined,
      description: obj ? asString(obj.description) : undefined,
      access: obj && Array.isArray(obj.access) ? asStrings(obj.access) : undefined,
      controlled: obj && typeof obj.controlled === 'boolean' ? obj.controlled : undefined,
      quoteOf: obj ? quoteOf(obj.quote_of) : undefined,
    });
  }
  return out;
}

export function parseCaseFile(text: string, file: string): ParseResult<CaseTypeDef> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected a case type: case, fields, types');
    return { diagnostics: report.diagnostics };
  }
  report.validate(caseFormat, src.data);
  const data = src.data;
  const types: Record<string, RecordTypeDef> = {};
  for (const name of Object.keys(asRecord(data.types))) {
    if ((SCALAR_TYPES as readonly string[]).includes(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      report.error('invalid-type-name', `\`${name}\` can't be a record type name`, ['types', name]);
      continue;
    }
    types[name] = { name, fields: parseFields(asRecord(data.types)[name], report, ['types', name]) };
  }
  const value: CaseTypeDef = {
    id: asString(data.case) ?? '',
    fields: parseFields(data.fields, report, ['fields']),
    types,
    file,
    hash: sha256(text),
  };
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

export function parseEntityFile(text: string, file: string): ParseResult<EntityTypeDef> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected an entity type: entity, fields, relationships');
    return { diagnostics: report.diagnostics };
  }
  report.validate(entityFormat, src.data);
  const data = src.data;
  // Phase 6 (24 §4, §6): object-form relationships, calculated fields, links, the statechart, the page.
  const lifecycle = parseLifecycle(data.lifecycle, report);
  const value: EntityTypeDef = compact({
    entity: asString(data.entity) ?? '',
    fields: parseFields(data.fields, report, ['fields']),
    relationships: parseRelationships(data.relationships, report),
    lifecycle: lifecycle.states,
    ownership: isRecord(data.ownership)
      ? Object.fromEntries(Object.entries(data.ownership).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : undefined,
    file,
    hash: sha256(text),
    title: asString(data.title),
    parent: asString(data.parent),
    calculated: parseCalculated(data.calculated),
    links: parseLinks(data.links),
    lifecycleChart: lifecycle.chart,
    invariants: Array.isArray(data.invariants) ? asStrings(data.invariants) : undefined,
    page: parsePageLayout(data.page, report),
    // Literature (25 §3, §6).
    key: Array.isArray(data.key) ? asStrings(data.key) : typeof data.key === 'string' ? [data.key.trim()] : undefined,
    keepFromChat: data.keep_from_chat === true ? true : undefined,
    list: Array.isArray(data.list) ? asStrings(data.list) : undefined,
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

/** `domain/roles.yaml`: `roles: { staff: { title: Staff, description: … } }`, or `staff: Staff`. */
export function parseRolesFile(text: string, file: string): ParseResult<Record<string, RoleDef>> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (src.data === null || src.data === undefined) return { value: src.diagnostics.length ? undefined : {}, diagnostics: report.diagnostics };
  if (!isRecord(src.data)) {
    report.error('invalid-format', 'expected roles: a map of role id to { title, description }');
    return { diagnostics: report.diagnostics };
  }
  report.validate(rolesFormat, src.data);
  const roles: Record<string, RoleDef> = {};
  for (const [id, spec] of Object.entries(asRecord(src.data.roles))) {
    if (typeof spec === 'string') roles[id] = { id, title: spec };
    else if (isRecord(spec)) roles[id] = compact({ id, title: asString(spec.title) ?? id, description: asString(spec.description) });
  }
  rememberLocator(roles, src.locate);
  return { value: roles, diagnostics: report.diagnostics };
}
