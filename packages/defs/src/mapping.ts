/**
 * Record mappings (Phase 4, 22 §5, D64): a connector's record → a domain entity's values, with a
 * fixed set of deterministic transforms. No model runs when a mapping is used (P1): everything
 * here is pure and gives the same output for the same input.
 */
import type { FieldMapping, MappedRecord, RecordBinding, RecordSourceDef, Transform } from './plugin-types.ts';
import type { EntityTypeDef } from './types.ts';
import { templateFields } from './binding-checks.ts';
import { validateValue, type RecordTypes } from './values.ts';

/** The value at a dotted path (`address.city`), or undefined. */
export function valueAt(record: unknown, path: string): unknown {
  let v: unknown = record;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const onText = (v: unknown, f: (s: string) => string) => (typeof v === 'string' ? f(v) : v);

/** Fills `{field}` placeholders from the record; a missing field is empty text. */
export function fillTemplate(template: string, record: unknown): string {
  return template.replace(/\{([^{}]+)\}/g, (_, path: string) => {
    const v = valueAt(record, path.trim());
    return isBlank(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** Applies one transform. `record` is the whole source record (for templates). */
export function applyTransform(t: Transform, value: unknown, record: unknown): unknown {
  if (typeof t === 'string') {
    switch (t) {
      case 'trim': return onText(value, (s) => s.trim());
      case 'lower': return onText(value, (s) => s.toLowerCase());
      case 'upper': return onText(value, (s) => s.toUpperCase());
      case 'squash': return onText(value, (s) => s.replace(/\s+/g, ' '));
      case 'digits': return typeof value === 'number' ? String(value).replace(/\D/g, '') : onText(value, (s) => s.replace(/\D/g, ''));
    }
  }
  if ('default' in t) return isBlank(value) ? t.default : value;
  if ('map' in t) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return value;
    return Object.prototype.hasOwnProperty.call(t.map, String(value)) ? t.map[String(value)] : value;
  }
  if ('money' in t) {
    if (typeof value === 'number' && Number.isFinite(value)) return { amount: value, currency: t.money };
    if (typeof value === 'string') {
      // `1,50,000`, `₹ 1500.50`, `INR 99`: separators and a leading currency sign or code go.
      const digits = value.replace(/[,\s]/g, '').replace(/^[^\d.-]+/, '');
      if (/^-?(\d+\.?\d*|\.\d+)$/.test(digits)) return { amount: Number(digits), currency: t.money };
    }
    return value;
  }
  return fillTemplate(t.template, record);
}

/** The value a field mapping reads from a record: `from` (or nothing), then each transform in order. */
export function mapField(mapping: FieldMapping, record: unknown): unknown {
  let v = mapping.from !== undefined ? valueAt(record, mapping.from) : undefined;
  for (const t of mapping.transform ?? []) v = applyTransform(t, v, record);
  return v;
}

/**
 * Why a mapped value can't be written back to the source unchanged, or undefined when it can.
 * trim, lower, upper and squash normalise (writing the domain value back reads as the same value);
 * a one-to-one `map` inverts; default, digits, money and template don't.
 */
export function roundTripProblem(field: string, mapping: FieldMapping, value: unknown, record: unknown): string | undefined {
  let back = value;
  for (const t of [...(mapping.transform ?? [])].reverse()) {
    if (typeof t === 'string') {
      if (t === 'digits') return `${field}: digits can't be written back (the other characters are lost)`;
      continue; // normalising: idempotent, so reading the written value gives it back
    }
    if ('map' in t) {
      const entries = Object.entries(t.map);
      const inverse = entries.filter(([, to]) => JSON.stringify(to) === JSON.stringify(back));
      if (new Set(entries.map(([, to]) => JSON.stringify(to))).size !== entries.length) return `${field}: the map is not one-to-one, so it can't be written back`;
      if (inverse.length === 1) back = inverse[0]![0];
      continue;
    }
    const kind = Object.keys(t)[0]!;
    return `${field}: the ${kind} transform can't be written back`;
  }
  if (mapping.from === undefined) return `${field}: it has no source field to write back to`;
  // Write `back` into the source, read it again: it must give the same domain value.
  const again = mapField(mapping, { ...(record as Record<string, unknown>), ...pathObject(mapping.from, back) });
  if (JSON.stringify(again) !== JSON.stringify(value)) return `${field}: ${JSON.stringify(value)} reads back as ${JSON.stringify(again)}`;
  return undefined;
}

function pathObject(path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  return { [head!]: rest.length ? pathObject(rest.join('.'), value) : value };
}

/**
 * Compiles one record source's mapping (22 §5) into a pure function. Each domain field is read
 * through its mapping; values are checked against the entity's field types when `entity` is given;
 * source fields no mapping uses are kept under `<pluginNamespace>.<field>` in `extra`; `write` and
 * `both` fields get a round-trip check. `raw` is a copy of the source record (the review's "before").
 */
export function compileRecordMapping(
  binding: RecordBinding, source: RecordSourceDef, pluginNamespace: string,
  entity?: EntityTypeDef, recordTypes: RecordTypes = {},
): (record: Record<string, unknown>) => MappedRecord {
  const used = new Set<string>([source.key.split('.')[0]!]);
  for (const m of Object.values(binding.fields)) {
    if (m.from !== undefined) used.add(m.from.split('.')[0]!);
    for (const t of m.transform ?? []) if (typeof t === 'object' && 'template' in t) for (const f of templateFields(t.template)) used.add(f.split('.')[0]!);
  }
  const fields = Object.entries(binding.fields);
  return (record) => {
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    const roundTrip: string[] = [];
    const key = valueAt(record, source.key);
    if (isBlank(key)) errors.push(`the record has no ${source.key}`);
    for (const [field, mapping] of fields) {
      const value = mapField(mapping, record);
      if (isBlank(value)) continue;
      values[field] = value;
      const type = entity?.fields[field]?.type;
      if (type) for (const err of validateValue(type, value, recordTypes)) errors.push(`${field}${err.startsWith('[') ? '' : ': '}${err}`);
      if (mapping.direction === 'write' || mapping.direction === 'both') {
        const problem = roundTripProblem(field, mapping, value, record);
        if (problem) roundTrip.push(problem);
      }
    }
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) if (!used.has(k)) extra[`${pluginNamespace}.${k}`] = v;
    return { source: source.name, externalId: isBlank(key) ? '' : String(key), raw: structuredClone(record), values, extra, errors, roundTrip };
  };
}
