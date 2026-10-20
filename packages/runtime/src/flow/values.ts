// Values a trigger or a hand-off starts a case with (24 §7, §8): `with:` mapped from the record,
// the message, the parent case or the item, and the defaults when `with:` says nothing.
import {
  domainOf, keyOf, resolveEntity, type CaseValue, type EntityTypeDef, type HandoffArg, type ValueType, type WorkflowDef,
} from '@memwise/defs';

/** The entity key a workflow's files mean by `name` (bare in its domain, or a key). */
export function entityKeyFor(workflow: Pick<WorkflowDef, 'domain'>, name: string, entities: Record<string, EntityTypeDef>): string {
  const def = resolveEntity(entities, domainOf(workflow), name);
  return def ? keyOf(def) : name;
}

/** The entity key a Ref (or List<Ref>) type points at, in the workflow's domain. */
export function refTarget(workflow: Pick<WorkflowDef, 'domain'>, t: ValueType | undefined, entities: Record<string, EntityTypeDef>): string | undefined {
  if (!t) return undefined;
  if (t.kind === 'ref') return entityKeyFor(workflow, t.entity, entities);
  if (t.kind === 'named' && resolveEntity(entities, domainOf(workflow), t.name)) return entityKeyFor(workflow, t.name, entities);
  return undefined;
}

/** Case fields holding a single Ref to `entityKey`. */
export function refFieldsTo(workflow: WorkflowDef, entityKey: string, entities: Record<string, EntityTypeDef>): string[] {
  return Object.entries(workflow.caseType.fields)
    .filter(([, f]) => f.type.kind === 'ref' && refTarget(workflow, f.type, entities) === entityKey)
    .map(([name]) => name);
}

/** `a.b.c` of a plain value. */
export function pathValue(value: unknown, path: string): unknown {
  if (!path) return value;
  let v: unknown = value;
  for (const part of path.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

/** A literal as written in a `with:` (numbers, booleans, null and quoted text; anything else is text). */
export function literal(src: string): unknown {
  const s = src.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null') return null;
  if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
  return s;
}

/** What a trigger's `with:` can name. */
export interface TriggerSource {
  /** The record the trigger fired for (entity and date triggers). */
  record?: { entity: string; id: string };
  /** The incoming message (message triggers). */
  message?: Record<string, unknown>;
}

/**
 * The starting values of a triggered case. `with:` maps case fields from `record` (the record's
 * id), `message` / `message.<x>`, or a literal. Without `with:`: the one Ref start field to the
 * record's entity gets its id; for a message, case fields named like the message's fields.
 */
export function triggerValues(
  workflow: WorkflowDef, mapping: Record<string, string>, source: TriggerSource, entities: Record<string, EntityTypeDef>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Object.keys(mapping).length) {
    for (const [field, src] of Object.entries(mapping)) {
      const s = src.trim();
      if (s === 'record') out[field] = source.record?.id;
      else if (s === 'message') out[field] = source.message;
      else if (s.startsWith('message.')) out[field] = pathValue(source.message, s.slice('message.'.length));
      else out[field] = literal(s);
    }
  } else if (source.record) {
    const refs = refFieldsTo(workflow, source.record.entity, entities);
    if (refs.length === 1) out[refs[0]!] = source.record.id;
  } else if (source.message) {
    for (const name of Object.keys(workflow.caseType.fields)) {
      if (name in source.message) out[name] = source.message[name];
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** A hand-off's `with:` from the parent case and, in a for_each, the item. */
export function handoffValues(
  mapping: Record<string, HandoffArg>, parent: Record<string, CaseValue>, item?: unknown, record?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, arg] of Object.entries(mapping)) {
    let v: unknown;
    if ('case' in arg) {
      const path = arg.case.startsWith('case.') ? arg.case.slice(5) : arg.case;
      const [head, ...rest] = path.split('.');
      v = pathValue(parent[head!]?.value, rest.join('.'));
    } else if ('item' in arg) {
      const path = arg.item === 'item' ? '' : arg.item.startsWith('item.') ? arg.item.slice(5) : arg.item;
      v = pathValue(item, path);
    } else if ('record' in arg) v = record;
    else v = arg.value;
    if (v !== undefined && v !== null) out[field] = v;
  }
  return out;
}

/** A case field named by a block (`case.sites` or `sites`). */
export const caseField = (path: string) => (path.startsWith('case.') ? path.slice(5) : path).split('.')[0]!;
