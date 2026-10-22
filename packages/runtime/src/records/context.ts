// What every records module shares (24 §2–§6): entity types by key, their domains, record
// titles, the reasons step writes carry, and plain-words wording of conditions and values.
import {
  DEFAULT_DOMAIN, defaultDomainName, keyOf, resolveEntity, splitEntityKey, type DomainDef, type EntityTypeDef, type FieldDef,
  type ProjectDefs, type StepToken, type WorkflowDef,
} from '@memwise/defs';
import { mentionTokens, PgMentionStore, type MentionSourceKind, type Queryable } from '@memwise/db';
import type pg from 'pg';
import type { KernelChange } from '../types.ts';
import type { DefinitionCache } from '../views.ts';

export interface RecordsDeps {
  pool: pg.Pool;
  /** Entity types by entity key, as last indexed. */
  entities(): Record<string, EntityTypeDef>;
  /** The project as last indexed (domains, workspace, workflows), when the kernel has one. */
  project(): ProjectDefs | undefined;
  defs: DefinitionCache;
  people: import('@memwise/db').PgPeopleStore;
  files?: import('@memwise/db').PgFileStore;
  emit(change: KernelChange): void;
}

/** An entity type named by key, or bare within `domain` (default: the default domain). */
export function entityByName(entities: Record<string, EntityTypeDef>, name: string, domain: string = DEFAULT_DOMAIN): EntityTypeDef | undefined {
  return entities[name] ?? resolveEntity(entities, domain, name)
    ?? (name.includes('.') ? resolveEntity(entities, splitEntityKey(name).domain, splitEntityKey(name).entity) : undefined);
}

export const domainOfEntity = (def: Pick<EntityTypeDef, 'domain'>): string => def.domain ?? DEFAULT_DOMAIN;

/** The domain definition, or a plain stand-in for a project loaded without `domains`. */
export function domainDef(project: ProjectDefs | undefined, id: string): DomainDef {
  return project?.domains?.[id] ?? { id, name: defaultDomainName(id), dir: id === DEFAULT_DOMAIN ? 'domain' : `domains/${id}`, entities: [], workflows: [], pages: {}, views: {} };
}

export const isRegulated = (project: ProjectDefs | undefined, def: Pick<EntityTypeDef, 'domain'>): boolean =>
  !!project?.domains?.[domainOfEntity(def)]?.regulated;

/** Fields of a regulated domain need a reason to change unless they say `controlled: false`. */
export const isControlled = (project: ProjectDefs | undefined, def: EntityTypeDef, field: string): boolean =>
  isRegulated(project, def) && def.fields[field]?.controlled !== false;

