/**
 * Entity rows (19 §3, 24 §3, §6): written to `domain.<table>`, read through
 * `domain_read.<table>` so fields the actor's roles may not see come back null and listed as
 * hidden, and calculated and followed fields come with the row. Pass a client from `withActor`
 * so the row rules apply. Versions, server time and entity events are the row trigger's: this
 * store never sends `created_at`, `updated_at` or `version`.
 */
import { keyOf, parseCondition, type EntityTypeDef } from '@memwise/defs';
import { quoteIdent as q } from '../cluster.ts';
import { bindTo, compileConditionSource, ConditionCompileError } from '../conditions.ts';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { iso, json } from '../rows.ts';
import { recordColumns, linkColumn, targetOf, type RecordColumn } from './model.ts';
import { viewContext } from './records-sql.ts';
import { entityColumns, entityIdPrefix, snake, tableOf, viewOf, type EntityColumn } from './tables.ts';

/** Same shape as `EntityRow` in @memwise/runtime, plus the lifecycle state and the record's version. */
export interface StoredEntityRow {
  id: string;
  /** Fields, then calculated and followed fields (24 §4), by name. */
  values: Record<string, unknown>;
  /** Fields nulled because the actor lacks the role (followed ones too). */
  hidden: string[];
  createdAt: string;
  /** Phase 6: server time of the last change. */
  updatedAt: string;
  /** Phase 6: the record's version (1 when created, + 1 per change). */
  version: number;
  /** Phase 6: who made the last change (the version's `by`). */
  updatedBy?: string;
  lifecycle?: string;
  createdByStep?: string;
  /** Phase 6: links (by target entity key) and the record each is paired with. */
  followed?: Record<string, { recordId?: string }>;
}

export interface CreateEntityOptions {
  /** A repeat with the same key creates nothing and returns the first row's id. */
  idempotencyKey?: string;
  stepRunId?: string;
  /** Initial lifecycle state; default the chart's `initial`, else the first one defined. */
  lifecycle?: string;
}

/** The context of a write (24 §3): set for the transaction, read by the row trigger. */
export interface RecordContext {
  reason?: string;
  /** Step run id, link id or `app`. */
  via?: string;
  /** The lifecycle transition being made (the `entered` event names it). */
  transition?: string;
  /** Who, when not the actor itself: `source:edc`, `source:plugin-x`, a person the kernel acts for. */
  by?: string;
}

export type RecordWriteErrorCode = 'invalid' | 'missing' | 'stale' | 'reason-required' | 'unknown-state';

/** A write the store refused, with a plain message and a code the kernel maps to a result status. */
export class RecordWriteError extends Error {
  constructor(readonly code: RecordWriteErrorCode, message: string, readonly fields?: string[]) {
    super(message);
  }
}

export interface EntityQuery {
  /** A condition (24 §5) on the records. */
  filter?: string;
  sort?: { field: string; desc?: boolean }[];
  /** Counts per value of this field (with the rows). */
  group?: string;
  /** Only these values on each row (absent: all). */
  columns?: string[];
  limit?: number;
  offset?: number;
  /** `params.<x>` values for the filter (dashboards). */
  params?: Record<string, unknown>;
}

export interface EntityQueryResult {
  rows: StoredEntityRow[];
  total: number;
  groups?: { key: string | null; count: number }[];
}

export interface EntityAggregate {
  kind: 'count' | 'sum' | 'avg' | 'percent';
  /** sum / avg: the field. */
  field?: string;
  /** Which records count (percent: the numerator). */
  where?: string;
  /** percent: the records it is a percent of (absent: all). */
  of?: string;
  params?: Record<string, unknown>;
}

const SETTINGS: Record<keyof RecordContext, string> = { reason: 'mw.reason', via: 'mw.via', transition: 'mw.transition', by: 'mw.by' };

/**
 * Sets the write context for the rest of the transaction (`set_config(…, true)`). Only the keys
 * present are set; a key present as undefined clears it.
 */
export async function withRecordContext(db: Queryable, ctx: RecordContext): Promise<void> {
  const keys = (Object.keys(ctx) as (keyof RecordContext)[]).filter((k) => k in SETTINGS);
  if (!keys.length) return;
  await db.query(`select ${keys.map((k, i) => `set_config('${SETTINGS[k]}', $${i + 1}, true)`).join(', ')}`,
    keys.map((k) => ctx[k] ?? ''));
}

