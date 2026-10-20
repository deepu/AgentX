// kernel.records (24 §6, §12): records as people and the kernel see and change them. Writes by
// people check their role in the record's domain, refuse fields the domain doesn't own, and need
// a reason for controlled fields in a regulated domain; everything runs under the actor, so row
// rules and field access apply. Pages, the tree and dashboards are in page.ts and browse.ts.
import {
  ConditionCompileError, evaluateCondition, PgEntityEvents, PgEntityStore, PgFlagStore, PgNoteStore, PgViewStore,
  RecordWriteError, withActor, withRecordContext, withTransaction,
} from '@memwise/db';
import { keyOf, rolesIn, type EntityTypeDef, type ViewDef } from '@memwise/defs';
import { fieldErrors } from '../domain-tools.ts';
import type { Actor, RecordFlag, RecordQueryResult, RecordsService, RecordWriteResult } from '../types.ts';
import { buildDashboard, buildTree, columnsOf, queryRecords } from './browse.ts';
import { domainOfEntity, entityByName, isControlled, recordTitle, storeMentions, type RecordsDeps } from './context.ts';
import { checkTransition } from './lifecycle.ts';
import { buildPage } from './page.ts';

const entityStore = new PgEntityStore();
const notes = new PgNoteStore();
const flags = new PgFlagStore();
const views = new PgViewStore();
const events = new PgEntityEvents();

/** A store refusal as a write result, in its own words. */
export function writeRefusal(e: unknown): RecordWriteResult {
  if (e instanceof RecordWriteError) {
    const status = e.code === 'unknown-state' ? 'invalid' : e.code;
    return { applied: false, status, message: e.message, ...(e.fields?.length ? { errors: Object.fromEntries(e.fields.map((f) => [f, [e.message]])) } : {}) };
  }
  if (e instanceof ConditionCompileError) return { applied: false, status: 'invalid', message: e.message };
  throw e;
}

/** Whether a person may write records of a domain: a role there (any person, when the project has no roles). */
export function mayWrite(deps: RecordsDeps, actor: Actor, domain: string): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind !== 'person') return false;
  const roles = deps.project()?.roles;
  return !roles || !Object.keys(roles).length || rolesIn(actor, domain).length > 0;
}

/** The fields among `values` that need a reason (regulated domain, controlled), when none is given. */
function reasonMissing(deps: RecordsDeps, def: EntityTypeDef, values: Record<string, unknown>, reason: string | undefined, actor: Actor): string[] {
  if (actor.kind !== 'person' || reason?.trim()) return [];
  return Object.keys(values).filter((f) => isControlled(deps.project(), def, f));
}