/** Plain value for messages: `90`, `"filed"`, `not set`. */
export function plainValue(v: unknown): string {
  if (v === null || v === undefined) return 'not set';
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** "start_up_pack_complete is 90, sponsor_approved is not set" */
export const plainValues = (values: Record<string, unknown>) =>
  Object.entries(values).map(([k, v]) => `${k} is ${plainValue(v)}`).join(', ');

/** The first Text-like field, the default title source. */
export function firstTextField(def: EntityTypeDef): string | undefined {
  return Object.entries(def.fields).find(([, f]) => f.type.kind === 'scalar' && (f.type.name === 'Text' || f.type.name === 'PersonName'))?.[0]
    ?? Object.entries(def.fields).find(([, f]) => f.type.kind === 'identifier')?.[0];
}

/** How a record is named (24 §4): the `title:` template, else the first Text field, else the id. */
export function recordTitle(def: EntityTypeDef, id: string, values: Record<string, unknown>): string {
  if (def.title) {
    let missing = 0;
    const t = def.title.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = name === 'id' ? id : name === 'status' ? values.status : values[name];
      if (v === null || v === undefined || v === '') { missing++; return ''; }
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    const clean = t.replace(/^[\s·:|,–—-]+|[\s·:|,–—-]+$/g, '').trim();
    if (clean && missing < (def.title.match(/\{/g) ?? []).length) return clean;
  }
  const f = firstTextField(def);
  const v = f ? values[f] : undefined;
  return typeof v === 'string' && v.trim() ? v : id;
}

/** The type of a field as written, for the page. */
export const typeOf = (f: FieldDef | undefined) => f?.typeSource ?? 'Text';

/** The entity a Ref field points at, resolved in the field's entity's domain. */
export function refEntity(entities: Record<string, EntityTypeDef>, def: EntityTypeDef, field: string): EntityTypeDef | undefined {
  const f = def.fields[field];
  const domain = domainOfEntity(def);
  if (f?.type.kind === 'ref') return resolveEntity(entities, domain, f.type.entity);
  const rel = def.relationships[field];
  if (rel?.cardinality === 'one') return resolveEntity(entities, domain, rel.target);
  return undefined;
}

/**
 * A `many` relationship's target and the target's field pointing back (24 §4): `via`, else the
 * target's one Ref field (or `one` relationship) to this entity.
 */
export function inverseOf(entities: Record<string, EntityTypeDef>, def: EntityTypeDef, relationship: string): { target: EntityTypeDef; via: string } | undefined {
  const rel = def.relationships[relationship];
  if (rel?.cardinality !== 'many') return undefined;
  const target = resolveEntity(entities, domainOfEntity(def), rel.target);
  if (!target) return undefined;
  if (rel.via) return { target, via: rel.via };
  const back = [
    ...Object.entries(target.fields).filter(([, f]) => f.type.kind === 'ref' && resolveEntity(entities, domainOfEntity(target), f.type.entity) === def).map(([n]) => n),
    ...Object.entries(target.relationships).filter(([n, r]) => r.cardinality === 'one' && !(n in target.fields) && resolveEntity(entities, domainOfEntity(target), r.target) === def).map(([n]) => n),
  ];
  return back.length === 1 ? { target, via: back[0]! } : undefined;
}

/** "Fix a rejected document: Check the index, case case_…" (24 §3). */
export function stepReason(workflow: Pick<WorkflowDef, 'id' | 'title' | 'steps'>, stepId: string, caseId: string): string {
  const step = workflow.steps[stepId];
  return `${workflow.title ?? workflow.id}: ${step?.title ?? stepId}, case ${caseId}`;
}

/** The workflow a step token's run is pinned to. */
export async function workflowOfToken(deps: Pick<RecordsDeps, 'pool' | 'defs'>, token: StepToken): Promise<WorkflowDef | undefined> {
  const { rows } = await deps.pool.query('select workflow_id, workflow_hash from mw.runs where id = $1', [token.runId]);
  if (!rows[0]) return deps.defs.latest(token.workflowId);
  return deps.defs.workflow(rows[0].workflow_id, rows[0].workflow_hash).catch(() => undefined);
}

/**
 * Stores the `[[etmf.Site:site_…]]` mentions in a text (a note, a person's comment on a step) as
 * that source's mentions (24 §6). `db` is the kernel's own connection: the app role may not
 * update mentions, which the store's upsert needs.
 */
export async function storeMentions(db: Queryable, entities: Record<string, EntityTypeDef>,
  source: { kind: MentionSourceKind; id: string; label: string; caseId?: string; project?: string }, text: string): Promise<number> {
  const targets = mentionTokens(text).flatMap((t) => {
    const def = entityByName(entities, t.entity);
    return def ? [{ entity: keyOf(def), id: t.id, label: source.label, ...(source.caseId ? { caseId: source.caseId } : {}) }] : [];
  });
  // Stage 3: the mentions belong to the source's project (the column default reads `mw.project`).
  if (source.project) await db.query(`select set_config('mw.project', $1, true)`, [source.project]);
  await new PgMentionStore().replaceForSource(db, source.kind, source.id, targets);
  return targets.length;
}

export { keyOf };
