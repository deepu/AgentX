/**
 * The names of the tools the kernel binds for every entity type (24 §3), so the checks and the
 * runtime agree: `<domain>.<snake(entity)>.create|get|update|transition|list`, e.g.
 * `etmf.expected_document.list`, and `domain.customer.create` in the default domain.
 */
import { DEFAULT_DOMAIN } from './domain-types.ts';
import { snakeName } from './resolve.ts';
import type { EffectClass, EntityTypeDef } from './types.ts';

export const ENTITY_TOOL_VERBS = ['create', 'get', 'update', 'transition', 'list'] as const;
export type EntityToolVerb = (typeof ENTITY_TOOL_VERBS)[number];

/** The effect class of each entity tool: writes for create, update and transition; reads for get and list. */
export const ENTITY_TOOL_EFFECTS: Record<EntityToolVerb, EffectClass> = {
  create: 'write', get: 'read', update: 'write', transition: 'write', list: 'read',
};

/** The five tool names of an entity type (a bare name is an entity of the default domain). */
export function entityToolNames(def: Pick<EntityTypeDef, 'entity' | 'domain'> | string): Record<EntityToolVerb, string> {
  const { entity, domain } = typeof def === 'string' ? { entity: def, domain: DEFAULT_DOMAIN } : def;
  const prefix = `${domain ?? DEFAULT_DOMAIN}.${snakeName(entity)}`;
  return Object.fromEntries(ENTITY_TOOL_VERBS.map((v) => [v, `${prefix}.${v}`])) as Record<EntityToolVerb, string>;
}

/** Every entity tool of these entity types, by name, with its effect class (for a CheckEnvironment). */
export function entityTools(entities: Record<string, Pick<EntityTypeDef, 'entity' | 'domain'>>): Record<string, { effect: EffectClass; entity: string; verb: EntityToolVerb }> {
  const out: Record<string, { effect: EffectClass; entity: string; verb: EntityToolVerb }> = {};
  for (const [key, def] of Object.entries(entities)) {
    const names = entityToolNames(def);
    for (const verb of ENTITY_TOOL_VERBS) out[names[verb]] = { effect: ENTITY_TOOL_EFFECTS[verb], entity: key, verb };
  }
  return out;
}
