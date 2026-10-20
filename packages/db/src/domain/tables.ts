/**
 * Domain tables (19 §3, D31): every entity type becomes a table in schema `domain`, with row
 * rules and a field-access view in `domain_read`, generated from the definitions at index.
 *
 * Additive only: tables and columns are created when missing and never dropped or retyped, so
 * re-indexing an edited definition can't lose data. A field whose type changed keeps its old
 * column type (reported as a note).
 */
import type { EntityTypeDef, ValueType, WorkflowDef } from '@memwise/defs';
import type pg from 'pg';
import { APP_ROLE } from '../actor.ts';
import { quoteIdent } from '../cluster.ts';
import { withTransaction, type Queryable } from '../pool.ts';

/** Columns every domain table has; a field may not use these names. */
export const SYSTEM_COLUMNS = ['id', 'lifecycle', 'created_at', 'updated_at', 'created_by_step', 'idempotency_key'] as const;

/** `ClientEngagement` -> `client_engagement`. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** The table (and view) name of an entity type: `Customer` -> `customer`. */
export const entityTableName = (entity: string) => snake(entity);

/** The id prefix of an entity's rows: `Customer` -> `cust`. */
export const entityIdPrefix = (entity: string) => (snake(entity).replace(/_/g, '').slice(0, 4) || 'ent');

/** The domain tool names bound for an entity type (19 §3). */
export const domainToolNames = (entity: string) => ({
  create: `domain.${entityTableName(entity)}.create`,
  get: `domain.${entityTableName(entity)}.get`,
});

export type ColumnType = 'text' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'jsonb';

/** The column type of a value type. */
export function columnType(t: ValueType): ColumnType {
  switch (t.kind) {
    case 'identifier': case 'enum': case 'ref': return 'text';
    case 'quantity': case 'list': case 'named': return 'jsonb';
    case 'scalar':
      switch (t.name) {
        case 'Text': case 'PersonName': case 'Email': case 'Phone': return 'text';
        case 'Number': case 'Percentage': case 'Duration': return 'numeric';
        case 'Boolean': return 'boolean';
        case 'Date': return 'date';
        case 'DateTime': return 'timestamptz';
        default: return 'jsonb'; // Money, Address, File, Image, Document, TimeSeries
      }
  }
}

export interface EntityColumn {
  /** Field (or one-to-one relationship) name as written in the definition. */
  field: string;
  column: string;
  type: ColumnType;
  /** Roles that may see it; absent: everyone. */
  access?: string[];
}

/** The field columns of an entity: its fields, then each `one` relationship as a Ref column. */
export function entityColumns(def: EntityTypeDef): EntityColumn[] {
  const out: EntityColumn[] = [];
  const seen = new Map<string, string>();
  const add = (field: string, type: ColumnType, access?: string[]) => {
    const column = snake(field);
    if (!column) throw new Error(`${def.entity}: field "${field}" has no usable column name`);
    if ((SYSTEM_COLUMNS as readonly string[]).includes(column)) throw new Error(`${def.entity}: field "${field}" uses the reserved column name "${column}"`);
    const other = seen.get(column);
    if (other !== undefined) throw new Error(`${def.entity}: fields "${other}" and "${field}" both map to column "${column}"`);
    seen.set(column, field);
    out.push({ field, column, type, ...(access?.length ? { access } : {}) });
  };
  for (const [name, f] of Object.entries(def.fields)) add(name, columnType(f.type), f.access);
  for (const [name, rel] of Object.entries(def.relationships ?? {})) {
    if (rel.cardinality === 'one' && !(name in def.fields)) add(name, 'text');
  }
  return out;
}

const q = quoteIdent;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const table = (entity: string) => `domain.${q(entityTableName(entity))}`;
const view = (entity: string) => `domain_read.${q(entityTableName(entity))}`;

/** Lock key for schema changes, so two processes indexing at once don't race (D35). */
const DOMAIN_LOCK = 'memwise:domain-schema';

/**
 * Creates missing domain tables and columns. Returns notes about differences it left alone
 * (a column whose type no longer matches its field).
 */
export async function syncEntityTables(pool: pg.Pool, entities: Record<string, EntityTypeDef>): Promise<string[]> {
  return withTransaction(pool, async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [DOMAIN_LOCK]);
    return syncTablesIn(db, entities);
  });
}

