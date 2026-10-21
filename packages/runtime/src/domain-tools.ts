// Entity tools (19 §3, 24 §3): for every entity type of every domain, `<domain>.<entity>.create`
// and `.update` and `.transition` (effect write) and `.get` and `.list` (read). They run under the
// step's actor, so Postgres row rules decide whether this step may insert or change a row, and
// the field-access view what it may read. Every write carries the step's reason ("<playbook>:
// <step>, case <id>") and its step run, so the record's version says who, when and why.
import { domainToolNames, PgEntityStore, withActor, withRecordContext, type PgPeopleStore } from '@memwise/db';
import {
  keyOf, scopedEntities, validateValue, valueTypeToJsonSchema, type EntityTypeDef, type ProjectDefs,
  type StepToken,
} from '@memwise/defs';
import type { ToolContext, ToolDefinition } from '@memwise/gateway';
import type pg from 'pg';
import { domainOfEntity, recordTitle, stepReason, workflowOfToken } from './records/context.ts';
import { checkQuotes, quoteFields } from './records/quotes.ts';
import { checkTransition, type Mover } from './records/lifecycle.ts';
import type { KernelChange, PersonActor } from './types.ts';
import type { DefinitionCache } from './views.ts';

export const DOMAIN_PLUGIN = 'memwise-domain';

