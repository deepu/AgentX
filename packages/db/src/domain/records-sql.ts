/**
 * SQL generated per domain table for Phase 6 (24 §3, §4, §7): the read views with field access,
 * calculated fields (rollups as correlated subqueries, row formulas) and followed link fields;
 * the record-scope predicate (24 §2); and the row trigger that stamps versions and server time,
 * refuses reasonless person edits in a regulated domain, and writes record versions and entity
 * events (including `changed` for the parents whose rollups a write affects) in the writing
 * transaction.
 */
import { keyOf, type EntityTypeDef } from '@memwise/defs';
import { APP_ROLE } from '../actor.ts';
import { quoteIdent as q } from '../cluster.ts';
import { compileConditionSource, literal, type ConditionContext, type ConditionType } from '../conditions.ts';
import {
  domainOfEntity, inverseOf, linkColumn, linkPairing, namesIn, recordColumns, targetOf, type RecordColumn,
} from './model.ts';
import {
  entityColumns, entityTableName, PROJECT_COLUMN, projectScoped, snake, tableOf, viewOf, type DomainSchemaOptions, type EntityColumn,
} from './tables.ts';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** How far `changed` events for rollups travel up (rollups of rollups). */
export const ROLLUP_EVENT_DEPTH = 5;

// ---------------------------------------------------------------- record scope (24 §2)

/**
 * The row's scope candidates by field name: its Ref and `one` columns, and the entity's own
 * snake name (`sponsor` on Sponsor) for its id, so a scope `{ sponsor: [...] }` also filters the
 * Sponsor table itself. Empty: the table is never filtered.
 */
export function scopePredicate(def: EntityTypeDef, entities: Record<string, EntityTypeDef>, alias: string): string {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const c of entityColumns(def)) {
    const f = def.fields[c.field];
    const isRef = f ? f.type.kind === 'ref' : def.relationships?.[c.field]?.cardinality === 'one';
    if (!isRef) continue;
    pairs.push(`${lit(c.field)}, ${alias}${q(c.column)}`);
    seen.add(c.field);
  }
  const own = snake(def.entity);
  if (!seen.has(own)) pairs.push(`${lit(own)}, ${alias}id`);
  void entities;
  // Stage 3 (D92): the row's project first, then the record scope of the grants in that project.
  const project = projectScoped(def) ? `${alias}${q(PROJECT_COLUMN)}` : 'null';
  return `mw.row_visible(${lit(domainOfEntity(def))}, ${project}, jsonb_build_object(${pairs.join(', ')}))`;
}

// ---------------------------------------------------------------- read views

interface ViewPlan {
  def: EntityTypeDef;
  columns: RecordColumn[];
  /** Entity keys whose views this one reads (rollups, links). */
  needs: string[];
}

/** Views in an order where each comes after the views it reads; a cycle is an error. */
function viewOrder(entities: Record<string, EntityTypeDef>): ViewPlan[] {
  const plans = new Map<string, ViewPlan>();
  for (const def of Object.values(entities)) {
    const needs = new Set<string>();
    for (const c of Object.values(def.calculated ?? {})) {
      if (c.kind !== 'rollup') continue;
      const inv = inverseOf(entities, def, c.of);
      if (inv) needs.add(keyOf(inv.child));
    }
    for (const [k, link] of Object.entries(def.links ?? {})) {
      const t = targetOf(entities, def, link.target || k);
      if (t) needs.add(keyOf(t));
    }
    needs.delete(keyOf(def));
    plans.set(keyOf(def), { def, columns: recordColumns(def, entities), needs: [...needs] });
  }
  const out: ViewPlan[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, path: string[]) => {
    const p = plans.get(key);
    if (!p || state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      throw new Error(`Calculated or followed fields go round in a circle: ${[...path, key].join(' → ')}`);
    }
    state.set(key, 'visiting');
    for (const n of p.needs) visit(n, [...path, key]);
    state.set(key, 'done');
    out.push(p);
  };
  for (const key of plans.keys()) visit(key, []);
  return out;
}

/** A context naming the columns of a read view under `alias` (rollup filters, queries). */
export function viewContext(columns: RecordColumn[], alias: string, param: (v: unknown) => string, paramValue?: (n: string) => unknown): ConditionContext {
  const byName = new Map(columns.map((c) => [c.name, c]));
  return {
    column: (n) => { const c = byName.get(n); return c ? `${alias}${q(c.column)}` : undefined; },
    type: (n) => byName.get(n)?.type,
    param,
    ...(paramValue ? { paramValue } : {}),
  };
}

const guard = (domain: string, access: string[]) => access.map((r) => `mw.actor_has_role_in(${lit(r)}, ${lit(domain)})`).join(' or ');

