/** Small helpers every package shares for domains and entity keys (24 §2). */
import { DEFAULT_DOMAIN, type Grant } from './domain-types.ts';
import type { EntityTypeDef, ProjectDefs, WorkflowDef } from './types.ts';

/** The entity key: the bare name in the default domain, else `<domain>.<Entity>`. */
export function entityKey(domain: string | undefined, entity: string): string {
  return !domain || domain === DEFAULT_DOMAIN ? entity : `${domain}.${entity}`;
}

/** The key of an entity type. */
export const keyOf = (def: Pick<EntityTypeDef, 'entity' | 'domain'>): string => entityKey(def.domain, def.entity);

/** `etmf.Site` → { domain: 'etmf', entity: 'Site' }; `Customer` → the default domain. */
export function splitEntityKey(key: string): { domain: string; entity: string } {
  const dot = key.indexOf('.');
  return dot > 0 ? { domain: key.slice(0, dot), entity: key.slice(dot + 1) } : { domain: DEFAULT_DOMAIN, entity: key };
}

/** The domain a workflow belongs to. */
export const domainOf = (wf: Pick<WorkflowDef, 'domain'>): string => wf.domain ?? DEFAULT_DOMAIN;

/**
 * Entity types as a file of `domain` names them: its own by bare name, every other one by key.
 * In the default domain this is `project.entities` itself (its own are already bare).
 */
export function scopedEntities(entities: Record<string, EntityTypeDef>, domain: string = DEFAULT_DOMAIN): Record<string, EntityTypeDef> {
  if (domain === DEFAULT_DOMAIN) return entities;
  const out: Record<string, EntityTypeDef> = {};
  for (const [key, def] of Object.entries(entities)) {
    out[key] = def;
    if ((def.domain ?? DEFAULT_DOMAIN) === domain) out[def.entity] = def;
  }
  return out;
}

/** An entity named as `domain`'s files name it (bare or a key), or undefined. */
export function resolveEntity(entities: Record<string, EntityTypeDef>, domain: string, name: string): EntityTypeDef | undefined {
  return scopedEntities(entities, domain)[name] ?? entities[name];
}

/** The project's entity types of one domain, by bare name. */
export function domainEntities(project: Pick<ProjectDefs, 'entities'>, domain: string): Record<string, EntityTypeDef> {
  const out: Record<string, EntityTypeDef> = {};
  for (const def of Object.values(project.entities)) if ((def.domain ?? DEFAULT_DOMAIN) === domain) out[def.entity] = def;
  return out;
}

/** Whether an actor's roles (workspace-wide) or grants hold `role` in `domain` (24 §2). */
export function hasRole(actor: { roles: string[]; grants?: Grant[] }, role: string, domain: string = DEFAULT_DOMAIN): boolean {
  return actor.roles.includes(role) || !!actor.grants?.some((g) => g.role === role && g.domain === domain);
}

/** Roles the actor holds in `domain` (workspace-wide ones and that domain's grants). */
export function rolesIn(actor: { roles: string[]; grants?: Grant[] }, domain: string = DEFAULT_DOMAIN): string[] {
  return [...new Set([...actor.roles, ...(actor.grants ?? []).filter((g) => g.domain === domain).map((g) => g.role)])];
}
