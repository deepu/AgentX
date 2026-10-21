// The page tree and dashboards (24 §6). The tree: records of the entity types others name as
// their parent at the top, then under each record its children grouped by entity type ("Sites ·
// 7"; a group of more than 25 opens a view instead), and free pages where they hang. A dashboard
// is computed now, in SQL, under the viewer's row rules.
import { PgEntityStore, PgPageStore, withActor, type Queryable } from '@memwise/db';
import { keyOf, type DashboardBlock, type DashboardValue, type EntityTypeDef, type FreePageDef, type ViewDef } from '@memwise/defs';
import type { Actor, DashboardData, RecordQuery, RecordQueryResult, RecordRef, RecordsService, TreeNode } from '../types.ts';
import { domainDef, domainOfEntity, entityByName, recordTitle, refEntity, type RecordsDeps } from './context.ts';

const entityStore = new PgEntityStore();
const writtenPages = new PgPageStore();

/** A group of more than this many records is one tree entry that opens a view. */
export const TREE_GROUP_LIMIT = 25;

/** Runs a records query under the actor, with `params.<x>` values for its filter. */
export async function queryRecords(deps: RecordsDeps, def: EntityTypeDef, q: Omit<RecordQuery, 'entity' | 'domain'>, actor: Actor,
  params: Record<string, unknown> = {}, db?: Queryable): Promise<RecordQueryResult> {
  const entities = deps.entities();
  const run = async (c: Queryable) => {
    const r = await entityStore.query(c, def, entities, {
      ...(q.filter ? { filter: q.filter } : {}), ...(q.sort ? { sort: q.sort } : {}), ...(q.group ? { group: q.group } : {}),
      ...(q.columns ? { columns: q.columns } : {}), limit: Math.min(q.limit ?? 100, 1000), offset: q.offset ?? 0,
      ...(Object.keys(params).length ? { params } : {}),
    });
    // The records the rows (and the groups, when grouped by a reference) point at, by title.
    const titles = new Map<string, RecordRef | null>();
    const refTo = async (field: string, id: unknown): Promise<RecordRef | undefined> => {
      const target = refEntity(entities, def, field);
      if (!target || typeof id !== 'string' || !id) return undefined;
      const k = `${keyOf(target)}:${id}`;
      if (!titles.has(k)) {
        const row = await entityStore.get(c, target, id);
        titles.set(k, row ? { entity: keyOf(target), id, title: recordTitle(target, id, { ...row.values, ...(row.lifecycle ? { status: row.lifecycle } : {}) }) } : null);
      }
      return titles.get(k) ?? undefined;
    };
    const refs: Record<string, RecordRef>[] = [];
    for (const row of r.rows) {
      const out: Record<string, RecordRef> = {};
      for (const [field, v] of Object.entries(row.values)) {
        const ref = await refTo(field, v);
        if (ref) out[field] = ref;
      }
      refs.push(out);
    }
    const groups = r.groups && q.group
      ? await Promise.all(r.groups.map(async (g) => {
        const ref = await refTo(q.group!, g.key);
        return { ...g, ...(ref ? { title: ref.title } : {}) };
      }))
      : r.groups;
    return { ...r, refs, ...(groups ? { groups } : {}) };
  };
  const r = db ? await run(db) : await withActor(deps.pool, actor, run);
  return {
    entity: keyOf(def),
    columns: columnsOf(def, q.columns),
    rows: r.rows.map((row, i) => ({
      entity: keyOf(def), id: row.id, title: recordTitle(def, row.id, row.values), ...(row.lifecycle ? { status: row.lifecycle } : {}),
      values: row.values, hidden: row.hidden, ...(Object.keys(r.refs[i]!).length ? { refs: r.refs[i]! } : {}),
    })),
    total: r.total,
    ...(r.groups ? { groups: r.groups } : {}),
  };
}

/** The entity type a child type hangs under (its `parent` relationship's target). */
function parentOf(entities: Record<string, EntityTypeDef>, def: EntityTypeDef): EntityTypeDef | undefined {
  return def.parent ? refEntity(entities, def, def.parent) : undefined;
}

