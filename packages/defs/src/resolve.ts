/**
 * Resolving a plugin's workflow through a binding into domain terms (Phase 4, 22 §3): its entity
 * types, domain tools and their arguments, capability aliases and roles become the domain's, so
 * it runs, checks and shows like an authored one. Pure: the plugin folder is never touched.
 */
import { formatValueType } from './value-types.ts';
import { locatorOf, rememberLocator, sha256 } from './source.ts';
import type { BindingDef, InstalledPlugin } from './plugin-types.ts';
import type { ArgSource, CaseTypeDef, Diagnostic, ExampleCase, FieldDef, PolicyDoc, StepDef, ValueType, WorkflowDef } from './types.ts';

/** `ClientEngagement` → `client_engagement` (the same as @memwise/db's table names). */
export function snakeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** The kernel's tool for an entity type: `domain.customer.create`, `domain.customer.get`. */
export const domainToolName = (entity: string, verb: 'create' | 'get' | string): string => `domain.${snakeName(entity)}.${verb}`;

/** Arguments and fields every entity row has; never renamed through a field map. */
const SYSTEM_FIELDS = new Set(['id', 'lifecycle']);

/** The renames one binding makes, as functions over the plugin's names. */
export interface BindingRenames {
  /** Plugin entity → domain entity (unbound ones keep their name). */
  entity(name: string): string;
  isPluginEntity(name: string): boolean;
  /** A field of a plugin entity → the domain field; undefined when the binding doesn't map it. */
  field(pluginEntity: string, field: string): string | undefined;
  /** Capability aliases → bound providers; `domain.<plugin entity>.<verb>` → the domain entity's. */
  tool(name: string): string;
  /** The plugin entity a domain tool name is about (`domain.client.create` → `Client`), if any. */
  toolEntity(name: string): string | undefined;
  role(name: string): string;
}

export function bindingRenames(plugin: InstalledPlugin, binding: BindingDef): BindingRenames {
  const required = plugin.manifest.requires;
  const pluginEntities = new Set([...Object.keys(required.entities), ...Object.keys(binding.entities)]);
  const bySnake = new Map([...pluginEntities].map((e) => [snakeName(e), e]));
  const aliases = new Map<string, string>();
  for (const [cap, spec] of Object.entries(required.capabilities)) {
    const provider = binding.capabilities[cap];
    if (provider && provider !== spec.as) aliases.set(spec.as, provider);
  }
  const toolEntity = (name: string) => {
    const m = /^domain\.([a-z0-9_]+)\.([A-Za-z0-9_]+)$/.exec(name);
    return m ? bySnake.get(m[1]!) : undefined;
  };
  return {
    entity: (name) => binding.entities[name]?.entity ?? name,
    isPluginEntity: (name) => pluginEntities.has(name),
    field: (entity, field) => (SYSTEM_FIELDS.has(field) ? field : binding.entities[entity]?.fields[field]),
    tool: (name) => {
      const alias = aliases.get(name);
      if (alias) return alias;
      const entity = toolEntity(name);
      const bound = entity && binding.entities[entity]?.entity;
      return bound ? domainToolName(bound, name.split('.')[2]!) : name;
    },
    toolEntity,
    role: (name) => binding.roles[name] ?? name,
  };
}

function renameType(type: ValueType, r: BindingRenames, records: Record<string, unknown>): ValueType {
  switch (type.kind) {
    case 'list': return { kind: 'list', of: renameType(type.of, r, records) };
    case 'ref': return { kind: 'ref', entity: r.entity(type.entity) };
    case 'named': return records[type.name] || !r.isPluginEntity(type.name) ? type : { kind: 'named', name: r.entity(type.name) };
    default: return type;
  }
}

/** The plugin entity a value type points at (`Ref<Client>`, `List<Client>`, `Client`), if any. */
function entityOf(type: ValueType | undefined, r: BindingRenames, records: Record<string, unknown>): string | undefined {
  if (!type) return undefined;
  if (type.kind === 'list') return entityOf(type.of, r, records);
  if (type.kind === 'ref' && r.isPluginEntity(type.entity)) return type.entity;
  if (type.kind === 'named' && !records[type.name] && r.isPluginEntity(type.name)) return type.name;
  return undefined;
}

