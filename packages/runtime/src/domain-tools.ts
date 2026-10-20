// Domain tools (19 §3): for every entity type, `domain.<entity>.create` (effect write,
// idempotent on the call's key) and `domain.<entity>.get` (read). They run under the step's
// actor, so Postgres row rules decide whether this step may insert, and the field-access view
// what it may read.
import { domainToolNames, PgEntityStore, withActor } from '@memwise/db';
import { valueTypeToJsonSchema, type EntityTypeDef, type ProjectDefs } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import type pg from 'pg';

export const DOMAIN_PLUGIN = 'memwise-domain';

/** JSON Schema of an entity's fields, for the create tool's arguments. */
export function entityInputSchema(def: EntityTypeDef, entities: Record<string, EntityTypeDef>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    properties[name] = { ...valueTypeToJsonSchema(field.type, entities), ...(field.description ? { description: field.description } : {}) };
    if (field.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/**
 * The tools for these entity types. `pool` is resolved lazily so the definitions can be built
 * for checks (names, classes and schemas only) without a database.
 */
export function domainTools(entities: Record<string, EntityTypeDef>, pool?: () => pg.Pool): ToolDefinition[] {
  const store = new PgEntityStore();
  const source = { plugin: DOMAIN_PLUGIN };
  const db = () => {
    const p = pool?.();
    if (!p) throw new Error('domain tools need the kernel database');
    return p;
  };
  const out: ToolDefinition[] = [];
  for (const def of Object.values(entities)) {
    const names = domainToolNames(def);
    out.push({
      name: names.create,
      description: `Create a ${def.entity} record with the given fields; returns its id.`,
      inputSchema: entityInputSchema(def, entities),
      effect: 'write',
      idempotent: true,
      source,
      async execute(args: Record<string, unknown>, ctx) {
        const id = await withActor(db(), { kind: 'step', token: ctx.token }, (c) =>
          store.create(c, def, args, { idempotencyKey: ctx.idempotencyKey, stepRunId: ctx.token.stepRunId }));
        return { id };
      },
    } satisfies ToolDefinition<Record<string, unknown>>);
    out.push({
      name: names.get,
      description: `Read a ${def.entity} record by id. Fields you may not see come back empty.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      effect: 'read',
      source,
      async execute({ id }: { id: string }, ctx) {
        const row = await withActor(db(), { kind: 'step', token: ctx.token }, (c) => store.get(c, def, id));
        return row ? { id: row.id, ...row.values, hidden: row.hidden } : { error: `no ${def.entity} ${id}` };
      },
    } satisfies ToolDefinition<{ id: string }>);
  }
  return out;
}

/** Tool names and classes a project's checks should know about, including its domain tools. */
export function projectDomainTools(project: Pick<ProjectDefs, 'entities'>): ToolDefinition[] {
  return domainTools(project.entities);
}
