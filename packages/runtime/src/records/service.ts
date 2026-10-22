// kernel.records (24 §6, §12): records as people and the kernel see and change them. Writes by
// people check their role in the record's domain, refuse fields the domain doesn't own, and need
// a reason for controlled fields in a regulated domain; everything runs under the actor, so row
// rules and field access apply. Pages, the tree and dashboards are in page.ts and browse.ts.
import {
  ConditionCompileError, evaluateCondition, PgEntityEvents, PgEntityStore, PgFlagStore, PgNoteStore, PgViewStore,
  projectScoped, RecordWriteError, withActor, withRecordContext, withTransaction,
} from '@memwise/db';
import { hasRole, keyOf, rolesIn, type EntityTypeDef, type ViewDef } from '@memwise/defs';
import { fieldErrors } from '../domain-tools.ts';
import type { Actor, RecordFlag, RecordKeepResult, RecordQueryResult, RecordsService, RecordWriteResult } from '../types.ts';
import { buildDashboard, buildTree, columnsOf, queryRecords } from './browse.ts';
import { domainOfEntity, entityByName, isControlled, recordTitle, storeMentions, type RecordsDeps } from './context.ts';
import { checkTransition } from './lifecycle.ts';
import { buildPage } from './page.ts';
import { checkQuotes, quoteFields } from './quotes.ts';

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