/** Keeps the original's line lookup for the copy, so diagnostics still point into the plugin's files. */
function sameLines<T extends object>(copy: T, original: object): T {
  const locate = locatorOf(original);
  if (locate) rememberLocator(copy, locate);
  return copy;
}

/**
 * Resolves a plugin workflow through a binding (22 §3): entity types in case fields and record
 * types, `domain.<entity>.*` tools and their `map:` arguments (renamed by the field map; an
 * unmapped one is dropped with a `binding-field-unmapped` warning), capability aliases → the
 * bound provider (tool lists, writes, maps, outcomeFrom, policies, example stubs and scripted
 * calls, approvals, expected effects), roles (owner, assignees, approvers), and example
 * `expect.entities`. `dir` stays in the plugin folder; `hash` covers the workflow and the binding.
 */
export function resolveWorkflow(workflow: WorkflowDef, plugin: InstalledPlugin, binding: BindingDef): { workflow: WorkflowDef; diagnostics: Diagnostic[] } {
  const r = bindingRenames(plugin, binding);
  const diagnostics: Diagnostic[] = [];
  const records = workflow.caseType.types;
  const caseFields = workflow.caseType.fields;
  const unmapped = (file: string, entity: string, field: string, where: string) => diagnostics.push({
    severity: 'warning', code: 'binding-field-unmapped',
    message: `${where}: ${entity}.${field} is not mapped to a field of ${r.entity(entity)} by the binding, so it is left out`,
    file,
  });
  const renameTools = (list: string[]) => [...new Set(list.map(r.tool))];

  /** `case.client.tax_id` → `case.client.gstin` when `client` is a plugin entity. */
  const casePath = (path: string): string => {
    const [head, next, ...rest] = path.split('.');
    const entity = entityOf(caseFields[head!]?.type, r, records);
    if (!entity || next === undefined) return path;
    return [head, r.field(entity, next) ?? next, ...rest].join('.');
  };
  /** Renames the keys of a domain tool's arguments (or a row of its entity) through the field map. */
  const entityKeys = <T>(entity: string, values: Record<string, T>, file: string, where: string): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(values)) {
      const to = r.field(entity, k);
      if (to === undefined) unmapped(file, entity, k, where);
      else out[to] = v;
    }
    return out;
  };
  const toolArgs = <T>(tool: string, args: Record<string, T>, file: string, where: string): Record<string, T> => {
    const entity = r.toolEntity(tool);
    return entity && binding.entities[entity] ? entityKeys(entity, args, file, where) : args;
  };
  const renamePolicy = (p: PolicyDoc | undefined): PolicyDoc | undefined => {
    if (!p) return p;
    const out = structuredClone(p);
    if (out.tools) {
      for (const k of ['allow', 'deny', 'require'] as const) if (out.tools[k]) out.tools[k] = renameTools(out.tools[k]!);
      if (out.tools.rules) out.tools.rules = Object.fromEntries(Object.entries(out.tools.rules).map(([t, rule]) => [r.tool(t), rule]));
    }
    if (out.approvals?.by) out.approvals.by = [...new Set(out.approvals.by.map(r.role))];
    return sameLines(out, p);
  };
  const renameField = (f: FieldDef): FieldDef => {
    const type = renameType(f.type, r, records);
    return { ...f, type, typeSource: formatValueType(type) === formatValueType(f.type) ? f.typeSource : formatValueType(type) };
  };

  // ---- case type
  const caseType: CaseTypeDef = sameLines({
    ...workflow.caseType,
    fields: Object.fromEntries(Object.entries(caseFields).map(([n, f]) => [n, renameField(f)])),
    types: Object.fromEntries(Object.entries(records).map(([n, rec]) => [n, {
      name: rec.name, fields: Object.fromEntries(Object.entries(rec.fields).map(([fn, f]) => [fn, renameField(f)])),
    }])),
    hash: sha256(workflow.caseType.hash, binding.hash),
  }, workflow.caseType);

  // ---- steps
  const steps: Record<string, StepDef> = {};
  for (const [state, step] of Object.entries(workflow.steps)) {
    const s: StepDef = structuredClone(step);
    s.tools = { allowed: renameTools(step.tools.allowed), required: renameTools(step.tools.required) };
    s.reads = step.reads.map((p) => (p.startsWith('case.') ? `case.${casePath(p.slice(5))}` : p));
    for (const w of Object.values(s.writes)) {
      const type = renameType(w.type, r, records);
      if (formatValueType(type) !== formatValueType(w.type)) { w.type = type; w.typeSource = formatValueType(type); }
      if (w.from.kind === 'tool') {
        const entity = r.toolEntity(w.from.tool);
        const tool = r.tool(w.from.tool);
        const field = w.from.field;
        w.from = { kind: 'tool', tool, ...(field !== undefined ? { field: entity && binding.entities[entity] ? [r.field(entity, field.split('.')[0]!) ?? field.split('.')[0], ...field.split('.').slice(1)].join('.') : field } : {}) };
      }
    }
    if (step.map) {
      const map: Record<string, Record<string, ArgSource>> = {};
      for (const [tool, args] of Object.entries(step.map)) {
        const renamed = toolArgs(tool, args, step.file, `map.${tool}`);
        map[r.tool(tool)] = Object.fromEntries(Object.entries(renamed).map(([k, src]) => [k, 'case' in src ? { case: casePath(src.case) } : src]));
      }
      s.map = map;
    }
    if (step.outcomeFrom) s.outcomeFrom = { ...step.outcomeFrom, tool: r.tool(step.outcomeFrom.tool) };
    if (step.assignee !== undefined) s.assignee = r.role(step.assignee);
    if (step.policy) s.policy = renamePolicy(step.policy);
    s.hash = sha256(step.hash, binding.hash);
    steps[state] = sameLines(s, step);
  }

  // ---- example cases
  const examples = workflow.examples.map((ex): ExampleCase => {
    const e: ExampleCase = structuredClone(ex);
    const where = `example ${ex.name}`;
    if (ex.tools) {
      e.tools = {};
      for (const [tool, stub] of Object.entries(ex.tools)) {
        const entity = r.toolEntity(tool);
        const renameRow = (v: unknown) => (entity && binding.entities[entity] && v && typeof v === 'object' && !Array.isArray(v)
          ? entityKeys(entity, v as Record<string, unknown>, ex.file, `${where}: tools.${tool}`) : v);
        const results = stub && typeof stub === 'object' && Array.isArray((stub as { results?: unknown }).results)
          ? { results: (stub as { results: unknown[] }).results.map(renameRow) } : renameRow(stub);
        e.tools[r.tool(tool)] = results;
      }
    }
    if (ex.model) {
      for (const turns of Object.values(e.model!)) {
        for (const turn of turns) {
          turn.toolCalls = turn.toolCalls?.map((c) => ({ name: r.tool(c.name), args: toolArgs(c.name, c.args, ex.file, `${where}: ${c.name}`) }));
        }
      }
    }
    if (ex.approvals) e.approvals = Object.fromEntries(Object.entries(ex.approvals).map(([t, v]) => [r.tool(t), v]));
    if (ex.expect.effects) {
      const effects: Record<string, number> = {};
      for (const [t, n] of Object.entries(ex.expect.effects)) effects[r.tool(t)] = (effects[r.tool(t)] ?? 0) + n;
      e.expect.effects = effects;
    }
    if (ex.expect.entities) {
      e.expect.entities = Object.fromEntries(Object.entries(ex.expect.entities).map(([entity, want]) => [
        r.entity(entity),
        typeof want === 'number' || !binding.entities[entity] ? want : want.map((row) => entityKeys(entity, row, ex.file, `${where}: expect.entities.${entity}`)),
      ]));
    }
    return sameLines(e, ex);
  });

  const resolved: WorkflowDef = sameLines({
    ...workflow,
    ...(workflow.owner !== undefined ? { owner: r.role(workflow.owner) } : {}),
    states: Object.fromEntries(Object.entries(workflow.states).map(([n, st]) => [n, st.assignee !== undefined ? { ...st, assignee: r.role(st.assignee) } : { ...st }])),
    steps,
    caseType,
    ...(workflow.policy ? { policy: renamePolicy(workflow.policy) } : {}),
    examples,
    hash: sha256(workflow.hash, binding.hash),
    origin: { kind: 'plugin', plugin: plugin.manifest.id, pluginVersion: plugin.manifest.version, bindingVersion: binding.version },
  }, workflow);

  // One warning per unmapped field and place is enough.
  const seen = new Set<string>();
  return { workflow: resolved, diagnostics: diagnostics.filter((d) => !seen.has(d.message) && !!seen.add(d.message)) };
}
