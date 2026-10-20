/**
 * Entity rows (19 §3): written to `domain.<table>`, read through `domain_read.<table>` so
 * fields the actor's roles may not see come back null and listed as hidden. Pass a client
 * from `withActor` so the row rules apply.
 */
import type { EntityTypeDef } from '@memwise/defs';
import { quoteIdent as q } from '../cluster.ts';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { iso, json } from '../rows.ts';
import { entityColumns, entityIdPrefix, entityTableName, type EntityColumn } from './tables.ts';

/** Same shape as `EntityRow` in @memwise/runtime, plus the lifecycle state. */
export interface StoredEntityRow {
  id: string;
  values: Record<string, unknown>;
  /** Fields nulled because the actor lacks the role. */
  hidden: string[];
  createdAt: string;
  lifecycle?: string;
  createdByStep?: string;
}

export interface CreateEntityOptions {
  /** A repeat with the same key creates nothing and returns the first row's id. */
  idempotencyKey?: string;
  stepRunId?: string;
  /** Initial lifecycle state; default the first one defined. */
  lifecycle?: string;
}

export class PgEntityStore {
  /** Inserts a row and returns its id (`cust_<ulid>` for Customer). Unknown fields are refused. */
  async create(db: Queryable, def: EntityTypeDef, values: Record<string, unknown>, opts: CreateEntityOptions = {}): Promise<string> {
    const cols = entityColumns(def);
    const byField = new Map(cols.map((c) => [c.field, c]));
    const unknown = Object.keys(values).filter((k) => !byField.has(k));
    if (unknown.length) throw new Error(`${def.entity} has no field ${unknown.map((u) => `"${u}"`).join(', ')}`);
    const lifecycle = opts.lifecycle ?? def.lifecycle?.[0] ?? null;
    if (opts.lifecycle && def.lifecycle && !def.lifecycle.includes(opts.lifecycle)) {
      throw new Error(`${def.entity} has no lifecycle state "${opts.lifecycle}" (${def.lifecycle.join(', ')})`);
    }

    const id = `${entityIdPrefix(def.entity)}_${ulid()}`;
    const names = ['id', 'lifecycle', 'created_by_step', 'idempotency_key'];
    const params: unknown[] = [id, lifecycle, opts.stepRunId ?? null, opts.idempotencyKey ?? null];
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const c = byField.get(field)!;
      names.push(c.column);
      params.push(toParam(c, value));
    }
    const table = `domain.${q(entityTableName(def.entity))}`;
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    if (opts.idempotencyKey === undefined) {
      await db.query(`insert into ${table} (${names.map(q).join(', ')}) values (${placeholders})`, params);
      return id;
    }
    const r = await db.query(
      `insert into ${table} (${names.map(q).join(', ')}) values (${placeholders}) on conflict (idempotency_key) do nothing`, params);
    if (r.rowCount) return id;
    const { rows } = await db.query<{ id: string }>(`select id from ${table} where idempotency_key = $1`, [opts.idempotencyKey]);
    if (!rows[0]) throw new Error(`${def.entity}: idempotency key ${opts.idempotencyKey} conflicted but no row is visible`);
    return rows[0].id;
  }

  async get(db: Queryable, def: EntityTypeDef, id: string): Promise<StoredEntityRow | undefined> {
    return (await this.select(db, def, 'where id = $1', [id]))[0];
  }

  /** Rows, newest first. */
  async list(db: Queryable, def: EntityTypeDef, opts: { limit?: number } = {}): Promise<StoredEntityRow[]> {
    return this.select(db, def, 'order by created_at desc, id desc limit $1', [opts.limit ?? 500]);
  }

  private async select(db: Queryable, def: EntityTypeDef, tail: string, params: unknown[]): Promise<StoredEntityRow[]> {
    const cols = entityColumns(def);
    // Dates as text: the driver would turn them into local-midnight Date objects.
    const list = cols.map((c) => (c.type === 'date' ? `${q(c.column)}::text as ${q(c.column)}` : q(c.column)));
    const { rows } = await db.query(
      `select id, lifecycle, created_at, created_by_step, _hidden${list.length ? `, ${list.join(', ')}` : ''}
       from domain_read.${q(entityTableName(def.entity))} ${tail}`, params);
    return rows.map((r) => {
      const values: Record<string, unknown> = {};
      for (const c of cols) {
        const v = r[c.column];
        if (v !== null && v !== undefined) values[c.field] = fromColumn(c, v);
        else if (c.access) values[c.field] = null;
      }
      const row: StoredEntityRow = { id: r.id, values, hidden: r._hidden ?? [], createdAt: iso(r.created_at as Date) };
      if (r.lifecycle) row.lifecycle = r.lifecycle;
      if (r.created_by_step) row.createdByStep = r.created_by_step;
      return row;
    });
  }
}

function toParam(c: EntityColumn, value: unknown): unknown {
  if (value === null) return null;
  if (c.type === 'jsonb') return json(value);
  if (c.type === 'numeric' && typeof value === 'object') throw new Error(`${c.field}: expected a number`);
  return value;
}

function fromColumn(c: EntityColumn, v: unknown): unknown {
  if (c.type === 'numeric') return Number(v);
  if (c.type === 'timestamptz') return iso(v as Date);
  return v;
}