/** Fields among `values` with an `access:` list the person holds none of: they can't read them, so they may not write them. */
function hiddenFrom(def: EntityTypeDef, values: Record<string, unknown>, actor: Actor): string[] {
  if (actor.kind !== 'person') return [];
  const domain = domainOfEntity(def);
  return Object.keys(values).filter((f) => {
    const access = def.fields[f]?.access;
    return !!access?.length && !access.some((r) => hasRole(actor, r, domain));
  });
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

  /** Quote fields (25 §4) checked after a write, as the system: whether each quote is in its source. */
  const checkQuotesOf = (def: EntityTypeDef, id: string): Promise<Record<string, boolean>> =>
    quoteFields(def).length ? withActor(deps.pool, { kind: 'system' }, (db) => checkQuotes(db, deps.entities(), def, id)) : Promise.resolve({});

  /** `create`, also saying whether each quote field's value is in its source. */
  async function createRecord(input: Parameters<RecordsService['create']>[0], actor: Actor): Promise<{ result: RecordWriteResult; quotes: Record<string, boolean> }> {
    const def = defOf(input.entity);
    if (!mayWrite(deps, actor, domainOfEntity(def))) return { result: forbidden(def), quotes: {} };
    const errors = fieldErrors(def, deps.entities(), input.values, { creating: true });
    for (const f of hiddenFrom(def, input.values, actor)) (errors[f] ??= []).push('only some roles may see or change this field');
    for (const [f, field] of Object.entries(def.fields)) {
      const v = input.values[f];
      if (field.required && (v === undefined || v === null || v === '')) (errors[f] ??= []).push('required');
    }
    if (Object.keys(errors).length) return { result: { applied: false, status: 'invalid', errors, message: 'some values need fixing' }, quotes: {} };
    const missing = reasonMissing(deps, def, input.values, input.reason, actor);
    if (missing.length) return { result: { applied: false, status: 'reason-required', message: `say why: ${missing.join(', ')} ${missing.length === 1 ? 'is a controlled field' : 'are controlled fields'} here` }, quotes: {} };
    try {
      const id = await withActor(deps.pool, actor, async (db) => {
        await withRecordContext(db, { via: 'app', ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}), ...(input.project ? { project: input.project } : {}) });
        return entityStore.create(db, def, input.values, {
          ...(input.status ? { lifecycle: input.status } : {}), ...(input.id ? { id: input.id } : {}),
          ...(input.project && projectScoped(def) ? { project: input.project } : {}),
        });
      });
      const quotes = await checkQuotesOf(def, id);
      changed(def, id);
      return { result: { applied: true, status: 'applied', id, version: 1 }, quotes };
    } catch (e) {
      return { result: writeRefusal(e), quotes: {} };
    }
  }

  const service: RecordsService = {
    page: (entity, id, actor, opts) => buildPage(deps, defOf(entity), id, actor, opts),

    async create(input, actor) {
      return (await createRecord(input, actor)).result;
    },

    async update(input, actor) {
      const def = defOf(input.entity);
      if (!mayWrite(deps, actor, domainOfEntity(def))) return forbidden(def);
      const errors = fieldErrors(def, deps.entities(), input.values);
      for (const f of hiddenFrom(def, input.values, actor)) (errors[f] ??= []).push('only some roles may see or change this field');
      if (Object.keys(errors).length) return { applied: false, status: 'invalid', errors, message: 'some values need fixing' };
      const missing = reasonMissing(deps, def, input.values, input.reason, actor);
      if (missing.length) return { applied: false, status: 'reason-required', message: `say why: ${missing.join(', ')} ${missing.length === 1 ? 'is a controlled field' : 'are controlled fields'} here` };
      try {
        const r = await withActor(deps.pool, actor, async (db) => {
          await withRecordContext(db, { via: 'app', ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
          return entityStore.update(db, def, input.id, input.values);
        });
        if (r.changed.length) await checkQuotesOf(def, input.id);
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
      // A view file names its entity as written ("Site"); callers match on the key ("etmf.Site").
      const keyed = (v: ViewDef): ViewDef => { const def = entityByName(deps.entities(), v.entity, domain); return def ? { ...v, entity: keyOf(def) } : v; };
      const shared = Object.values(d?.views ?? {}).filter(match).map((v) => ({ ...keyed(v), personal: false, domain }));
      const personal = actor.kind === 'person'
        ? (await views.listPersonal(deps.pool, actor.personId, domain)).filter(match).map((v) => ({ ...keyed(v), personal: true, domain }))
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
      const { version, label, project } = await withActor(deps.pool, actor, async (db) => {
        // Stage 3: the note belongs to the record's project.
        const project = (await entityStore.get(db, def, input.id))?.project;
        if (project) await withRecordContext(db, { project });
        const v = await notes.save(db, key, input.id, input.body, by, input.reason?.trim() ? { reason: input.reason.trim() } : {});
        return { version: v, project, label: `Notes on ${recordTitle(def, input.id, (await entityStore.get(db, def, input.id))?.values ?? {})}` };
      });
      // `[[etmf.Site:site_…]]` tokens are mentions of those records, from this note.
      await withTransaction(deps.pool, (db) => storeMentions(db, deps.entities(), { kind: 'note', id: `${key}:${input.id}`, label, ...(project ? { project } : {}) }, input.body));
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

    async keep(input, actor): Promise<RecordKeepResult> {
      const def = defOf(input.entity);
      if (!def.keepFromChat) throw new Error(`a ${def.entity} can't be kept from a chat (its entity type doesn't say \`keep_from_chat: true\`)`);
      if (actor.kind !== 'person') throw new Error('only a person keeps rows from a chat');
      const chatId = String(input.chatId ?? '').trim();
      if (!chatId) throw new Error('say which chat the rows come from');
      const quoted = quoteFields(def).map(([f]) => f);
      const rows: RecordKeepResult['rows'] = [];
      for (const raw of Array.isArray(input.rows) ? input.rows : []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rows.push({ error: 'a row is a map of field values' }); continue; }
        // A kept row starts in the entity's initial state, as a new record: no id or status of its own.
        const { id: _id, status: _status, ...values } = raw as Record<string, unknown>;
        const r = await createRecord({ entity: input.entity, values, reason: `kept from chat ${chatId}` }, actor);
        if (!r.result.applied) {
          rows.push({ error: r.result.message ?? r.result.status, ...(r.result.errors ? { errors: r.result.errors } : {}) });
          continue;
        }
        const checked = quoted.filter((f) => f in r.quotes);
        rows.push({ id: r.result.id!, ...(checked.length ? { quoteFound: checked.every((f) => r.quotes[f]) } : {}) });
      }
      return { entity: keyOf(def), rows };
    },
  };
  return service;
}

export { columnsOf };
