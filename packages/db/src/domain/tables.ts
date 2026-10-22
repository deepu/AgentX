/**
 * Domain tables (19 §3, D31; 24 §3): every entity type becomes a table in schema `domain`,
 * named `<domain>__<entity>`, with row rules, a read view in `domain_read` (field access,
 * calculated and followed fields) and a row trigger that writes record versions and entity
 * events, all generated from the definitions at index.
 *
 * Additive only: tables and columns are created when missing and never dropped or retyped, so
 * re-indexing an edited definition can't lose data. A field whose type changed keeps its old
 * column type (reported as a note). The one rename (Phase 2–5 `domain.<entity>` to
 * `domain.domain__<entity>`) happens once, in the same transaction.
 */
import { DEFAULT_DOMAIN, keyOf, splitEntityKey, type DomainDef, type EntityTypeDef, type ValueType, type WorkflowDef } from '@memwise/defs';
import crypto from 'node:crypto';
import type pg from 'pg';
import { APP_ROLE } from '../actor.ts';
import { quoteIdent } from '../cluster.ts';
import { withTransaction, type Queryable } from '../pool.ts';
import { backfillVersionsSql, compileReadViews, compileRecordTriggers, scopePredicate } from './records-sql.ts';

/** Columns every domain table has; a field may not use these names. */
export const SYSTEM_COLUMNS = ['id', 'lifecycle', 'created_at', 'updated_at', 'created_by_step', 'idempotency_key'] as const;

/**
 * Phase 6 columns every domain table also has (24 §3). A field with one of these names (a
 * Document's `version`) is stored in column `fld_<name>` instead, so older projects keep working.
 */
export const RECORD_COLUMNS = ['version', 'updated_by'] as const;

/**
 * Stage 3 (26 §3, D92): the project a row belongs to, on the table of every entity with
 * `scope: project` (the default). A field named `project` is stored in `fld_project`.
 */
export const PROJECT_COLUMN = 'project';

/** Whether an entity's records belong to one project (the default) or are shared by the app's projects. */
export const projectScoped = (def: Pick<EntityTypeDef, 'scope'>): boolean => def.scope !== 'app';

/** `ClientEngagement` -> `client_engagement`. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** An entity type, an entity key (`etmf.Site`), or a bare name (the default domain). */
export type EntityRef = Pick<EntityTypeDef, 'entity' | 'domain'> | string;

function partsOf(ref: EntityRef): { domain: string; entity: string } {
  if (typeof ref !== 'string') return { domain: ref.domain ?? DEFAULT_DOMAIN, entity: ref.entity };
  return splitEntityKey(ref);
}

/**
 * The table (and view) name of an entity type (24 §3): `<domain>__<snake(entity)>`, so
 * `etmf__site`, and `domain__customer` in the default domain (a bare string is the default domain).
 */
export function entityTableName(ref: EntityRef): string {
  const { domain, entity } = partsOf(ref);
  return `${domain}__${snake(entity)}`;
}

/** The id prefix of an entity's rows: `Customer` -> `cust`. */
export const entityIdPrefix = (entity: string) => (snake(entity).replace(/_/g, '').slice(0, 4) || 'ent');

/** The entity tools of an entity type (24 §3): `<domain>.<snake(entity)>.<verb>` (`domain.customer.create`, `etmf.site.get`). */
export function domainToolNames(ref: EntityRef): { create: string; get: string; update: string; transition: string; list: string } {
  const { domain, entity } = partsOf(ref);
  const base = `${domain}.${snake(entity)}`;
  return { create: `${base}.create`, get: `${base}.get`, update: `${base}.update`, transition: `${base}.transition`, list: `${base}.list` };
}

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
    let column = snake(field);
    if (!column) throw new Error(`${def.entity}: field "${field}" has no usable column name`);
    if ((SYSTEM_COLUMNS as readonly string[]).includes(column)) throw new Error(`${def.entity}: field "${field}" uses the reserved column name "${column}"`);
    if ((RECORD_COLUMNS as readonly string[]).includes(column) || column === PROJECT_COLUMN) column = `fld_${column}`;
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
/** `domain."etmf__site"` */
export const tableOf = (ref: EntityRef) => `domain.${q(entityTableName(ref))}`;
/** `domain_read."etmf__site"` */
export const viewOf = (ref: EntityRef) => `domain_read.${q(entityTableName(ref))}`;
const table = tableOf;

/** Lock key for schema changes, so two processes indexing at once don't race (D35). */
const DOMAIN_LOCK = 'memwise:domain-schema';

/**
 * Creates missing domain tables and columns. Returns notes about differences it left alone
 * (a column whose type no longer matches its field) and renames it made.
 */