export class PgEntityStore {
  /** Inserts a row and returns its id (`cust_<ulid>` for Customer). Unknown fields are refused. */
  async create(
    db: Queryable, def: EntityTypeDef, values: Record<string, unknown>,
    opts: CreateEntityOptions & { reason?: string; id?: string } = {},
  ): Promise<string> {
    const byField = writable(def, values);
    const states = statesOf(def);
    const lifecycle = opts.lifecycle ?? def.lifecycleChart?.initial ?? def.lifecycle?.[0] ?? null;
    if (opts.lifecycle && states.length && !states.includes(opts.lifecycle)) {
      throw new RecordWriteError('unknown-state', `${def.entity} has no lifecycle state "${opts.lifecycle}" (${states.join(', ')})`);
    }

    const id = opts.id ?? `${entityIdPrefix(def.entity)}_${ulid()}`;
    const names = ['id', 'lifecycle', 'created_by_step', 'idempotency_key'];
    const params: unknown[] = [id, lifecycle, opts.stepRunId ?? null, opts.idempotencyKey ?? null];
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const c = byField.get(field)!;
      names.push(c.column);
      params.push(toParam(c, value));
    }
    if (opts.reason !== undefined) await withRecordContext(db, { reason: opts.reason });
    const table = tableOf(def);
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    if (opts.idempotencyKey === undefined) {
      await write(() => db.query(`insert into ${table} (${names.map(q).join(', ')}) values (${placeholders})`, params));
      return id;
    }
    const r = await write(() => db.query(
      `insert into ${table} (${names.map(q).join(', ')}) values (${placeholders}) on conflict (idempotency_key) do nothing`, params));
    if (r.rowCount) return id;
    const { rows } = await db.query<{ id: string }>(`select id from ${table} where idempotency_key = $1`, [opts.idempotencyKey]);
    if (!rows[0]) throw new Error(`${def.entity}: idempotency key ${opts.idempotencyKey} conflicted but no row is visible`);
    return rows[0].id;
  }

  /**
   * Changes fields of a record. Calculated and followed fields are refused; `expectedVersion`
   * refuses the write when someone changed the record since (code `stale`). A write that changes
   * nothing makes no version. Returns the record's version and the fields that changed.
   */
  async update(
    db: Queryable, def: EntityTypeDef, id: string, values: Record<string, unknown>,
    opts: { reason?: string; expectedVersion?: number } = {},
  ): Promise<{ version: number; changed: string[] }> {
    const byField = writable(def, values);
    const before = await current(db, def, id);
    if (!before) throw new RecordWriteError('missing', `There is no ${def.entity} ${id}`);
    if (opts.expectedVersion !== undefined && before.version !== opts.expectedVersion) {
      throw new RecordWriteError('stale', `${def.entity} ${id} changed since you opened it (version ${before.version}, not ${opts.expectedVersion})`);
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const c = byField.get(field)!;
      params.push(toParam(c, value));
      sets.push(`${q(c.column)} = $${params.length}`);
    }
    if (!sets.length) return { version: before.version, changed: [] };
    if (opts.reason !== undefined) await withRecordContext(db, { reason: opts.reason });
    params.push(before.version);
    const r = await write(() => db.query<{ version: number }>(
      `update ${tableOf(def)} set ${sets.join(', ')} where id = $1 and version = $${params.length} returning version`, params));
    if (!r.rows[0]) throw new RecordWriteError('stale', `${def.entity} ${id} changed while it was being saved; try again`);
    return { version: r.rows[0].version, changed: await changedIn(db, def, id, before.version, r.rows[0].version) };
  }

  /**
   * Moves a record to a lifecycle state, naming the transition (the `entered` event carries it).
   * Who may make it and its guard are the kernel's to decide. Returns the version and the state
   * it came from.
   */
  async transition(
    db: Queryable, def: EntityTypeDef, id: string, opts: { to: string; transition: string; reason?: string },
  ): Promise<{ version: number; from?: string }> {
    const states = statesOf(def);
    if (!states.includes(opts.to)) {
      throw new RecordWriteError('unknown-state', `${def.entity} has no lifecycle state "${opts.to}"${states.length ? ` (${states.join(', ')})` : ''}`);
    }
    const before = await current(db, def, id);
    if (!before) throw new RecordWriteError('missing', `There is no ${def.entity} ${id}`);
    await withRecordContext(db, { transition: opts.transition, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) });
    try {
      const r = await write(() => db.query<{ version: number }>(
        `update ${tableOf(def)} set lifecycle = $2 where id = $1 and version = $3 returning version`, [id, opts.to, before.version]));
      if (!r.rows[0]) throw new RecordWriteError('stale', `${def.entity} ${id} changed while it was being moved; try again`);
      return { version: r.rows[0].version, ...(before.lifecycle ? { from: before.lifecycle } : {}) };
    } finally {
      await withRecordContext(db, { transition: undefined });
    }
  }

  async get(db: Queryable, def: EntityTypeDef, id: string): Promise<StoredEntityRow | undefined> {
    return (await this.select(db, def, 'where v.id = $1', [id]))[0];
  }

  /**
   * Rows, newest first. `unrestricted`: the kernel's own reads (identity matching on the system
   * pool), from the table itself, so fields with an `access` list are not nulled; never for a
   * person or a step. Calculated and followed fields come only through the view.
   */
  async list(db: Queryable, def: EntityTypeDef, opts: { limit?: number; unrestricted?: boolean } = {}): Promise<StoredEntityRow[]> {
    return this.select(db, def, 'order by v.created_at desc, v.id desc limit $1', [opts.limit ?? 500], opts.unrestricted);
  }

  /** A view's records (24 §6): filter, sort, group counts, columns, paging, and the total. */
  async query(db: Queryable, def: EntityTypeDef, entities: Record<string, EntityTypeDef>, query: EntityQuery = {}): Promise<EntityQueryResult> {
    const cols = recordColumns(def, entities);
    const params: unknown[] = [];
    const ctx = viewContext(cols, 'v.', bindTo(params), (n) => query.params?.[n]);
    const where = query.filter?.trim() ? `coalesce(${compileConditionSource(query.filter, ctx)}, false)` : 'true';
    const order = (query.sort ?? []).map((s) => {
      const col = ctx.column(s.field);
      if (!col) throw new ConditionCompileError(`there is no field "${s.field}" to sort by`, 0);
      return `${col} ${s.desc ? 'desc' : 'asc'} nulls last`;
    });
    order.push('v.created_at desc', 'v.id desc');
    const view = `${viewOf(def)} v`;
    const total = (await db.query<{ n: number }>(`select count(*)::int as n from ${view} where ${where}`, params)).rows[0]!.n;
    const pageParams = [...params, query.limit ?? 500, query.offset ?? 0];
    const rows = await this.select(db, def, `where ${where} order by ${order.join(', ')} limit $${params.length + 1} offset $${params.length + 2}`,
      pageParams, false, entities);
    const out: EntityQueryResult = { rows, total };
    if (query.columns?.length) {
      const keep = new Set(query.columns);
      for (const r of rows) r.values = Object.fromEntries(Object.entries(r.values).filter(([k]) => keep.has(k)));
    }
    if (query.group) {
      const col = ctx.column(query.group);
      if (!col) throw new ConditionCompileError(`there is no field "${query.group}" to group by`, 0);
      const { rows: g } = await db.query<{ key: string | null; count: number }>(
        `select (${col})::text as key, count(*)::int as count from ${view} where ${where} group by 1 order by 1 nulls last`, params);
      out.groups = g;
    }
    return out;
  }

  /** One number over an entity's records (dashboards, 24 §6); null when there is nothing to count. */
  async aggregate(db: Queryable, def: EntityTypeDef, entities: Record<string, EntityTypeDef>, a: EntityAggregate): Promise<number | null> {
    const cols = recordColumns(def, entities);
    const params: unknown[] = [];
    const ctx = viewContext(cols, 'v.', bindTo(params), (n) => a.params?.[n]);
    const cond = (s: string | undefined) => (s?.trim() ? `coalesce(${compileConditionSource(s, ctx)}, false)` : 'true');
    const where = cond(a.where);
    let select: string;
    switch (a.kind) {
      case 'count': select = `count(*) filter (where ${where})`; break;
      case 'sum': case 'avg': {
        const col = a.field ? ctx.column(a.field) : undefined;
        if (!col) throw new ConditionCompileError(`${a.kind} needs a field of ${def.entity}`, 0);
        select = `${a.kind}(${col}) filter (where ${where})`;
        break;
      }
      case 'percent': {
        const of = cond(a.of);
        select = `case when count(*) filter (where ${of}) = 0 then null else 100.0 * count(*) filter (where ${of} and ${where}) / count(*) filter (where ${of}) end`;
        break;
      }
    }
    const { rows } = await db.query<{ n: string | number | null }>(`select ${select} as n from ${viewOf(def)} v`, params);
    const n = rows[0]?.n;
    return n === null || n === undefined ? null : Number(n);
  }

  private async select(
    db: Queryable, def: EntityTypeDef, tail: string, params: unknown[], unrestricted = false, entities?: Record<string, EntityTypeDef>,
  ): Promise<StoredEntityRow[]> {
    const { rows } = await db.query<{ r: Record<string, unknown> }>(
      `select to_jsonb(v) as r from ${unrestricted ? tableOf(def) : viewOf(def)} v ${tail}`, params);
    return rows.map(({ r }) => decodeRow(def, r, unrestricted, entities));
  }
}

