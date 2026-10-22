// Chart data (docs/memwise/25-literature-poc.md §5): the rows a chart draws, computed now under
// the viewer's row rules, for a record page's `chart` block (over its related rows) and a free
// page's (over an entity's records). `bar`, `line` and `donut` count records per value of a
// field, grouped in SQL; `interval` is one row per record with a label, a value and its interval.
import type { Queryable } from '@memwise/db';
import { keyOf, type ChartKind, type EntityTypeDef } from '@memwise/defs';
import type { Actor, ChartData, ChartDatum } from '../types.ts';
import { recordTitle, type RecordsDeps } from './context.ts';
import { queryRecords } from './browse.ts';

/** What a chart says about the rows it draws (the block's fields, without where they come from). */
export interface ChartSpec {
  chart: ChartKind;
  title?: string;
  by?: string;
  label?: string;
  value?: string;
  low?: string;
  high?: string;
  unit?: string;
}

/** Interval rows drawn at most. */
export const INTERVAL_ROW_LIMIT = 200;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** Group keys in order: numbers (years) by value, everything else as text; "not set" last. */
function byKey(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const x = num(a);
  const y = num(b);
  return x !== undefined && y !== undefined ? x - y : a.localeCompare(b);
}

/**
 * A chart's data over the records of `def` that match `filter` (a condition with `params.<x>`).
 * Counts per `by` come from the store's grouping (one SQL `group by`); a Ref is labelled by its
 * record's title.
 */
export async function chartData(deps: RecordsDeps, actor: Actor, db: Queryable, def: EntityTypeDef, spec: ChartSpec,
  filter: string | undefined, params: Record<string, unknown>, opts: { project?: string } = {}): Promise<ChartData> {
  // Stage 3: a project's page counts its own records.
  const inProject = opts.project ? { project: opts.project } : {};
  const base = { kind: spec.chart, ...(spec.title ? { title: spec.title } : {}) };
  if (spec.chart !== 'interval') {
    if (!spec.by) return { ...base, data: [], total: 0 };
    const r = await queryRecords(deps, def, { ...(filter ? { filter } : {}), group: spec.by, limit: 1, ...inProject }, actor, params, db);
    const groups = [...(r.groups ?? [])].sort((a, b) => byKey(a.key, b.key));
    return {
      ...base,
      data: groups.map((g): ChartDatum => ({ label: g.title ?? g.key ?? 'Not set', value: g.count, key: g.key })),
      total: r.total,
    };
  }
  const r = await queryRecords(deps, def, { ...(filter ? { filter } : {}), limit: INTERVAL_ROW_LIMIT, ...inProject }, actor, params, db);
  const data: ChartDatum[] = [];
  let skipped = 0;
  for (const row of r.rows) {
    const value = num(row.values[spec.value ?? '']);
    if (value === undefined) { skipped++; continue; }
    const low = num(row.values[spec.low ?? '']);
    const high = num(row.values[spec.high ?? '']);
    const unit = spec.unit ? row.values[spec.unit] : undefined;
    const label = spec.label ? recordTitle({ ...def, title: spec.label }, row.id, row.values) : row.title;
    data.push({
      label, value, ...(low !== undefined ? { low } : {}), ...(high !== undefined ? { high } : {}),
      ...(typeof unit === 'string' && unit.trim() ? { unit } : {}),
      record: { entity: keyOf(def), id: row.id, title: row.title, ...(row.status ? { status: row.status } : {}) },
    });
  }
  // One unit for the chart when every row shares it; else each row keeps its own.
  const units = new Set(data.map((d) => d.unit ?? ''));
  const shared = units.size === 1 ? [...units][0] : undefined;
  if (shared !== undefined) for (const d of data) delete d.unit;
  return { ...base, ...(shared ? { unit: shared } : {}), data, total: data.length, ...(skipped ? { skipped } : {}) };
}