export async function syncEntityTables(pool: pg.Pool, entities: Record<string, EntityTypeDef>): Promise<string[]> {
  return withTransaction(pool, async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [DOMAIN_LOCK]);
    return syncTablesIn(db, entities);
  });
}

const exists = async (db: Queryable, relation: string) =>
  !!(await db.query<{ r: string | null }>('select to_regclass($1)::text as r', [relation])).rows[0]?.r;

async function syncTablesIn(db: Queryable, entities: Record<string, EntityTypeDef>): Promise<string[]> {
  const notes: string[] = [];
  await db.query('create schema if not exists domain; create schema if not exists domain_read;');
  for (const def of Object.values(entities)) {
    const name = entityTableName(def);
    const t = table(def);
    // Phase 2–5 named the default domain's tables by entity alone (24 §3): rename once, keeping
    // rows, ids and indexes. The old view goes (it is made again under the new name).
    if ((def.domain ?? DEFAULT_DOMAIN) === DEFAULT_DOMAIN) {
      const old = snake(def.entity);
      if (await exists(db, `domain.${q(old)}`) && !(await exists(db, t))) {
        await db.query(`drop view if exists domain_read.${q(old)} cascade`);
        await db.query(`alter table domain.${q(old)} rename to ${q(name)}`);
        notes.push(`${def.entity}: table domain.${old} renamed to domain.${name}`);
      }
    }
    await db.query(`
      create table if not exists ${t} (
        id               text primary key,
        lifecycle        text,
        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),
        created_by_step  text,
        idempotency_key  text unique,
        version          int not null default 1,
        updated_by       text
      )`);
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_schema = 'domain' and table_name = $1`, [name]);
    const existing = new Map(rows.map((r) => [r.column_name, r.data_type]));
    // A table from before Phase 6 has no integer `version` (no field column is ever an integer):
    // a field stored in a column Phase 6 now takes moves to `fld_<name>`, then the record columns come.
    if (existing.get('version') !== 'integer') {
      for (const c of RECORD_COLUMNS) {
        if (existing.has(c) && !existing.has(`fld_${c}`)) {
          await db.query(`alter table ${t} rename column ${q(c)} to ${q(`fld_${c}`)}`);
          existing.set(`fld_${c}`, existing.get(c)!);
          existing.delete(c);
          notes.push(`${def.entity}: column ${name}.${c} renamed to fld_${c} (the record's own ${c} column takes its place)`);
        }
      }
      await db.query(`alter table ${t} add column if not exists version int not null default 1, add column if not exists updated_by text`);
    }
    // Stage 3: a field column named `project` (from before projects) moves to `fld_project`; then
    // the project column, filled with the domain's own project for rows written before it.
    if (existing.has(PROJECT_COLUMN) && !existing.has(`fld_${PROJECT_COLUMN}`) && entityColumns(def).some((c) => c.column === `fld_${PROJECT_COLUMN}`)) {
      await db.query(`alter table ${t} rename column ${q(PROJECT_COLUMN)} to ${q(`fld_${PROJECT_COLUMN}`)}`);
      existing.set(`fld_${PROJECT_COLUMN}`, existing.get(PROJECT_COLUMN)!);
      existing.delete(PROJECT_COLUMN);
      notes.push(`${def.entity}: column ${name}.project renamed to fld_project (the record's project column takes its place)`);
    }
    if (projectScoped(def) && !existing.has(PROJECT_COLUMN)) {
      const domain = def.domain ?? DEFAULT_DOMAIN;
      await db.query(`alter table ${t} add column ${q(PROJECT_COLUMN)} text`);
      await db.query(`update ${t} set ${q(PROJECT_COLUMN)} = ${lit(domain)} where ${q(PROJECT_COLUMN)} is null`);
      await db.query(`alter table ${t} alter column ${q(PROJECT_COLUMN)} set default mw.current_project(${lit(domain)}), alter column ${q(PROJECT_COLUMN)} set not null`);
      await db.query(`create index if not exists ${q(projectIndexName(def))} on ${t} (${q(PROJECT_COLUMN)})`);
      existing.set(PROJECT_COLUMN, 'text');
    }
    for (const c of entityColumns(def)) {
      const have = existing.get(c.column);
      if (have === undefined) {
        await db.query(`alter table ${t} add column if not exists ${q(c.column)} ${c.type}`);
      } else if (normalType(have) !== c.type) {
        notes.push(`${def.entity}.${c.field}: column ${name}.${c.column} is ${have}, the field now wants ${c.type}; left as it is`);
      }
    }
    notes.push(...(await syncKeyIndex(db, def)));
  }
  return notes;
}

/** Postgres keeps the first 63 bytes of a name. */
const PG_NAME_MAX = 63;

/**
 * The unique index on an entity's key columns (25 §3): `<table>__key`. A longer name keeps its
 * start and ends with a hash of the whole, so two long entity names that share a start don't
 * get the same index.
 */