/** A record's version and state now (visible to the actor), or undefined. */
async function current(db: Queryable, def: EntityTypeDef, id: string): Promise<{ version: number; lifecycle?: string } | undefined> {
  const { rows } = await db.query<{ version: number; lifecycle: string | null }>(
    `select version, lifecycle from ${viewOf(def)} where id = $1`, [id]);
  return rows[0] ? { version: rows[0].version, ...(rows[0].lifecycle ? { lifecycle: rows[0].lifecycle } : {}) } : undefined;
}

/** The fields the versions between `from` (exclusive) and `to` changed. */
async function changedIn(db: Queryable, def: EntityTypeDef, id: string, from: number, to: number): Promise<string[]> {
  if (to <= from) return [];
  const { rows } = await db.query<{ changed: string[] }>(
    `select changed from mw.record_versions where entity = $1 and record_id = $2 and version > $3 and version <= $4 order by version`,
    [keyOf(def), id, from, to]);
  return [...new Set(rows.flatMap((r) => r.changed))];
}

/** The field columns a write names; anything else is refused in plain words. */
function writable(def: EntityTypeDef, values: Record<string, unknown>): Map<string, EntityColumn> {
  const byField = new Map(entityColumns(def).map((c) => [c.field, c]));
  const calculated = Object.keys(values).filter((k) => def.calculated?.[k]);
  if (calculated.length) {
    throw new RecordWriteError('invalid', `${calculated.map((u) => `"${u}"`).join(', ')} ${calculated.length > 1 ? 'are' : 'is'} calculated on ${def.entity} and can't be written`, calculated);
  }
  const followed = Object.keys(values).filter((k) => Object.values(def.links ?? {}).some((l) => l.follow.includes(k)));
  if (followed.length) {
    throw new RecordWriteError('invalid', `${followed.map((u) => `"${u}"`).join(', ')} ${followed.length > 1 ? 'come' : 'comes'} from a linked domain and can't be changed on ${def.entity}`, followed);
  }
  const unknown = Object.keys(values).filter((k) => !byField.has(k));
  if (unknown.length) throw new RecordWriteError('invalid', `${def.entity} has no field ${unknown.map((u) => `"${u}"`).join(', ')}`, unknown);
  return byField;
}