/** JSON Schema of an entity's fields, for the create tool's arguments. */
export function entityInputSchema(def: EntityTypeDef, entities: Record<string, EntityTypeDef>): Record<string, unknown> {
  const scoped = scopedEntities(entities, domainOfEntity(def));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    properties[name] = { ...valueTypeToJsonSchema(field.type, scoped), ...(field.description ? { description: field.description } : {}) };
    if (field.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** What the tools need at run time (the kernel's); without it they can only be described. */
export interface EntityToolRuntime {
  pool: pg.Pool;
  project(): ProjectDefs | undefined;
  defs: DefinitionCache;
  people: PgPeopleStore;
  emit?(change: KernelChange): void;
}

/**
 * Fields a step (or a person) may not write: calculated, followed through a link, or owned by a
 * plugin (D10). Field -> why, in plain words.
 */
export function readOnlyFields(def: EntityTypeDef, fields: string[], opts: { creating?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const followed = new Map(Object.entries(def.links ?? {}).flatMap(([key, l]) => l.follow.map((f) => [f, l.target || key] as const)));
  for (const f of fields) {
    if (def.calculated?.[f]) out[f] = `${f} is calculated from other values, so it can't be written`;
    else if (followed.has(f)) out[f] = `${f} comes from ${followed.get(f)} through a link; change it there`;
    else if (!opts.creating && def.ownership?.[f] && def.ownership[f] !== 'domain') out[f] = `${f} is kept by the ${def.ownership[f]} plugin; change it there`;
    else if (!(f in def.fields) && def.relationships[f]?.cardinality !== 'one') out[f] = `a ${def.entity} has no field ${f}`;
  }
  return out;
}

/**
 * Problems with values for an entity's fields (types checked in its domain). Creating a record
 * may give a plugin-owned field its first value (Phase 2/4 behaviour); changing one may not.
 */
export function fieldErrors(def: EntityTypeDef, entities: Record<string, EntityTypeDef>, values: Record<string, unknown>,
  opts: { creating?: boolean } = {}): Record<string, string[]> {
  const scoped = scopedEntities(entities, domainOfEntity(def));
  const errors: Record<string, string[]> = {};
  for (const [f, why] of Object.entries(readOnlyFields(def, Object.keys(values), opts))) errors[f] = [why];
  for (const [f, v] of Object.entries(values)) {
    const field = def.fields[f];
    if (!field || errors[f] || v === null || v === undefined) continue;
    const errs = validateValue(field.type, v, scoped);
    if (errs.length) errors[f] = errs;
  }
  return errors;
}

const plainErrors = (errors: Record<string, string[]>) => Object.entries(errors).map(([f, e]) => `${f}: ${e.join('; ')}`).join('; ');

/**
 * The tools for these entity types. `runtime` is resolved lazily so the definitions can be built
 * for checks (names, classes and schemas only) without a database.
 */
export function domainTools(entities: Record<string, EntityTypeDef>, runtime?: () => EntityToolRuntime | undefined): ToolDefinition[] {
  const store = new PgEntityStore();
  const source = { plugin: DOMAIN_PLUGIN };
  const rt = () => {
    const r = runtime?.();
    if (!r) throw new Error('entity tools need the kernel database');
    return r;
  };

  /** Runs `fn` as the step, with the step's reason and run on every version it writes. */
  async function asStep<T>(token: StepToken, fn: (db: pg.PoolClient, reason: string) => Promise<T>): Promise<T> {
    const r = rt();
    const workflow = await workflowOfToken(r, token);
    const reason = workflow ? stepReason(workflow, token.stepId, token.caseId) : `step ${token.stepRunId}, case ${token.caseId}`;
    return withActor(r.pool, { kind: 'step', token }, async (db) => {
      await withRecordContext(db, { reason, via: token.stepRunId });
      return fn(db, reason);
    });
  }
  const changed = (def: EntityTypeDef, recordId?: string) => rt().emit?.({ kind: 'records', entity: keyOf(def), ...(recordId ? { recordId } : {}) });
  /** Quote fields (25 §4) checked after the write, as the system: a quote not in its source flags the record. */
  const checkQuotesOf = (def: EntityTypeDef, recordId: string) =>
    quoteFields(def).length ? withActor(rt().pool, { kind: 'system' }, (db) => checkQuotes(db, entities, def, recordId)) : Promise.resolve({});
  /**
   * The id of the record with this key (25 §3), looked up as the system like the quote check, so
   * neither the step's column grants nor row rules hide it. What the step may see of the record
   * is still read as the step.
   */
  const idByKey = (def: EntityTypeDef, key: Record<string, unknown>) =>
    withActor(rt().pool, { kind: 'system' }, (db) => store.idByKey(db, def, key));

  /**
   * The person a step acts for, with their roles and grants now (for `by: role:<x>`). A triggered
   * case's steps act for a role (`actsFor`, 24 §7): they count as a person holding just that role.
   */
  async function personOf(token: StepToken): Promise<PersonActor | undefined> {
    if (!token.onBehalfOf) return token.actsFor ? { kind: 'person', personId: `role:${token.actsFor}`, roles: [token.actsFor] } : undefined;
    return rt().people.actorFor(token.onBehalfOf).catch(() => undefined) as Promise<PersonActor | undefined>;
  }

  const out: ToolDefinition[] = [];
  for (const def of Object.values(entities)) {
    const names = domainToolNames(def);
    const label = def.entity;
    const key = def.key?.length ? def.key : undefined;
    const keyText = key?.join(', ');
    out.push({
      name: names.create,
      description: key
        ? `Create a ${label} record with the given fields, unless one with this ${keyText} exists: returns its id and \`existed\` (true: the record was already there and nothing changed).`
        : `Create a ${label} record with the given fields; returns its id.`,
      inputSchema: entityInputSchema(def, entities),
      effect: 'write',
      idempotent: true,
      source,
      async execute(args: Record<string, unknown>, ctx: ToolContext) {
        const errors = fieldErrors(def, entities, args, { creating: true });
        if (Object.keys(errors).length) throw new Error(`the ${label} can't be created: ${plainErrors(errors)}`);
        const opts = { idempotencyKey: ctx.idempotencyKey, stepRunId: ctx.token.stepRunId };
        // Keyed (25 §3, D80): the record with this key, made now or found as it was (as the
        // system, once the step's transaction is done).
        const made = key
          ? await asStep(ctx.token, (c) => store.insertKeyed(c, def, args, opts))
          : { id: await asStep(ctx.token, (c) => store.create(c, def, args, opts)), existed: false as const };
        const found = made.existed ? await idByKey(def, args) : made.id;
        if (!found) throw new Error(`the ${label} with this ${keyText} clashed with one that can't be found`);
        const r = { id: found, existed: made.existed };
        if (!r.existed) {
          await checkQuotesOf(def, r.id);
          changed(def, r.id);
        }
        return key ? { id: r.id, existed: r.existed } : { id: r.id };
      },
    } satisfies ToolDefinition<Record<string, unknown>>);
    const keySchema = key ? (() => {
      const props = (entityInputSchema(def, entities) as { properties: Record<string, unknown> }).properties;
      return { type: 'object', properties: Object.fromEntries(key.map((f) => [f, props[f]])), required: [...key], additionalProperties: false, description: `The record's ${keyText}, instead of its id.` };
    })() : undefined;
    out.push({
      name: names.get,
      description: key
        ? `Read a ${label} record by id, or by its ${keyText} (\`key\`). Fields you may not see come back empty.`
        : `Read a ${label} record by id. Fields you may not see come back empty.`,
      inputSchema: key
        ? { type: 'object', properties: { id: { type: 'string' }, key: keySchema }, additionalProperties: false }
        : { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      effect: 'read',
      source,
      async execute({ id, key: byKey }: { id?: string; key?: Record<string, unknown> }, ctx: ToolContext) {
        if (!id && !(key && byKey && typeof byKey === 'object')) throw new Error(key ? `name the ${label} by its id or its ${keyText} (\`key\`)` : `name the ${label} by its id`);
        const found = id ?? (await idByKey(def, byKey!));
        const row = found ? await withActor(rt().pool, { kind: 'step', token: ctx.token }, (c) => store.get(c, def, found)) : undefined;
        const which = id ?? key!.map((f) => `${f} ${JSON.stringify(byKey![f])}`).join(', ');
        return row ? { id: row.id, ...(row.lifecycle ? { status: row.lifecycle } : {}), ...row.values, hidden: row.hidden } : { error: `no ${label} ${which}` };
      },
    } satisfies ToolDefinition<{ id?: string; key?: Record<string, unknown> }>);

    const fieldSchema = entityInputSchema(def, entities) as { properties: Record<string, unknown> };
    out.push({
      name: names.update,
      description: `Change fields of a ${label} record: its id and the fields to change. Calculated fields, fields from a linked domain and fields a plugin keeps can't be changed.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...fieldSchema.properties }, required: ['id'], additionalProperties: false },
      effect: 'write',
      idempotent: true,
      source,
      async execute({ id, ...values }: { id: string } & Record<string, unknown>, ctx: ToolContext) {
        const errors = fieldErrors(def, entities, values);
        if (Object.keys(errors).length) throw new Error(`the ${label} can't be changed: ${plainErrors(errors)}`);
        if (!Object.keys(values).length) return { id, changed: [] };
        const r = await asStep(ctx.token, async (c) => {
          if (!(await store.get(c, def, id))) throw new Error(`there is no ${label} ${id}`);
          return store.update(c, def, id, values);
        });
        if (r.changed.length) await checkQuotesOf(def, id);
        changed(def, id);
        return { id, version: r.version, changed: r.changed };
      },
    } satisfies ToolDefinition<{ id: string } & Record<string, unknown>>);

    if (def.lifecycleChart) {
      const transitions = Object.keys(def.lifecycleChart.transitions);
      out.push({
        name: names.transition,
        description: `Move a ${label} record along its lifecycle (${transitions.join(', ')}). Refused when the record's state, a guard or a required signature doesn't allow it.`,
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['id', 'transition'],
          properties: { id: { type: 'string' }, transition: { type: 'string', enum: transitions }, reason: { type: 'string' } },
        },
        effect: 'write',
        idempotent: true,
        source,
        async execute({ id, transition, reason }: { id: string; transition: string; reason?: string }, ctx: ToolContext) {
          const person = await personOf(ctx.token);
          const mover: Mover = { kind: 'step', caseId: ctx.token.caseId, ...(person ? { person } : {}) };
          const r = await asStep(ctx.token, async (c, stepWhy) => {
            // A retry of a transition this step run already made answers the same.
            const done = await c.query(
              `select version, "values" ->> 'status' as status from mw.record_versions where entity = $1 and record_id = $2 and via = $3
                order by version desc limit 1`, [keyOf(def), id, ctx.token.stepRunId]);
            const check = await checkTransition(c, def, entities, rt().project(), { id, transition }, mover);
            if (!check.ok) {
              const row = done.rows[0];
              if (row && check.status === 'invalid' && def.lifecycleChart!.states[row.status]
                && Object.values(def.lifecycleChart!.states).some((s) => s.on[transition] === row.status)) {
                return { version: row.version as number, from: undefined, to: row.status as string };
              }
              throw new Error(check.message);
            }
            const why = reason?.trim() ? `${stepWhy}: ${reason.trim()}` : stepWhy;
            await withRecordContext(c, { reason: why, via: ctx.token.stepRunId, transition });
            const t = await store.transition(c, def, id, { to: check.to, transition, reason: why });
            return { version: t.version, from: t.from ?? check.from, to: check.to };
          });
          changed(def, id);
          return { id, transition, ...(r.from ? { from: r.from } : {}), status: r.to, version: r.version };
        },
      } satisfies ToolDefinition<{ id: string; transition: string; reason?: string }>);
    }

    out.push({
      name: names.list,
      description: `List ${label} records: an optional filter (a condition such as "status = 'filed'") and a limit; returns ids and titles.`,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { filter: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      },
      effect: 'read',
      source,
      async execute({ filter, limit }: { filter?: string; limit?: number }, ctx: ToolContext) {
        const r = await withActor(rt().pool, { kind: 'step', token: ctx.token }, (c) =>
          store.query(c, def, entities, { ...(filter ? { filter } : {}), limit: Math.min(limit ?? 50, 200) }));
        return {
          total: r.total,
          rows: r.rows.map((row) => ({ id: row.id, title: recordTitle(def, row.id, row.values), ...(row.lifecycle ? { status: row.lifecycle } : {}), ...row.values })),
        };
      },
    } satisfies ToolDefinition<{ filter?: string; limit?: number }>);
  }
  return out;
}

/** Tool names and classes a project's checks should know about, including its domain tools. */
export function projectDomainTools(project: Pick<ProjectDefs, 'entities'>): ToolDefinition[] {
  return domainTools(project.entities);
}