export function keyIndexName(def: EntityRef): string {
  const full = `${entityTableName(def)}__key`;
  if (Buffer.byteLength(full) <= PG_NAME_MAX) return full;
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 10);
  let head = full.slice(0, PG_NAME_MAX - hash.length - 1);
  while (Buffer.byteLength(head) > PG_NAME_MAX - hash.length - 1) head = head.slice(0, -1);
  return `${head}_${hash}`;
}

/** The index on a project-scoped table's project column: `<table>__project`, shortened like `keyIndexName`. */
export function projectIndexName(def: EntityRef): string {
  return keyIndexName(def).replace(/__key$/, '__project').replace(/(_[0-9a-f]{10})$/, (h) => `p${h}`);
}

/** The columns of an entity's key (25 §3), in the key's order; empty when it has none. */
export function keyColumns(def: EntityTypeDef): EntityColumn[] {
  const byField = new Map(entityColumns(def).map((c) => [c.field, c]));
  return (def.key ?? []).map((f) => byField.get(f)).filter((c): c is EntityColumn => !!c);
}

/**
 * Makes the key's unique index match the definition: created when missing, made again when the
 * key changed, dropped when the key was removed. Rows that already break a new key leave it
 * unenforced, with a note (in a savepoint, so the rest of the sync goes on).
 */