const statesOf = (def: EntityTypeDef): string[] => def.lifecycle ?? Object.keys(def.lifecycleChart?.states ?? {});

/** Runs a write, turning the row trigger's refusals into `RecordWriteError`s. */
async function write<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'MW001') throw new RecordWriteError('reason-required', (err.message ?? '').replace(/^reason-required:\s*/, ''));
    throw e;
  }
}

function decodeRow(def: EntityTypeDef, r: Record<string, unknown>, unrestricted: boolean, entities?: Record<string, EntityTypeDef>): StoredEntityRow {
  const values: Record<string, unknown> = {};
  for (const c of entityColumns(def)) {
    const v = r[c.column];
    if (v !== null && v !== undefined) values[c.field] = fromColumn(c, v);
    else if (c.access && !unrestricted) values[c.field] = null;
  }
  const followed: Record<string, { recordId?: string }> = {};
  if (!unrestricted) {
    const extra: RecordColumn[] = entities ? recordColumns(def, entities).filter((c) => c.kind === 'calculated' || c.kind === 'followed') : extraColumns(def);
    for (const c of extra) {
      const v = r[c.column];
      values[c.name] = v === undefined ? null : c.type === 'timestamp' && typeof v === 'string' ? iso(v) : v;
    }
    for (const [k, link] of Object.entries(def.links ?? {})) {
      const target = entities ? targetOf(entities, def, link.target || k) : undefined;
      const key = target ? keyOf(target) : link.target || k;
      const id = r[linkColumn(target ?? key)];
      followed[key] = typeof id === 'string' ? { recordId: id } : {};
    }
  }
  const row: StoredEntityRow = {
    id: r.id as string,
    values,
    hidden: unrestricted ? [] : ((r._hidden as string[] | null) ?? []),
    createdAt: iso(r.created_at as string),
    updatedAt: iso(r.updated_at as string),
    version: Number(r.version ?? 1),
  };
  if (r.updated_by) row.updatedBy = r.updated_by as string;
  if (r.lifecycle) row.lifecycle = r.lifecycle as string;
  if (r.created_by_step) row.createdByStep = r.created_by_step as string;
  if (Object.keys(followed).length) row.followed = followed;
  return row;
}

