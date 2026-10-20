/**
 * What a domain table's read view holds, worked out from the definitions (24 §3, §4): every
 * field, the system columns, calculated fields (rollups and row formulas) and fields followed
 * through links, each with the name conditions and values use, its column and its type. Also
 * the relationship graph: a `many` relationship's inverse column and the entity it targets.
 */
import {
  DEFAULT_DOMAIN, keyOf, parseCondition, resolveEntity, splitEntityKey, type CalculatedFieldDef, type ConditionNode,
  type EntityTypeDef, type ValueType,
} from '@memwise/defs';
import { conditionType, type ConditionType } from '../conditions.ts';
import { entityColumns, entityTableName, snake, type ColumnType, type EntityColumn } from './tables.ts';

export interface RecordColumn {
  /** The name conditions, sorts and values use (`status` for the lifecycle). */
  name: string;
  /** Its column in `domain_read.<table>`. */
  column: string;
  kind: 'system' | 'field' | 'calculated' | 'followed';
  type: ConditionType;
  /** Fields: the stored column type. */
  columnType?: ColumnType;
  /** Fields with `access: [roles]`. */
  access?: string[];
  /** Followed fields: the link's target entity key and the field there. */
  link?: { target: string; field: string };
  calculated?: CalculatedFieldDef;
}

/** The type the condition language gives a column type. */
export function conditionTypeOf(t: ColumnType): ConditionType {
  switch (t) {
    case 'text': return 'text';
    case 'numeric': return 'number';
    case 'boolean': return 'boolean';
    case 'date': return 'date';
    case 'timestamptz': return 'timestamp';
    case 'jsonb': return 'json';
  }
}

const SYSTEM: RecordColumn[] = [
  { name: 'id', column: 'id', kind: 'system', type: 'text' },
  { name: 'status', column: 'lifecycle', kind: 'system', type: 'text' },
  { name: 'created_at', column: 'created_at', kind: 'system', type: 'timestamp' },
  { name: 'updated_at', column: 'updated_at', kind: 'system', type: 'timestamp' },
  { name: 'version', column: 'version', kind: 'system', type: 'number' },
];

/** The domain an entity type belongs to. */
export const domainOfEntity = (def: Pick<EntityTypeDef, 'domain'>) => def.domain ?? DEFAULT_DOMAIN;

/** An entity named as `def`'s file names it (bare in its domain, or a key). */
export function targetOf(entities: Record<string, EntityTypeDef>, def: EntityTypeDef, name: string): EntityTypeDef | undefined {
  return resolveEntity(entities, domainOfEntity(def), name) ?? Object.values(entities).find((e) => keyOf(e) === name);
}

/** The entity a `Ref<…>` value type points at, if it is one. */
function refTarget(t: ValueType): string | undefined {
  return t.kind === 'ref' ? t.entity : undefined;
}

/**
 * The inverse of a `many` relationship: the target entity and its column that points back
 * (`via`, else the target's only `Ref`/`one` field that names this entity).
 */
export function inverseOf(
  entities: Record<string, EntityTypeDef>, def: EntityTypeDef, relationship: string,
): { child: EntityTypeDef; column: EntityColumn } | undefined {
  const rel = def.relationships?.[relationship];
  if (!rel || rel.cardinality !== 'many') return undefined;
  const child = targetOf(entities, def, rel.target);
  if (!child) return undefined;
  const cols = entityColumns(child);
  if (rel.via) {
    const c = cols.find((x) => x.field === rel.via);
    return c ? { child, column: c } : undefined;
  }
  const me = keyOf(def);
  const pointing = cols.filter((c) => {
    const f = child.fields[c.field];
    const target = f ? refTarget(f.type) : child.relationships?.[c.field]?.cardinality === 'one' ? child.relationships[c.field]!.target : undefined;
    if (!target) return false;
    const t = targetOf(entities, child, target);
    return !!t && keyOf(t) === me;
  });
  return pointing.length === 1 ? { child, column: pointing[0]! } : undefined;
}