/** Plural label for a group: "Sites", "Expected documents". */
export function groupLabel(def: EntityTypeDef): string {
  const words = def.entity.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const plural = /(s|x|ch|sh)$/.test(words) ? `${words}es` : /[^aeiou]y$/.test(words) ? `${words.slice(0, -1)}ies` : `${words}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/** Binds a free page's `Ref<Entity>` params from the record it hangs under. */
function boundParams(entities: Record<string, EntityTypeDef>, page: FreePageDef, domain: string, record?: { def: EntityTypeDef; id: string }): Record<string, string> {
  const out: Record<string, string> = {};
  if (!record) return out;
  for (const [name, type] of Object.entries(page.params)) {
    const m = /^Ref<\s*([^>]+?)\s*>$/.exec(type);
    if (m && entityByName(entities, m[1]!, domain) === record.def) out[name] = record.id;
  }
  return out;
}

export async function buildTree(deps: RecordsDeps, _service: RecordsService, domain: string, actor: Actor,
  opts: { parent?: { entity: string; id: string } } = {}): Promise<TreeNode[]> {
  const entities = deps.entities();
  const d = domainDef(deps.project(), domain);
  const mine = Object.values(entities).filter((e) => domainOfEntity(e) === domain);
  const childrenOf = (def: EntityTypeDef) => mine.filter((e) => parentOf(entities, e) === def);
  const freePages = Object.values(d.pages);
  const pagesUnder = (def: EntityTypeDef) => freePages.filter((p) => p.under && entityByName(entities, p.under.entity, domain) === def);
  const hasChildren = (def: EntityTypeDef) => childrenOf(def).length > 0 || pagesUnder(def).length > 0;

  return withActor(deps.pool, actor, async (db) => {
    const written = await writtenPages.list(db, domain);
    const out: TreeNode[] = [];
    const recordNodes = (def: EntityTypeDef, r: RecordQueryResult): TreeNode[] => r.rows.map((row) => ({
      kind: 'record', entity: keyOf(def), id: row.id, title: row.title, ...(row.status ? { status: row.status } : {}), hasChildren: hasChildren(def),
    }));

    if (!opts.parent) {
      // Top: the records of every root type (no parent, but something hangs under it), then the
      // types that stand alone as groups, then the domain's own pages.
      const roots = mine.filter((e) => !parentOf(entities, e) && childrenOf(e).length > 0);
      const loose = mine.filter((e) => !parentOf(entities, e) && childrenOf(e).length === 0);
      for (const def of roots) {
        const r = await queryRecords(deps, def, { limit: TREE_GROUP_LIMIT + 1 }, actor, {}, db);
        if (r.total > TREE_GROUP_LIMIT) out.push({ kind: 'group', entity: keyOf(def), title: groupLabel(def), count: r.total, viewFilter: '' });
        else out.push(...recordNodes(def, r));
      }
      for (const def of loose) {
        const r = await queryRecords(deps, def, { limit: 1 }, actor, {}, db);
        if (r.total) out.push({ kind: 'group', entity: keyOf(def), title: groupLabel(def), count: r.total, viewFilter: '' });
      }
      for (const p of freePages) if (!p.under) out.push({ kind: 'page', pageId: p.id, title: p.title, params: {} });
      for (const p of written) if (!p.under) out.push({ kind: 'page', pageId: p.id, title: p.title, params: {} });
      return out;
    }

    const parentDef = entityByName(entities, opts.parent.entity, domain);
    if (!parentDef) throw new Error(`there is no entity type ${opts.parent.entity} in ${d.name}`);
    const parent = { entity: keyOf(parentDef), id: opts.parent.id };
    for (const p of pagesUnder(parentDef)) {
      out.push({ kind: 'page', pageId: p.id, title: p.title, params: boundParams(entities, p, domain, { def: parentDef, id: parent.id }) });
    }
    for (const p of written) {
      if (p.under && entityByName(entities, p.under.entity, domain) === parentDef && (!p.under.id || p.under.id === parent.id)) {
        out.push({ kind: 'page', pageId: p.id, title: p.title, params: {} });
      }
    }
    for (const child of childrenOf(parentDef)) {
      const filter = `${child.parent} = params.parent`;
      const r = await queryRecords(deps, child, { filter, limit: TREE_GROUP_LIMIT + 1 }, actor, { parent: parent.id }, db);
      if (!r.total) continue;
      const viewFilter = `${child.parent} = '${parent.id.replace(/'/g, "''")}'`;
      if (r.total > TREE_GROUP_LIMIT) {
        out.push({ kind: 'group', entity: keyOf(child), parent, title: groupLabel(child), count: r.total, viewFilter });
      } else {
        out.push({ kind: 'group', entity: keyOf(child), parent, title: groupLabel(child), count: r.total });
        out.push(...recordNodes(child, r));
      }
    }
    return out;
  });
}

const AGGREGATE_KINDS = ['count', 'percent', 'sum', 'avg'] as const;

function aggregateOf(v: DashboardValue): { kind: typeof AGGREGATE_KINDS[number]; entity: string; field?: string; where?: string; of?: string } {
  const kind = AGGREGATE_KINDS.find((k) => k in v)!;
  const entity = (v as Record<string, string>)[kind]!;
  const o = v as { field?: string; where?: string; of?: string };
  return { kind, entity, ...(o.field ? { field: o.field } : {}), ...(o.where ? { where: o.where } : {}), ...(o.of ? { of: o.of } : {}) };
}

/** `"{site_number} · {name}"` with a record's values (the record's title when it has none). */
function labelOf(template: string | undefined, def: EntityTypeDef, id: string, values: Record<string, unknown>): string {
  if (!template) return recordTitle(def, id, values);
  return recordTitle({ ...def, title: template }, id, values);
}

/**
 * A view's filter on a dashboard: its own, narrowed by each page parameter that names one of the
 * entity's fields (a "Missing documents" view on a study's page shows that study's).
 */