export function createRecordsService(deps: RecordsDeps): RecordsService {
  const defOf = (entity: string, domain?: string): EntityTypeDef => {
    const def = entityByName(deps.entities(), entity, domain);
    if (!def) throw new Error(`there is no entity type ${entity}`);
    return def;
  };
  const changed = (def: EntityTypeDef, recordId?: string) => deps.emit({ kind: 'records', entity: keyOf(def), ...(recordId ? { recordId } : {}) });
  const forbidden = (def: EntityTypeDef): RecordWriteResult =>
    ({ applied: false, status: 'forbidden', message: `only someone with a role in ${deps.project()?.domains?.[domainOfEntity(def)]?.name ?? domainOfEntity(def)} can change a ${def.entity}` });

  /** Reads the record (under the actor) and checks they may see it. */
  async function visible(actor: Actor, def: EntityTypeDef, id: string) {
    return withActor(deps.pool, actor, (db) => entityStore.get(db, def, id));
  }

  const service: RecordsService = {
    page: (entity, id, actor, opts) => buildPage(deps, defOf(entity), id, actor, opts),

    async create(input, actor) {
      const def = defOf(input.entity);
      if (!mayWrite(deps, actor, domainOfEntity(def))) return forbidden(def);
      const errors = fieldErrors(def, deps.entities(), input.values, { creating: true });
      for (const [f, field] of Object.entries(def.fields)) {
        const v = input.values[f];
        if (field.required && (v === undefined || v === null || v === '')) (errors[f] ??= []).push('required');
      }
      if (Object.keys(errors).length) return { applied: false, status: 'invalid', errors, message: 'some values need fixing' };
      const missing = reasonMissing(deps, def, input.values, input.reason, actor);
      if (missing.length) return { applied: false, status: 'reason-required', message: `say why: ${missing.join(', ')} ${missing.length === 1 ? 'is a controlled field' : 'are controlled fields'} here` };
      try {
        const id = await withActor(deps.pool, actor, async (db) => {
          await withRecordContext(db, { via: 'app', ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
          return entityStore.create(db, def, input.values, {
            ...(input.status ? { lifecycle: input.status } : {}), ...(input.id ? { id: input.id } : {}),
          });
        });
        changed(def, id);
        return { applied: true, status: 'applied', id, version: 1 };
      } catch (e) {
        return writeRefusal(e);
      }
    },

    async update(input, actor) {
      const def = defOf(input.entity);
      if (!mayWrite(deps, actor, domainOfEntity(def))) return forbidden(def);
      const errors = fieldErrors(def, deps.entities(), input.values);
      if (Object.keys(errors).length) return { applied: false, status: 'invalid', errors, message: 'some values need fixing' };
      const missing = reasonMissing(deps, def, input.values, input.reason, actor);
      if (missing.length) return { applied: false, status: 'reason-required', message: `say why: ${missing.join(', ')} ${missing.length === 1 ? 'is a controlled field' : 'are controlled fields'} here` };
      try {
        const r = await withActor(deps.pool, actor, async (db) => {
          await withRecordContext(db, { via: 'app', ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
          return entityStore.update(db, def, input.id, input.values);
        });
        changed(def, input.id);
        return { applied: true, status: 'applied', id: input.id, version: r.version };
      } catch (e) {
        return writeRefusal(e);
      }
    },

    async transition(input, actor) {
      const def = defOf(input.entity);
      if (actor.kind === 'step') return { applied: false, status: 'forbidden', message: 'a step moves records with its entity tools' };
      try {
        return await withActor(deps.pool, actor, async (db) => {
          const mover = actor.kind === 'person' ? { kind: 'person' as const, actor } : { kind: 'system' as const };
          const check = await checkTransition(db, def, deps.entities(), deps.project(), input, mover);
          if (!check.ok) return { applied: false, status: check.status, message: check.message };
          await withRecordContext(db, { via: 'app', transition: input.transition, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
          const t = await entityStore.transition(db, def, input.id, { to: check.to, transition: input.transition, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
          changed(def, input.id);
          return { applied: true, status: 'applied', id: input.id, version: t.version } satisfies RecordWriteResult;
        });
      } catch (e) {
        return writeRefusal(e);
      }
    },

    query: (q, actor): Promise<RecordQueryResult> => queryRecords(deps, defOf(q.entity, q.domain), q, actor),

    tree: (domain, actor, opts) => buildTree(deps, service, domain, actor, opts),
    dashboard: (domain, pageId, params, actor) => buildDashboard(deps, service, domain, pageId, params, actor),

    async views(domain, actor, opts = {}) {
      const d = deps.project()?.domains?.[domain];
      const match = (v: ViewDef) => !opts.entity || v.entity === opts.entity || entityByName(deps.entities(), v.entity, domain) === entityByName(deps.entities(), opts.entity, domain);
      const shared = Object.values(d?.views ?? {}).filter(match).map((v) => ({ ...v, personal: false, domain }));
      const personal = actor.kind === 'person'
        ? (await views.listPersonal(deps.pool, actor.personId, domain)).filter(match).map((v) => ({ ...v, personal: true, domain }))
        : [];
      return [...shared, ...personal];
    },

    async saveView(domain, view, actor) {
      if (actor.kind !== 'person') throw new Error('only a person keeps personal views');
      const def = entityByName(deps.entities(), view.entity, domain);
      if (!def) throw new Error(`there is no entity type ${view.entity} in ${domain}`);
      if (deps.project()?.domains?.[domain]?.views[view.id]) throw new Error(`"${view.id}" is a shared view of ${domain}; save yours under another name`);
      const saved = await views.save(deps.pool, actor.personId, domain, view);
      deps.emit({ kind: 'records', entity: keyOf(def) });
      return saved;
    },

    async saveNote(input, actor) {
      const def = defOf(input.entity);
      if (actor.kind !== 'person' && actor.kind !== 'system') return { applied: false, status: 'forbidden', message: 'only a person writes notes' };
      if (!(await visible(actor, def, input.id))) return { applied: false, status: 'missing', message: `there is no ${def.entity} ${input.id}` };
      const by = actor.kind === 'person' ? actor.personId : 'system';
      const key = keyOf(def);
      const { version, label } = await withActor(deps.pool, actor, async (db) => {
        const v = await notes.save(db, key, input.id, input.body, by, input.reason?.trim() ? { reason: input.reason.trim() } : {});
        return { version: v, label: `Notes on ${recordTitle(def, input.id, (await entityStore.get(db, def, input.id))?.values ?? {})}` };
      });
      // `[[etmf.Site:site_…]]` tokens are mentions of those records, from this note.
      await withTransaction(deps.pool, (db) => storeMentions(db, deps.entities(), { kind: 'note', id: `${key}:${input.id}`, label }, input.body));
      changed(def, input.id);
      return { applied: true, status: 'applied', id: input.id, version };
    },

    async flags(filter): Promise<RecordFlag[]> {
      const entity = filter.entity ? keyOf(defOf(filter.entity, filter.domain)) : undefined;
      return flags.list(deps.pool, { ...(filter.domain ? { domain: filter.domain } : {}), ...(entity ? { entity } : {}),
        ...(filter.recordId ? { recordId: filter.recordId } : {}), ...(filter.open !== undefined ? { open: filter.open } : {}) });
    },

    async events(filter) {
      const entity = filter.entity ? keyOf(defOf(filter.entity)) : undefined;
      return events.after(deps.pool, filter.afterSeq ?? 0, Math.min(filter.limit ?? 200, 1000), {
        ...(entity ? { entity } : {}), ...(filter.recordId ? { recordId: filter.recordId } : {}),
      });
    },

    async evaluate(entity, id, condition, actor) {
      const def = defOf(entity);
      return withActor(deps.pool, actor, (db) => evaluateCondition(db, def, deps.entities(), id, condition));
    },
  };
  return service;
}

export { columnsOf };