async function syncKeyIndex(db: Queryable, def: EntityTypeDef): Promise<string[]> {
  const index = keyIndexName(def);
  const cols = keyColumns(def);
  const { rows } = await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'domain' and indexname = $1`, [index]);
  const want = cols.length ? `(${cols.map((c) => q(c.column)).join(', ')})` : undefined;
  const have = rows[0]?.indexdef;
  // `pg_indexes` quotes only the names that need it; compare without quotes.
  const bare = (sql: string) => sql.replace(/"/g, '');
  if (have && want && bare(have).endsWith(bare(want))) return [];
  if (have) await db.query(`drop index domain.${q(index)}`);
  if (!want) return [];
  await db.query('savepoint mw_key_index');
  try {
    await db.query(`create unique index ${q(index)} on ${table(def)} ${want}`);
    await db.query('release savepoint mw_key_index');
    return [];
  } catch (e) {
    await db.query('rollback to savepoint mw_key_index');
    if ((e as { code?: string }).code !== '23505') throw e;
    return [`${def.entity}: key (${(def.key ?? []).join(', ')}) not enforced: some records share a key; give them different values and index again`];
  }
}

const normalType = (dataType: string) => (dataType === 'timestamp with time zone' ? 'timestamptz' : dataType);

export interface RlsOptions {
  /**
   * Per entity type (by entity key), the steps (`<workflowId>/<stepId>`) whose step tokens may
   * insert rows. Absent: any step token may (its rows are still stamped with its own step run).
   * See `domainCreators`.
   */
  creators?: Record<string, string[]>;
  /**
   * Phase 6: per entity key, the steps whose step tokens may update rows (the `.update` and
   * `.transition` tools; see `domainUpdaters`). Absent: any step token may.
   */
  updaters?: Record<string, string[]>;
}

/** Phase 6: the domains by id (regulated mode, 24 §9). */
export type DomainSchemaOptions = RlsOptions & { domains?: Record<string, DomainDef> };

/** Steps whose tools allow `<domain>.<entity>.create`, per entity key, for `RlsOptions.creators`. */
export function domainCreators(entities: Record<string, EntityTypeDef>, workflows: Record<string, WorkflowDef>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const def of Object.values(entities)) {
    const tool = domainToolNames(def).create;
    const key = keyOf(def);
    out[key] = [];
    for (const wf of Object.values(workflows)) {
      for (const step of Object.values(wf.steps)) {
        if (step.tools.allowed.includes(tool) || step.tools.required.includes(tool)) out[key]!.push(`${wf.id}/${step.id}`);
      }
    }
  }
  return out;
}

/** Steps whose tools allow `<domain>.<entity>.update` or `.transition`, per entity key, for `RlsOptions.updaters`. */
export function domainUpdaters(entities: Record<string, EntityTypeDef>, workflows: Record<string, WorkflowDef>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const def of Object.values(entities)) {
    const names = domainToolNames(def);
    const key = keyOf(def);
    out[key] = [];
    for (const wf of Object.values(workflows)) {
      for (const step of Object.values(wf.steps)) {
        const tools = [...step.tools.allowed, ...step.tools.required];
        if (tools.includes(names.update) || tools.includes(names.transition)) out[key]!.push(`${wf.id}/${step.id}`);
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
 * may insert rows stamped with its own step run (and, with `creators`, only from those steps)
 * and update rows (with `updaters`, only from those steps).
 * Nobody but the owner may delete. A person whose grants in the domain are all scoped sees and
 * writes only rows inside the scope (24 §2), and (Stage 3, D92) a person with grants limited to
 * some projects of the domain sees and writes only those projects' rows. Fields with `access: [roles]` are readable only
 * through `domain_read.<table>`, which nulls them for actors without one of the roles (a
 * workspace-wide role or a grant in the entity's domain) and lists them in `_hidden`; the view
 * also holds calculated and followed fields.
 */
export function compileRls(entities: Record<string, EntityTypeDef>, opts: DomainSchemaOptions = {}): string[] {
  const sql: string[] = [];
  const app = q(APP_ROLE);
  for (const [t, col] of CASE_SCOPED) {
    sql.push(
      `alter table ${t} enable row level security`,
      `drop policy if exists mw_person_all on ${t}`,
      // Stage 3 (D92): only in the projects the person can see.
      `create policy mw_person_all on ${t} for all to ${app} using (mw.actor_kind() = 'person' and mw.project_visible(project)) with check (mw.actor_kind() = 'person' and mw.project_visible(project))`,
      `drop policy if exists mw_step_own_case on ${t}`,
      `create policy mw_step_own_case on ${t} for all to ${app}` +
        ` using (mw.actor_kind() = 'step' and ${col} = mw.token_case())` +
        ` with check (mw.actor_kind() = 'step' and ${col} = mw.token_case())`,
    );
  }

  for (const def of Object.values(entities)) {
    const t = table(def);
    const cols = entityColumns(def);
    const key = keyOf(def);
    const stepOf = `((nullif(current_setting('mw.step_token', true), '')::jsonb ->> 'workflowId') || '/' || (nullif(current_setting('mw.step_token', true), '')::jsonb ->> 'stepId'))`;
    const creators = opts.creators?.[key] ?? opts.creators?.[def.entity];
    const stepInsert = `mw.actor_kind() = 'step' and created_by_step = mw.token_step_run()` +
      (creators ? ` and ${creators.length ? `${stepOf} = any (array[${creators.map(lit).join(', ')}]::text[])` : 'false'}` : '');
    const updaters = opts.updaters?.[key];
    const stepUpdate = `mw.actor_kind() = 'step'` +
      (updaters ? ` and ${updaters.length ? `${stepOf} = any (array[${updaters.map(lit).join(', ')}]::text[])` : 'false'}` : '');
    const scope = scopePredicate(def, entities, '');
    const andScope = scope ? ` and ${scope}` : '';

    sql.push(
      `alter table ${t} enable row level security`,
      `drop policy if exists domain_read on ${t}`,
      `create policy domain_read on ${t} for select to ${app} using (mw.actor_kind() in ('person', 'step')${andScope})`,
      `drop policy if exists domain_person_insert on ${t}`,
      `create policy domain_person_insert on ${t} for insert to ${app} with check (mw.actor_kind() = 'person'${andScope})`,
      `drop policy if exists domain_step_insert on ${t}`,
      `create policy domain_step_insert on ${t} for insert to ${app} with check (${stepInsert})`,
      `drop policy if exists domain_person_update on ${t}`,
      `create policy domain_person_update on ${t} for update to ${app} using (mw.actor_kind() = 'person'${andScope}) with check (mw.actor_kind() = 'person'${andScope})`,
      `drop policy if exists domain_step_update on ${t}`,
      `create policy domain_step_update on ${t} for update to ${app} using (${stepUpdate}) with check (${stepUpdate})`,
      // Restricted fields are not selectable on the table itself, only through the view. No
      // delete for anyone but the owner (24 §9).
      `revoke all on ${t} from ${app}`,
      `grant insert, update on ${t} to ${app}`,
      `grant select (${[...SYSTEM_COLUMNS, ...RECORD_COLUMNS, ...(projectScoped(def) ? [PROJECT_COLUMN] : []), ...cols.filter((c) => !c.access).map((c) => c.column)].map(q).join(', ')}) on ${t} to ${app}`,
    );
  }
  sql.push(...compileReadViews(entities, opts));
  return sql;
}

/**
 * Tables, rules, views and row triggers in one transaction; rows written before Phase 6 get
 * their first version ("recorded before version history"). Returns the notes from the sync.
 */
export async function applyDomainSchema(pool: pg.Pool, entities: Record<string, EntityTypeDef>, opts: DomainSchemaOptions = {}): Promise<string[]> {
  return withTransaction(pool, async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [DOMAIN_LOCK]);
    const notes = await syncTablesIn(db, entities);
    for (const stmt of compileRls(entities, opts)) await db.query(stmt);
    for (const stmt of compileRecordTriggers(entities, opts)) await db.query(stmt);
    for (const stmt of backfillVersionsSql(entities)) await db.query(stmt);
    return notes;
  });
}
