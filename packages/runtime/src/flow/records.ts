// The little the flow piece reads of domain records itself: a date column for date triggers,
// a record's state for timers, and its title for the case view and the Automations screen.
import { entityColumns, entityTableName } from '@memwise/db';
import type { EntityTypeDef } from '@memwise/defs';
import type { Queryable } from '../runs.ts';
import type { RecordRef } from '../types.ts';

export const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** `domain."etmf__site"` (the table itself: the kernel reads as the system). */
export const tableOf = (def: EntityTypeDef) => `domain.${q(entityTableName(def))}`;

/** The column of a field, or undefined. */
export const columnOf = (def: EntityTypeDef, field: string) => entityColumns(def).find((c) => c.field === field)?.column;

/** `{site_number} · {name}` filled from the values; default the first Text field, else the id. */
export function titleOf(def: EntityTypeDef, id: string, values: Record<string, unknown>): string {
  if (def.title) {
    // A field still empty leaves no dangling separator ("US-012 ·").
    const t = def.title.replace(/\{([A-Za-z0-9_]+)\}/g, (_, f: string) => (values[f] === null || values[f] === undefined ? '' : String(values[f])))
      .replace(/^[\s·:|,–—-]+|[\s·:|,–—-]+$/g, '').trim();
    if (t) return t;
  }
  const text = Object.entries(def.fields).find(([k, f]) => f.type.kind === 'scalar' && (f.type.name === 'Text' || f.type.name === 'PersonName') && values[k]);
  return text ? String(values[text[0]]) : id;
}

/** A record's ref (title and status) read as the system; undefined when it doesn't exist. */
export async function recordRef(db: Queryable, def: EntityTypeDef, key: string, id: string): Promise<RecordRef | undefined> {
  const cols = entityColumns(def);
  const { rows } = await db.query(
    `select id, lifecycle${cols.length ? `, ${cols.map((c) => `${q(c.column)}::text as ${q(c.column)}`).join(', ')}` : ''} from ${tableOf(def)} where id = $1`, [id]);
  const r = rows[0];
  if (!r) return undefined;
  const values: Record<string, unknown> = {};
  for (const c of cols) if (r[c.column] !== null && r[c.column] !== undefined) values[c.field] = r[c.column];
  return { entity: key, id, title: titleOf(def, id, values), ...(r.lifecycle ? { status: r.lifecycle } : {}) };
}