/** Calculated and followed columns known from the definition alone (no entity map at hand). */
function extraColumns(def: EntityTypeDef): RecordColumn[] {
  const out: RecordColumn[] = [];
  for (const name of Object.keys(def.calculated ?? {})) out.push({ name, column: snake(name), kind: 'calculated', type: 'unknown' });
  for (const link of Object.values(def.links ?? {})) {
    for (const f of link.follow) out.push({ name: f, column: snake(f), kind: 'followed', type: 'unknown' });
  }
  return out;
}

function toParam(c: EntityColumn, value: unknown): unknown {
  if (value === null) return null;
  if (c.type === 'jsonb') return json(value);
  if (c.type === 'numeric' && typeof value === 'object') throw new RecordWriteError('invalid', `${c.field}: expected a number`, [c.field]);
  return value;
}

/** Values arrive as JSON (`to_jsonb` of the row): dates as `YYYY-MM-DD`, numbers as numbers. */
function fromColumn(c: EntityColumn, v: unknown): unknown {
  if (c.type === 'numeric') return Number(v);
  if (c.type === 'timestamptz') return iso(v as string);
  return v;
}

// ---------------------------------------------------------------- conditions on one record

/** See `evaluateCondition` (conditions.ts). */
export async function evaluateOn(
  db: Queryable, def: EntityTypeDef, entities: Record<string, EntityTypeDef>, recordId: string, condition: string,
  opts: { params?: Record<string, unknown> } = {},
): Promise<{ holds: boolean; values: Record<string, unknown> }> {
  const cols = recordColumns(def, entities);
  const params: unknown[] = [recordId];
  const ctx = viewContext(cols, 'v.', bindTo(params), (n) => opts.params?.[n]);
  const sql = compileConditionSource(condition, ctx);
  const read = cols.filter((c) => namesOf(condition).includes(c.name));
  const valuesSql = read.length ? `jsonb_build_object(${read.map((c) => `'${c.name.replace(/'/g, "''")}', v.${q(c.column)}`).join(', ')})` : `'{}'::jsonb`;
  const { rows } = await db.query<{ holds: boolean; vals: Record<string, unknown> }>(
    `select coalesce((${sql}), false) as holds, ${valuesSql} as vals from ${viewOf(def)} v where v.id = $1`, params);
  const row = rows[0];
  if (!row) return { holds: false, values: {} };
  const values: Record<string, unknown> = {};
  for (const c of read) {
    const v = row.vals[c.name];
    values[c.name] = v === undefined ? null : c.type === 'timestamp' && typeof v === 'string' ? iso(v) : v;
  }
  return { holds: row.holds, values };
}

const namesOf = (condition: string): string[] => parseCondition(condition).names;