function scopedFilter(def: EntityTypeDef, filter: string | undefined, params: Record<string, string>): string | undefined {
  const parts = filter ? [`(${filter})`] : [];
  for (const name of Object.keys(params)) {
    if (name in def.fields || def.relationships[name]?.cardinality === 'one') parts.push(`${name} = params.${name}`);
  }
  return parts.length ? parts.join(' and ') : undefined;
}

export async function buildDashboard(deps: RecordsDeps, _service: RecordsService, domain: string, pageId: string, params: Record<string, string>,
  actor: Actor): Promise<DashboardData> {
  const entities = deps.entities();
  const d = domainDef(deps.project(), domain);
  const page = d.pages[pageId];
  if (!page) throw new Error(`${d.name} has no page ${pageId}`);
  const missing = Object.keys(page.params).filter((p) => !params[p]);
  if (missing.length) throw new Error(`the page "${page.title}" needs ${missing.join(', ')}`);
  const bound: Record<string, string> = Object.fromEntries(Object.keys(page.params).map((p) => [p, params[p]!]));
  const defOf = (name: string) => {
    const def = entityByName(entities, name, domain);
    if (!def) throw new Error(`the page "${page.title}" names an entity type ${name} that ${d.name} doesn't have`);
    return def;
  };
  const viewOf = (v: string | Omit<ViewDef, 'id' | 'title'>): Omit<ViewDef, 'id' | 'title'> => {
    if (typeof v !== 'string') return v;
    const view = d.views[v];
    if (!view) throw new Error(`the page "${page.title}" shows a view ${v} that ${d.name} doesn't have`);
    return view;
  };

  const blocks = await withActor(deps.pool, actor, async (db) => {
    const out: DashboardData['blocks'] = [];
    for (const block of page.blocks as DashboardBlock[]) {
      if (block.kind === 'text') {
        out.push({ kind: 'text', markdown: block.markdown });
      } else if (block.kind === 'kpi') {
        const a = aggregateOf(block.value);
        const value = await entityStore.aggregate(db, defOf(a.entity), entities, {
          kind: a.kind, ...(a.field ? { field: a.field } : {}), ...(a.where ? { where: a.where } : {}), ...(a.of ? { of: a.of } : {}), params: bound,
        });
        const format = block.format ?? (a.kind === 'percent' ? 'percent' : 'number');
        out.push({ kind: 'kpi', label: block.label, value, ...(block.target !== undefined ? { target: block.target } : {}), format });
      } else if (block.kind === 'table' || block.kind === 'list') {
        const view = viewOf(block.view);
        const def = defOf(view.entity);
        const filter = scopedFilter(def, view.filter, bound);
        const result = await queryRecords(deps, def, {
          ...(filter ? { filter } : {}), ...(view.sort ? { sort: view.sort } : {}), ...(view.group ? { group: view.group } : {}),
          ...(view.columns ? { columns: view.columns } : {}), limit: block.kind === 'list' ? 20 : 100,
        }, actor, bound, db);
        out.push({ kind: block.kind, ...(block.title ? { title: block.title } : {}), result });
      } else if (block.kind === 'heatmap') {
        const def = defOf(block.rows.entity);
        const r = await queryRecords(deps, def, { ...(block.rows.where ? { filter: block.rows.where } : {}), limit: 200 }, actor, bound, db);
        out.push({
          kind: 'heatmap', ...(block.title ? { title: block.title } : {}),
          columns: block.columns.map((c) => c.label),
          rows: r.rows.map((row) => ({
            record: { entity: row.entity, id: row.id, title: labelOf(block.rows.label, def, row.id, row.values), ...(row.status ? { status: row.status } : {}) },
            values: block.columns.map((c) => {
              const v = row.values[c.value];
              return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
            }),
          })),
        });
      }
    }
    return out;
  });
  return {
    pageId: page.id, title: page.title, ...(page.description ? { description: page.description } : {}), params: bound,
    computedAt: new Date().toISOString(), blocks,
  };
}

/** The columns of a query result: the asked ones, else every field, calculated and followed field. */
export function columnsOf(def: EntityTypeDef, only?: string[]): RecordQueryResult['columns'] {
  const followed = Object.values(def.links ?? {}).flatMap((l) => l.follow);
  const all: RecordQueryResult['columns'] = [
    ...Object.entries(def.fields).map(([name, f]) => ({ name, type: f.typeSource })),
    ...Object.entries(def.relationships).filter(([n, r]) => r.cardinality === 'one' && !(n in def.fields)).map(([name, r]) => ({ name, type: `Ref<${r.target}>` })),
    ...Object.entries(def.calculated ?? {}).map(([name, c]) => ({ name, type: c.kind === 'rollup' && c.rollup === 'percent' ? 'Percentage' : 'Number', calculated: true })),
    ...followed.map((name) => ({ name, type: 'Text', followed: true })),
  ];
  return only?.length ? only.map((n) => all.find((c) => c.name === n) ?? { name: n, type: n === 'status' ? 'Lifecycle' : 'Text' }) : all;
}