async function syncTablesIn(db: Queryable, entities: Record<string, EntityTypeDef>): Promise<string[]> {
  const notes: string[] = [];
  await db.query('create schema if not exists domain; create schema if not exists domain_read;');
  for (const def of Object.values(entities)) {
    const name = entityTableName(def.entity);
    await db.query(`
      create table if not exists ${table(def.entity)} (
        id               text primary key,
        lifecycle        text,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        created_by_step  text,
        idempotency_key  text unique
      )`);
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_schema = 'domain' and table_name = $1`, [name]);
    const existing = new Map(rows.map((r) => [r.column_name, r.data_type]));
    for (const c of entityColumns(def)) {
      const have = existing.get(c.column);
      if (have === undefined) {
        await db.query(`alter table ${table(def.entity)} add column if not exists ${q(c.column)} ${c.type}`);
      } else if (normalType(have) !== c.type) {
        notes.push(`${def.entity}.${c.field}: column ${name}.${c.column} is ${have}, the field now wants ${c.type}; left as it is`);
      }
    }
  }
  return notes;
}

const normalType = (dataType: string) => (dataType === 'timestamp with time zone' ? 'timestamptz' : dataType);

export interface RlsOptions {
  /**
   * Per entity type, the steps (`<workflowId>/<stepId>`) whose step tokens may insert rows.
   * Absent: any step token may (its rows are still stamped with its own step run). See
   * `domainCreators`.
   */
  creators?: Record<string, string[]>;
}

/** Steps whose tools allow `domain.<entity>.create`, per entity type, for `RlsOptions.creators`. */
export function domainCreators(entities: Record<string, EntityTypeDef>, workflows: Record<string, WorkflowDef>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const def of Object.values(entities)) {
    const tool = domainToolNames(def.entity).create;
    out[def.entity] = [];
    for (const wf of Object.values(workflows)) {
      for (const step of Object.values(wf.steps)) {
        if (step.tools.allowed.includes(tool) || step.tools.required.includes(tool)) out[def.entity]!.push(`${wf.id}/${step.id}`);
      }
    }
  }
  return out;
}

/** The kernel tables a step token sees only for its own case, with the column naming the case. */
const CASE_SCOPED: [table: string, caseColumn: string][] = [['mw.cases', 'id'], ['mw.runs', 'case_id'], ['mw.step_runs', 'case_id']];

/**
 * The row and field rules as SQL statements, idempotent (each policy is dropped and created,
 * each view replaced). Kernel tables: a person sees every row, a step token only its own case.
 * Domain tables: people and step tokens may read; people may insert and update; a step token
 * may insert rows stamped with its own step run (and, with `creators`, only from those steps).
 * Fields with `access: [roles]` are readable only through `domain_read.<table>`, which nulls
 * them for actors without one of the roles and lists them in `_hidden`.
 */
export function compileRls(entities: Record<string, EntityTypeDef>, opts: RlsOptions = {}): string[] {
  const sql: string[] = [];
  const app = q(APP_ROLE);
  for (const [t, col] of CASE_SCOPED) {
    sql.push(
      `alter table ${t} enable row level security`,
      `drop policy if exists mw_person_all on ${t}`,
      `create policy mw_person_all on ${t} for all to ${app} using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person')`,
      `drop policy if exists mw_step_own_case on ${t}`,
      `create policy mw_step_own_case on ${t} for all to ${app}` +
        ` using (mw.actor_kind() = 'step' and ${col} = mw.token_case())` +
        ` with check (mw.actor_kind() = 'step' and ${col} = mw.token_case())`,
    );
  }

  for (const def of Object.values(entities)) {
    const t = table(def.entity);
    const cols = entityColumns(def);
    const stepOf = `((nullif(current_setting('mw.step_token', true), '')::jsonb ->> 'workflowId') || '/' || (nullif(current_setting('mw.step_token', true), '')::jsonb ->> 'stepId'))`;
    const creators = opts.creators?.[def.entity];
    const stepInsert = `mw.actor_kind() = 'step' and created_by_step = mw.token_step_run()` +
      (creators ? ` and ${creators.length ? `${stepOf} = any (array[${creators.map(lit).join(', ')}]::text[])` : 'false'}` : '');

    sql.push(
      `alter table ${t} enable row level security`,
      `drop policy if exists domain_read on ${t}`,
      `create policy domain_read on ${t} for select to ${app} using (mw.actor_kind() in ('person', 'step'))`,
      `drop policy if exists domain_person_insert on ${t}`,
      `create policy domain_person_insert on ${t} for insert to ${app} with check (mw.actor_kind() = 'person')`,
      `drop policy if exists domain_step_insert on ${t}`,
      `create policy domain_step_insert on ${t} for insert to ${app} with check (${stepInsert})`,
      `drop policy if exists domain_person_update on ${t}`,
      `create policy domain_person_update on ${t} for update to ${app} using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person')`,
      // Restricted fields are not selectable on the table itself, only through the view.
      `revoke all on ${t} from ${app}`,
      `grant insert, update on ${t} to ${app}`,
      `grant select (${[...SYSTEM_COLUMNS, ...cols.filter((c) => !c.access).map((c) => c.column)].map(q).join(', ')}) on ${t} to ${app}`,
    );

    const visible = (c: EntityColumn) => c.access!.map((r) => `mw.actor_has_role(${lit(r)})`).join(' or ');
    const select = [
      'id',
      ...cols.map((c) => (c.access ? `case when ${visible(c)} then ${q(c.column)} end as ${q(c.column)}` : q(c.column))),
      'lifecycle', 'created_at', 'updated_at', 'created_by_step',
      `array_remove(array[${cols.filter((c) => c.access).map((c) => `case when not (${visible(c)}) then ${lit(c.field)} end`).join(', ')}]::text[], null) as _hidden`,
    ];
    // Owner rights on purpose (no security_invoker): the view reads the restricted columns the
    // app role can't, and decides per actor. security_barrier keeps the actor's own predicates
    // from running before the nulling.
    sql.push(
      `drop view if exists ${view(def.entity)}`,
      `create view ${view(def.entity)} with (security_barrier = true) as select ${select.join(', ')} from ${t}`,
      `grant select on ${view(def.entity)} to ${app}`,
    );
  }
  return sql;
}

/** Tables, then rules, in one transaction. Returns the notes from `syncEntityTables`. */
export async function applyDomainSchema(pool: pg.Pool, entities: Record<string, EntityTypeDef>, opts: RlsOptions = {}): Promise<string[]> {
  return withTransaction(pool, async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [DOMAIN_LOCK]);
    const notes = await syncTablesIn(db, entities);
    for (const stmt of compileRls(entities, opts)) await db.query(stmt);
    return notes;
  });
}
