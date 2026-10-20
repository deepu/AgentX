/**
 * Type expressions, durations and counts as they are written in the files.
 *
 * These return `undefined` for text they can't read; the file parsers turn that into a
 * diagnostic with the file and line, so nothing here throws on bad content.
 */
import { SCALAR_TYPES, type DurationMs, type ScalarTypeName, type ValueType } from './types.ts';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Words that only mean something with their parameter, so a bare `List` is a mistake, not a record type. */
const RESERVED = new Set(['Identifier', 'Quantity', 'Enum', 'List', 'Ref']);

/** `Money`, `Identifier(GSTIN)`, `Quantity(kg)`, `Enum[a, b]`, `List<Flag>`, `Ref<Customer>`, or a record type name. */
export function parseValueType(src: string): ValueType | undefined {
  if (typeof src !== 'string') return undefined;
  const s = src.trim();
  if ((SCALAR_TYPES as readonly string[]).includes(s)) return { kind: 'scalar', name: s as ScalarTypeName };

  let m = /^Identifier\(\s*([A-Za-z0-9_-]+)\s*\)$/.exec(s);
  if (m) return { kind: 'identifier', scheme: m[1]! };

  m = /^Quantity\(\s*([^()]+?)\s*\)$/.exec(s);
  if (m) return { kind: 'quantity', unit: m[1]! };

  m = /^Enum\s*\[(.*)\]$/.exec(s);
  if (m) {
    const values = m[1]!.split(',').map((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2'));
    if (values.some((v) => v === '') || new Set(values).size !== values.length) return undefined;
    return { kind: 'enum', values };
  }

  m = /^List\s*<(.*)>$/.exec(s);
  if (m) {
    const of = parseValueType(m[1]!);
    return of && { kind: 'list', of };
  }

  m = /^Ref\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>$/.exec(s);
  if (m) return { kind: 'ref', entity: m[1]! };

  if (NAME.test(s) && !RESERVED.has(s)) return { kind: 'named', name: s };
  return undefined;
}

/** The canonical way to write a type; `parseValueType(formatValueType(t))` gives `t` back. */
export function formatValueType(type: ValueType): string {
  switch (type.kind) {
    case 'scalar': return type.name;
    case 'identifier': return `Identifier(${type.scheme})`;
    case 'quantity': return `Quantity(${type.unit})`;
    case 'enum': return `Enum[${type.values.join(', ')}]`;
    case 'list': return `List<${formatValueType(type.of)}>`;
    case 'ref': return `Ref<${type.entity}>`;
    case 'named': return type.name;
  }
}

/** Structural equality; enum values compare as sets. */
export function sameValueType(a: ValueType, b: ValueType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'scalar': return a.name === (b as typeof a).name;
    case 'identifier': return a.scheme === (b as typeof a).scheme;
    case 'quantity': return a.unit === (b as typeof a).unit;
    case 'enum': {
      const other = (b as typeof a).values;
      return a.values.length === other.length && a.values.every((v) => other.includes(v));
    }
    case 'list': return sameValueType(a.of, (b as typeof a).of);
    case 'ref': return a.entity === (b as typeof a).entity;
    case 'named': return a.name === (b as typeof a).name;
  }
}

const UNIT_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
};
export const DURATION_PATTERN = '^\\s*(\\d+(\\.\\d+)?\\s*(ms|s|m|h|d|w)\\s*)+$|^\\s*\\d+\\s*$';

/** `30s`, `10m`, `3d`, `1h30m` → milliseconds. Numbers (and digit-only strings) are already milliseconds. */
export function parseDuration(src: string | number): DurationMs | undefined {
  if (typeof src === 'number') return Number.isFinite(src) && src >= 0 ? src : undefined;
  if (typeof src !== 'string' || !new RegExp(DURATION_PATTERN).test(src)) return undefined;
  if (/^\s*\d+\s*$/.test(src)) return Number(src);
  let total = 0;
  for (const part of src.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g)) total += Number(part[1]) * UNIT_MS[part[2]!]!;
  return Math.round(total);
}

export const COUNT_PATTERN = '^\\s*\\d+(\\.\\d+)?\\s*[kKmM]?\\s*$';

/** `40k` → 40000, `1.5m` → 1500000 (m is million here, not minutes), plain numbers as they are. */
export function parseCount(src: string | number): number | undefined {
  if (typeof src === 'number') return Number.isFinite(src) && src >= 0 ? src : undefined;
  if (typeof src !== 'string' || !new RegExp(COUNT_PATTERN).test(src)) return undefined;
  const m = /(\d+(?:\.\d+)?)\s*([kKmM])?/.exec(src)!;
  const scale = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  return Math.round(Number(m[1]) * scale);
}

const RATE_UNITS: Record<string, string> = { sec: 's', second: 's', min: 'm', minute: 'm', hr: 'h', hour: 'h', day: 'd', week: 'w' };
export const RATE_PATTERN = '^\\s*\\d+\\s*/\\s*(\\d+(\\.\\d+)?\\s*)?(ms|s|m|h|d|w|sec|second|min|minute|hr|hour|day|week)\\s*$';

/** `30/min`, `100/h`, `5/10m` → `{ count, perMs }`. */
export function parseRate(src: string): { count: number; perMs: DurationMs } | undefined {
  if (typeof src !== 'string' || !new RegExp(RATE_PATTERN).test(src)) return undefined;
  const [count, per] = src.split('/').map((p) => p.trim()) as [string, string];
  const m = /^(\d+(?:\.\d+)?)?\s*([a-z]+)$/.exec(per)!;
  const perMs = parseDuration(`${m[1] ?? '1'}${RATE_UNITS[m[2]!] ?? m[2]}`);
  return perMs ? { count: Number(count), perMs } : undefined;
}