/**
 * `domain_read.<table>` for every entity: `drop … cascade` for all of them, then each `create`
 * after the views it reads. Owner rights on purpose (no security_invoker): the view reads the
 * restricted columns the app role can't, and decides per actor; it applies the record scope
 * itself. security_barrier keeps the actor's own predicates from running before the nulling.
 */
export function compileReadViews(entities: Record<string, EntityTypeDef>, _opts: DomainSchemaOptions = {}): string[] {
  const order = viewOrder(entities);
  const sql: string[] = order.map((p) => `drop view if exists ${viewOf(p.def)} cascade`);
  for (const plan of order) {
    sql.push(
      `create view ${viewOf(plan.def)} with (security_barrier = true) as ${viewSelect(plan, entities)}`,
      `grant select on ${viewOf(plan.def)} to ${q(APP_ROLE)}`,
    );
  }
  return sql;
}

function viewSelect(plan: ViewPlan, entities: Record<string, EntityTypeDef>): string {
  const { def, columns } = plan;
  const domain = domainOfEntity(def);
  const key = keyOf(def);
  const fieldCols = entityColumns(def);
  const byName = new Map(columns.map((c) => [c.name, c]));

  // Links: one lateral pick of the paired record, then the other domain's view.
  const joins: string[] = [];
  const linkAlias = new Map<string, number>();
  const linkIdCols: string[] = [];
  let n = 0;
  for (const [k, link] of Object.entries(def.links ?? {})) {
    const target = targetOf(entities, def, link.target || k);
    if (!target) continue;
    const i = ++n;
    linkAlias.set(keyOf(target), i);
    const { plugin, source } = linkPairing(keyOf(target));
    joins.push(
      `left join lateral (select l.external_id from mw.identity_links l where l.plugin = ${lit(plugin)} and l.source = ${lit(source)}` +
        ` and l.entity = ${lit(key)} and l.record_id = t.id order by l.at, l.id limit 1) l${i} on true`,
      `left join ${viewOf(target)} o${i} on o${i}.id = l${i}.external_id`,
    );
    linkIdCols.push(`l${i}.external_id as ${q(linkColumn(target))}`);
  }

  // Names inside the view: fields guarded, calculated inlined, followed from their join.
  const expanding: string[] = [];
  const exprOf = (name: string): string | undefined => {
    const c = byName.get(name);
    if (!c) return undefined;
    switch (c.kind) {
      case 'system': return `t.${q(c.column)}`;
      case 'field': return c.access ? `(case when ${guard(domain, c.access)} then t.${q(c.column)} end)` : `t.${q(c.column)}`;
      case 'followed': {
        const target = entities[c.link!.target] ?? Object.values(entities).find((e) => keyOf(e) === c.link!.target)!;
        const tcol = recordColumns(target, entities).find((x) => x.name === c.link!.field);
        return tcol ? `o${linkAlias.get(c.link!.target)}.${q(tcol.column)}` : 'null';
      }
      case 'calculated': {
        if (expanding.includes(name)) throw new Error(`${def.entity}: calculated field "${name}" uses itself (${[...expanding, name].join(' → ')})`);
        expanding.push(name);
        try {
          return calculatedExpr(def, entities, c, ctxHere);
        } finally {
          expanding.pop();
        }
      }
    }
  };
  const ctxHere: ConditionContext = { column: exprOf, type: (x) => byName.get(x)?.type, param: literal };

  const select: string[] = ['t.id'];
  for (const c of fieldCols) select.push(`${exprOf(c.field)} as ${q(c.column)}`);
  select.push('t.lifecycle', 't.created_at', 't.updated_at', 't.created_by_step', 't.version', 't.updated_by');
  // Stage 3: every view has `project` (null for records the app's projects share).
  select.push(projectScoped(def) ? `t.${q(PROJECT_COLUMN)}` : `null::text as ${q(PROJECT_COLUMN)}`);
  const hidden = [
    ...fieldCols.filter((c) => c.access).map((c) => `case when not (${guard(domain, c.access!)}) then ${lit(c.field)} end`),
    ...columns.filter((c) => c.kind === 'followed' && linkAlias.has(c.link!.target))
      .map((c) => `case when ${lit(c.link!.field)} = any (o${linkAlias.get(c.link!.target)}._hidden) then ${lit(c.name)} end`),
  ];
  select.push(`array_remove(array[${hidden.join(', ')}]::text[], null) as _hidden`);
  const names = new Set(select.map((s) => s.split(' as ').pop()!.replace(/^t\./, '').replace(/"/g, '')));
  for (const c of columns.filter((x) => x.kind === 'calculated' || x.kind === 'followed')) {
    if (names.has(c.column)) throw new Error(`${def.entity}: "${c.name}" has the same column name as another field (${c.column})`);
    names.add(c.column);
    select.push(`${exprOf(c.name) ?? 'null'} as ${q(c.column)}`);
  }
  select.push(...linkIdCols);

  return `select ${select.join(', ')} from ${tableOf(def)} t ${joins.join(' ')} where ${scopePredicate(def, entities, 't.')}`;
}

/** The SQL of one calculated field on row `t` (inside the view). */
function calculatedExpr(def: EntityTypeDef, entities: Record<string, EntityTypeDef>, c: RecordColumn, here: ConditionContext): string {
  const calc = c.calculated!;
  const where = (s: string) => `${s} — ${def.entity}.${c.name}`;
  if (calc.kind === 'formula') {
    try {
      return `(${compileConditionSource(calc.formula, here)})`;
    } catch (e) {
      throw new Error(where(`the formula "${calc.formula}" doesn't work: ${(e as Error).message}`));
    }
  }
  const inv = inverseOf(entities, def, calc.of);
  if (!inv) return 'null::numeric';
  const childCols = recordColumns(inv.child, entities);
  const r = viewContext(childCols, 'r.', literal);
  let filter = '';
  if (calc.where) {
    try {
      filter = compileConditionSource(calc.where, r);
    } catch (e) {
      throw new Error(where(`the filter "${calc.where}" doesn't work: ${(e as Error).message}`));
    }
  }
  const from = `from ${viewOf(inv.child)} r where r.${q(inv.column.column)} = t.id`;
  switch (calc.rollup) {
    case 'count':
      return `(select count(*)::int ${from}${filter ? ` and coalesce(${filter}, false)` : ''})`;
    case 'percent':
      return `(select case when count(*) = 0 then null else 100.0 * count(*) filter (where coalesce(${filter || 'true'}, false)) / count(*) end ${from})`;
    case 'sum': case 'min': case 'max': {
      const col = calc.field ? r.column(calc.field) : undefined;
      if (!col) throw new Error(where(`${calc.rollup} needs a field of ${inv.child.entity} (field: …)`));
      return `(select ${calc.rollup}(${col}) ${from}${filter ? ` and coalesce(${filter}, false)` : ''})`;
    }
  }
}

// ---------------------------------------------------------------- row triggers

/** The project of a parent record whose rollups changed (read from its table), or null for an app-scoped one. */
function projectOf(parent: EntityTypeDef, recordExpr: string): string {
  return projectScoped(parent) ? `(select p.${q(PROJECT_COLUMN)} from ${tableOf(parent)} p where p.id = ${recordExpr})` : 'null::text';
}

/** Values as JSON by field name (status = lifecycle), in chunks (jsonb_build_object takes 100 arguments). */
function valuesJson(def: EntityTypeDef, row: string): string {
  const pairs = [`'status', ${row}.lifecycle`, ...entityColumns(def).map((c) => `${lit(c.field)}, ${row}.${q(c.column)}`)];
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 40) chunks.push(`jsonb_build_object(${pairs.slice(i, i + 40).join(', ')})`);
  return chunks.join(' || ');
}

/** `array_remove(array[case when <changed> then 'field' end, …], null)` */
function changedArray(cols: { field: string; column: string }[], test: (column: string) => string): string {
  if (!cols.length) return `'{}'::text[]`;
  return `array_remove(array[${cols.map((c) => `case when ${test(c.column)} then ${lit(c.field)} end`).join(', ')}]::text[], null)`;
}

interface RollupLink {
  parent: EntityTypeDef;
  /** The child's column naming the parent. */
  inverse: EntityColumn;
  /** Rollups of the parent over this relationship, with the child names each one reads. */
  rollups: { name: string; deps: string[] }[];
}

/** Child names a name reads, formulas expanded to what they read. */
function expandDeps(def: EntityTypeDef, names: string[]): string[] {
  const out = new Set<string>();
  const walk = (n: string, depth: number) => {
    const calc = def.calculated?.[n];
    if (calc?.kind === 'formula' && depth < 10) { for (const m of namesIn(calc.formula)) walk(m, depth + 1); return; }
    out.add(n);
  };
  for (const n of names) walk(n, 0);
  return [...out];
}

/** For each entity key, the parents with rollups over it. */
function rollupLinks(entities: Record<string, EntityTypeDef>): Map<string, RollupLink[]> {
  const out = new Map<string, RollupLink[]>();
  for (const parent of Object.values(entities)) {
    const byRel = new Map<string, RollupLink & { childKey: string }>();
    for (const [name, c] of Object.entries(parent.calculated ?? {})) {
      if (c.kind !== 'rollup') continue;
      const inv = inverseOf(entities, parent, c.of);
      if (!inv) continue;
      const deps = expandDeps(inv.child, [...(c.field ? [c.field] : []), ...namesIn(c.where)]);
      const link = byRel.get(c.of) ?? { parent, inverse: inv.column, rollups: [], childKey: keyOf(inv.child) };
      link.rollups.push({ name, deps });
      byRel.set(c.of, link);
    }
    for (const { childKey, ...link } of byRel.values()) out.set(childKey, [...(out.get(childKey) ?? []), link]);
  }
  return out;
}

/** The parent's calculated fields that change when these do (formulas over them, transitively). */
function affected(def: EntityTypeDef, names: string[]): string[] {
  const out = new Set(names);
  for (let changed = true; changed;) {
    changed = false;
    for (const [n, c] of Object.entries(def.calculated ?? {})) {
      if (out.has(n) || c.kind !== 'formula') continue;
      if (namesIn(c.formula).some((m) => out.has(m))) { out.add(n); changed = true; }
    }
  }
  return [...out];
}

/**
 * The row trigger of every domain table (one plpgsql function per table, before and after
 * insert or update), recreated at each index. Runs with the owner's rights, so the app role
 * never needs (or gets) write access to the history tables.
 */
export function compileRecordTriggers(entities: Record<string, EntityTypeDef>, opts: DomainSchemaOptions = {}): string[] {
  const links = rollupLinks(entities);
  const sql: string[] = [];
  for (const def of Object.values(entities)) {
    const name = entityTableName(def);
    const fn = `domain.${q(`${name}__record`)}`;
    sql.push(
      `create or replace function ${fn}() returns trigger language plpgsql security definer set search_path = pg_catalog, mw as $mw_fn$\n${triggerBody(def, entities, links, opts)}\n$mw_fn$`,
      `drop trigger if exists ${q(`${name}__record_before`)} on ${tableOf(def)}`,
      `create trigger ${q(`${name}__record_before`)} before insert or update on ${tableOf(def)} for each row execute function ${fn}()`,
      `drop trigger if exists ${q(`${name}__record_after`)} on ${tableOf(def)}`,
      `create trigger ${q(`${name}__record_after`)} after insert or update on ${tableOf(def)} for each row execute function ${fn}()`,
    );
  }
  return sql;
}

function triggerBody(def: EntityTypeDef, entities: Record<string, EntityTypeDef>, links: Map<string, RollupLink[]>, opts: DomainSchemaOptions): string {
  const key = keyOf(def);
  const cols = entityColumns(def);
  const regulated = !!opts.domains?.[domainOfEntity(def)]?.regulated;
  const controlled = cols.filter((c) => def.fields[c.field]?.controlled !== false);
  const withStatus = [...cols, { field: 'status', column: 'lifecycle' }];
  // Stage 3: versions and events carry the record's project (null for app-scoped records).
  const own = projectScoped(def) ? `new.${q(PROJECT_COLUMN)}` : 'null::text';
  let counter = 0;
  const vars: string[] = [];

  // `changed` for a parent record, then up through rollups of rollups.
  const emit = (parent: EntityTypeDef, recordExpr: string, rollups: string[], depth: number): string => {
    const fields = affected(parent, rollups);
    let code = `perform mw.write_entity_event(${lit(keyOf(parent))}, ${recordExpr}, 'changed', jsonb_build_object('fields', ${lit(JSON.stringify(fields))}::jsonb), v_by, ${projectOf(parent, recordExpr)});\n`;
    if (depth >= ROLLUP_EVENT_DEPTH) return code;
    for (const up of links.get(keyOf(parent)) ?? []) {
      const hit = up.rollups.filter((r) => r.deps.some((d) => fields.includes(d))).map((r) => r.name);
      if (!hit.length) continue;
      const v = `v_up${++counter}`;
      vars.push(`${v} text;`);
      code += `select ${q(up.inverse.column)} into ${v} from ${tableOf(parent)} where id = ${recordExpr};\n` +
        `if ${v} is not null then\n${emit(up.parent, v, hit, depth + 1)}end if;\n`;
    }
    return code;
  };

  let rollupCode = '';
  for (const link of links.get(key) ?? []) {
    const inv = `${q(link.inverse.column)}`;
    const all = link.rollups.map((r) => r.name);
    const colOf = (dep: string) => dep === 'status' ? 'lifecycle' : cols.find((c) => c.field === dep)?.column;
    const depCols = [...new Set(link.rollups.flatMap((r) => r.deps.map(colOf).filter((c): c is string => !!c)))];
    const withDeps = link.rollups.filter((r) => r.deps.some((d) => colOf(d))).map((r) => r.name);
    rollupCode +=
      `-- ${link.parent.entity}: ${all.join(', ')}\n` +
      `if tg_op = 'INSERT' then\n  if new.${inv} is not null then\n${emit(link.parent, `new.${inv}`, all, 1)}  end if;\n` +
      `elsif old.${inv} is distinct from new.${inv} then\n` +
      `  if old.${inv} is not null then\n${emit(link.parent, `old.${inv}`, all, 1)}  end if;\n` +
      `  if new.${inv} is not null then\n${emit(link.parent, `new.${inv}`, all, 1)}  end if;\n` +
      (depCols.length
        ? `elsif new.${inv} is not null and (${depCols.map((c) => `old.${q(c)} is distinct from new.${q(c)}`).join(' or ')}) then\n${emit(link.parent, `new.${inv}`, withDeps, 1)}`
        : '') +
      `end if;\n`;
  }

  const reasonCheck = regulated && controlled.length ? `
    if mw.actor_kind() = 'person' and nullif(current_setting('mw.reason', true), '') is null then
      v_changed := ${changedArray(controlled, (c) => `old.${q(c)} is distinct from new.${q(c)}`)};
      if cardinality(v_changed) > 0 then
        raise exception 'reason-required: a change to % on % needs a reason', array_to_string(v_changed, ', '), ${lit(def.entity)}
          using errcode = 'MW001';
      end if;
    end if;` : '';

  const body = `
  if tg_when = 'BEFORE' then
    if tg_op = 'INSERT' then
      new.created_at := now();
      new.updated_at := now();
      new.version := 1;
      new.updated_by := v_by;
      return new;
    end if;
    -- Server time and versions are the database's: whatever the writer sent is replaced.
    new.created_at := old.created_at;
    new.updated_at := old.updated_at;
    new.version := old.version;
    new.updated_by := old.updated_by;
    if new is not distinct from old then
      return new;
    end if;${reasonCheck}
    new.version := old.version + 1;
    new.updated_at := now();
    new.updated_by := v_by;
    return new;
  end if;

  if tg_op = 'UPDATE' and new.version = old.version then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_changed := ${changedArray(withStatus, (c) => `new.${q(c)} is not null`)};
  else
    v_changed := ${changedArray(withStatus, (c) => `old.${q(c)} is distinct from new.${q(c)}`)};
  end if;
  perform mw.write_record_version(${lit(key)}, new.id, new.version, v_by, mw.record_via(), mw.record_reason(), ${valuesJson(def, 'new')}, v_changed, ${own});
  if tg_op = 'INSERT' then
    perform mw.write_entity_event(${lit(key)}, new.id, 'created', '{}'::jsonb, v_by, ${own});
    if new.lifecycle is not null then
      perform mw.write_entity_event(${lit(key)}, new.id, 'entered',
        jsonb_build_object('state', new.lifecycle, 'from', null, 'transition', nullif(current_setting('mw.transition', true), '')), v_by, ${own});
    end if;
  else
    perform mw.write_entity_event(${lit(key)}, new.id, 'changed', jsonb_build_object('fields', to_jsonb(v_changed)), v_by, ${own});
    if old.lifecycle is distinct from new.lifecycle then
      perform mw.write_entity_event(${lit(key)}, new.id, 'entered',
        jsonb_build_object('state', new.lifecycle, 'from', old.lifecycle, 'transition', nullif(current_setting('mw.transition', true), '')), v_by, ${own});
    end if;
  end if;
${rollupCode}
  return null;`;

  return `declare\n  v_by text := mw.record_by();\n  v_changed text[];\n  ${vars.join('\n  ')}\nbegin${body}\nend`;
}

/** First versions for rows written before Phase 6 (or with the trigger off): "recorded before version history". */
export function backfillVersionsSql(entities: Record<string, EntityTypeDef>): string[] {
  return Object.values(entities).map((def) => {
    const key = lit(keyOf(def));
    return `select mw.write_record_version(${key}, t.id, t.version, coalesce('step:' || t.created_by_step, 'system'), null,
      'recorded before version history', ${valuesJson(def, 't')}, '{}'::text[], ${projectScoped(def) ? `t.${q(PROJECT_COLUMN)}` : 'null::text'})
      from ${tableOf(def)} t
      where not exists (select 1 from mw.record_versions v where v.entity = ${key} and v.record_id = t.id)
      order by t.created_at, t.id`;
  });
}

export type { ConditionType };