/** Every name the condition reads (empty when it doesn't parse). */
export function namesIn(source: string | undefined): string[] {
  if (!source) return [];
  return parseCondition(source).names;
}

export function parsed(source: string): ConditionNode | undefined {
  return parseCondition(source).ast;
}

/**
 * The columns of `domain_read.<table>` that have a name: system columns, fields, calculated
 * fields, followed fields. Calculated types are worked out from their definitions (rollup
 * kinds; formulas by the type their expression has).
 */
export function recordColumns(def: EntityTypeDef, entities: Record<string, EntityTypeDef>, seen: string[] = []): RecordColumn[] {
  const out: RecordColumn[] = [...SYSTEM];
  for (const c of entityColumns(def)) {
    out.push({ name: c.field, column: c.column, kind: 'field', type: conditionTypeOf(c.type), columnType: c.type, ...(c.access ? { access: c.access } : {}) });
  }
  const key = keyOf(def);
  const followed: RecordColumn[] = [];
  for (const [targetKey, link] of Object.entries(def.links ?? {})) {
    const target = targetOf(entities, def, link.target || targetKey);
    if (!target) continue;
    const tcols = seen.includes(keyOf(target)) ? [] : recordColumns(target, entities, [...seen, key]);
    for (const f of link.follow) {
      const tc = tcols.find((c) => c.name === f);
      followed.push({ name: f, column: snake(f), kind: 'followed', type: tc?.type ?? 'unknown', link: { target: keyOf(target), field: f } });
    }
  }
  const calc: RecordColumn[] = [];
  for (const [name, c] of Object.entries(def.calculated ?? {})) {
    calc.push({ name, column: snake(name), kind: 'calculated', type: 'unknown', calculated: c });
  }
  out.push(...calc, ...followed);
  // Types of calculated fields (formulas may read each other, so resolve on demand).
  const byName = new Map(out.map((c) => [c.name, c]));
  const resolving = new Set<string>();
  const typeOf = (n: string): ConditionType | undefined => {
    const col = byName.get(n);
    if (!col) return undefined;
    if (col.kind !== 'calculated' || col.type !== 'unknown') return col.type;
    if (resolving.has(n)) return 'unknown';
    resolving.add(n);
    col.type = calculatedType(col.calculated!, def, entities, typeOf, [...seen, key]);
    resolving.delete(n);
    return col.type;
  };
  for (const c of calc) typeOf(c.name);
  return out;
}

function calculatedType(
  c: CalculatedFieldDef, def: EntityTypeDef, entities: Record<string, EntityTypeDef>,
  typeOf: (n: string) => ConditionType | undefined, seen: string[],
): ConditionType {
  if (c.kind === 'rollup') {
    if (c.rollup === 'count' || c.rollup === 'percent') return 'number';
    const inv = inverseOf(entities, def, c.of);
    if (!inv || !c.field) return 'unknown';
    if (seen.includes(keyOf(inv.child))) return 'unknown';
    return recordColumns(inv.child, entities, seen).find((x) => x.name === c.field)?.type ?? 'unknown';
  }
  const ast = parsed(c.formula);
  if (!ast) return 'unknown';
  try {
    return conditionType(ast, { column: (n) => (typeOf(n) ? n : undefined), param: () => '$0', type: typeOf });
  } catch {
    return 'unknown';
  }
}

/** Where a link pairs records: `mw.identity_links` with `plugin = 'domain:<other domain>'`, `source = <other entity>`. */
export function linkPairing(targetKey: string): { plugin: string; source: string } {
  const { domain, entity } = splitEntityKey(targetKey);
  return { plugin: `domain:${domain}`, source: entity };
}

/** The column holding the paired record's id for a link (`_link__edc__site`). */
export function linkColumn(target: EntityTypeDef | string): string {
  return `_link__${entityTableName(target)}`;
}
