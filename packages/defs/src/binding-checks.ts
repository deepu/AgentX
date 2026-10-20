/**
 * What frozen bindings bind (the tools the checks may count on), and the checks a binding must
 * pass (22 §3). The actual policy tightening comparison is @memwise/policy's at run time; these
 * are the structural checks `memwise check` can do from the files.
 */
import { pinnedPlugin } from './project-plugins.ts';
import type { BindingDef, InstalledPlugin } from './plugin-types.ts';
import { lineOf, type PathKey } from './source.ts';
import { EFFECT_CLASSES, TREATMENTS, type Diagnostic, type EffectClass, type ProjectDefs, type Severity, type ValueType } from './types.ts';
import { formatValueType, parseValueType, sameValueType } from './value-types.ts';

/** Tool name prefixes the kernel keeps for its own tools; no plugin may bind one. */
export const RESERVED_TOOL_PREFIXES = ['domain.', 'recall.', 'playbooks.', 'plugins.', 'identity.', 'step.', 'checkpoint.', 'external.'] as const;

export interface BoundPluginTool {
  /** The binding's class, else the manifest's; undefined = unclassified (irreversible). */
  effect?: EffectClass;
  inputSchema?: Record<string, unknown>;
  /** The plugin id. */
  plugin: string;
  description: string;
}

const rank = (c: EffectClass) => EFFECT_CLASSES.indexOf(c);

/**
 * A tool's class in a domain: the stricter of the binding's and the declared one. A binding may
 * classify an unclassified tool or tighten a declared class; a hand-edited one that loosens it
 * (declared `outbound`, bound `read`) is a check error and never takes effect.
 */
export function stricterClass(bound: EffectClass | undefined, declared: EffectClass | undefined): EffectClass | undefined {
  if (!bound) return declared;
  if (!declared) return bound;
  return rank(bound) >= rank(declared) ? bound : declared;
}

/** The bindings in id order, each with the plugin version it pins (when installed and unchanged). */
function bound(project: ProjectDefs): { binding: BindingDef; plugin: InstalledPlugin }[] {
  return Object.keys(project.bindings ?? {}).sort().flatMap((id) => {
    const binding = project.bindings![id]!;
    const plugin = pinnedPlugin(project, binding);
    return plugin ? [{ binding, plugin }] : [];
  });
}

/**
 * The tools frozen bindings bind, by name: every tool of each bound plugin except those the
 * binding turns `off`, with the binding's class (else the declared one). When two plugins bind
 * the same name the first (by plugin id) keeps it; `checkBindings` reports the clash. A binding
 * that loosens a declared class does not take effect (`stricterClass`).
 */
export function boundPluginTools(project: ProjectDefs): Record<string, BoundPluginTool> {
  const out: Record<string, BoundPluginTool> = {};
  for (const { binding, plugin } of bound(project)) {
    for (const tool of Object.values(plugin.manifest.tools)) {
      const b = binding.tools[tool.name];
      if (b?.off || out[tool.name]) continue;
      const effect = stricterClass(b?.effect, tool.effect);
      out[tool.name] = { ...(effect ? { effect } : {}), inputSchema: tool.inputSchema, plugin: plugin.manifest.id, description: tool.description };
    }
  }
  return out;
}

/** The domain type a plugin field type stands for, with plugin entities renamed. */
function inDomainTerms(type: ValueType, binding: BindingDef): ValueType {
  if (type.kind === 'list') return { kind: 'list', of: inDomainTerms(type.of, binding) };
  if (type.kind === 'ref') return { kind: 'ref', entity: binding.entities[type.entity]?.entity ?? type.entity };
  if (type.kind === 'named' && binding.entities[type.name]) return { kind: 'named', name: binding.entities[type.name]!.entity };
  return type;
}

const hasRef = (t: ValueType): boolean => t.kind === 'ref' || (t.kind === 'list' && hasRef(t.of));

/** `{first} {last}` → [first, last]. */
export const templateFields = (template: string): string[] => [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());

/** The checks of every binding in the project (frozen ones, plus any loaded with `unfrozen`). */
export function checkBindings(project: ProjectDefs): Diagnostic[] {
  const out: Diagnostic[] = [];
  const roles = Object.keys(project.roles ?? {});
  const all = bound(project);

  // Tool names: global across bound plugins, and never a kernel name.
  const owner = new Map<string, string>();
  for (const { binding, plugin } of all) {
    for (const name of Object.keys(plugin.manifest.tools).sort()) {
      if (binding.tools[name]?.off) continue;
      const at = (message: string) => out.push({ severity: 'error', code: 'tool-name-taken', message, file: binding.file, line: lineOf(binding, ['tools', name]) ?? 1, path: `tools.${name}` });
      const reserved = RESERVED_TOOL_PREFIXES.find((p) => name.startsWith(p));
      if (reserved) at(`${name}: tool names starting with \`${reserved}\` belong to MemWise itself; turn the tool off (\`off: true\`)`);
      else if (owner.has(name)) at(`${name} is already bound by ${owner.get(name)}; two plugins can't bind the same tool name, so turn one off`);
      else owner.set(name, plugin.manifest.id);
    }
  }
  const providers = (cap: string) => all.flatMap(({ binding, plugin }) => {
    const p = plugin.manifest.provides.capabilities[cap];
    return p && !binding.tools[p.tool]?.off ? [p.tool] : [];
  });

  for (const { binding, plugin } of all) {
    const m = plugin.manifest;
    const at = (severity: Severity, code: string, message: string, path: PathKey[]) =>
      out.push({ severity, code, message, file: binding.file, line: lineOf(binding, path) ?? 1, ...(path.length ? { path: path.join('.') } : {}) });

    // ---- tools and classes
    for (const [name, b] of Object.entries(binding.tools)) {
      const tool = m.tools[name];
      if (!tool) { at('warning', 'unknown-tool', `${m.id} ${m.version} has no tool ${name}`, ['tools', name]); continue; }
      if (b.effect && tool.effect && rank(b.effect) < rank(tool.effect)) {
        at('error', 'binding-loosens-class', `${name} is declared \`${tool.effect}\` by the plugin; the binding may make it stricter, not \`${b.effect}\``, ['tools', name, 'effect']);
      }
    }

    // ---- capabilities
    const boundNames = new Set(owner.keys());
    for (const [cap, spec] of Object.entries(m.requires.capabilities)) {
      const tool = binding.capabilities[cap];
      if (!tool) {
        if (!spec.optional) at('error', 'capability-unfilled', `${m.title} needs ${cap} (its workflows call it \`${spec.as}\`); name the bound tool that provides it under capabilities${providers(cap).length ? ` (bound providers: ${providers(cap).join(', ')})` : ': no bound plugin provides it yet'}`, ['capabilities']);
        continue;
      }
      if (!boundNames.has(tool)) at('error', 'capability-provider-unbound', `${cap} → ${tool}: ${tool} is not a tool of any bound plugin`, ['capabilities', cap]);
      else if (!providers(cap).includes(tool)) at('error', 'capability-not-provided', `${cap} → ${tool}: the plugin binding ${tool} does not provide ${cap}${providers(cap).length ? ` (providers: ${providers(cap).join(', ')})` : ''}`, ['capabilities', cap]);
    }
    for (const cap of Object.keys(binding.capabilities)) {
      if (!m.requires.capabilities[cap]) at('warning', 'unknown-capability', `${m.id} does not require ${cap}`, ['capabilities', cap]);
    }

    // ---- entities and fields
    for (const [name, req] of Object.entries(m.requires.entities)) {
      if (!binding.entities[name]) at('error', 'binding-entity-unmapped', `${m.title} works with ${name}: map it to one of the domain's entities (${Object.keys(project.entities).join(', ') || 'none yet'})`, ['entities']);
      else {
        for (const [field, def] of Object.entries(req.fields)) {
          if (binding.entities[name]!.fields[field] !== undefined) continue;
          at(def.required ? 'error' : 'warning', 'binding-field-unmapped', `${name}.${field} is not mapped to a field of ${binding.entities[name]!.entity}${def.required ? ' (the plugin needs it)' : '; the plugin\'s workflows will leave it out'}`, ['entities', name, 'fields']);
        }
      }
    }
    for (const [name, e] of Object.entries(binding.entities)) {
      const req = m.requires.entities[name];
      if (!req) at('warning', 'unknown-plugin-entity', `${m.id} does not use an entity ${name}`, ['entities', name]);
      const domain = project.entities[e.entity];
      if (!domain) { at('error', 'binding-unknown-entity', `${name} → ${e.entity}: there is no entity type ${e.entity} in domain/entities/`, ['entities', name, 'entity']); continue; }
      for (const [field, target] of Object.entries(e.fields)) {
        const path = ['entities', name, 'fields', field];
        const pluginField = req?.fields[field];
        if (req && !pluginField) at('warning', 'unknown-plugin-field', `${name} has no field ${field} in the plugin`, path);
        const domainField = domain.fields[target];
        if (!domainField) { at('error', 'binding-unknown-field', `${name}.${field} → ${target}: ${e.entity} has no field ${target}`, path); continue; }
        const pluginType = pluginField ? parseValueType(pluginField.typeSource) : undefined;
        if (!pluginType) continue;
        const want = inDomainTerms(pluginType, binding);
        if (sameValueType(want, domainField.type)) continue;
        if (hasRef(pluginType)) at('error', 'binding-type-mismatch', `${name}.${field} is ${pluginField!.typeSource} (${formatValueType(want)} here) but ${e.entity}.${target} is ${domainField.typeSource}`, path);
        else at('warning', 'binding-type-mismatch', `${name}.${field} is ${pluginField!.typeSource} in the plugin but ${e.entity}.${target} is ${domainField.typeSource}; values may not fit`, path);
      }
    }

    // ---- roles
    for (const role of Object.keys(m.requires.roles)) {
      const to = binding.roles[role];
      if (to === undefined) { if (roles.length) at('error', 'binding-role-unmapped', `${m.title} names the role ${role}: map it to one of the domain's roles (${roles.join(', ')})`, ['roles']); }
      else if (roles.length && !roles.includes(to)) at('error', 'unknown-role', `${role} → ${to}: \`${to}\` is not a role in domain/roles.yaml (roles: ${roles.join(', ')})`, ['roles', role]);
    }

    // ---- record mappings
    for (const [name, rec] of Object.entries(binding.records)) {
      const source = m.records[name];
      if (!source) at('error', 'unknown-record-source', `${m.id} has no record source ${name}${Object.keys(m.records).length ? ` (it has ${Object.keys(m.records).join(', ')})` : ''}`, ['records', name]);
      const entity = project.entities[rec.entity];
      if (!entity) { at('error', 'binding-unknown-entity', `${name} → ${rec.entity}: there is no entity type ${rec.entity}`, ['records', name, 'entity']); continue; }
      const hasSourceField = (path: string) => !source || path.split('.')[0]! in source.fields || path.split('.')[0] === source.key;
      for (const [field, mapping] of Object.entries(rec.fields)) {
        const path = ['records', name, 'fields', field];
        if (!entity.fields[field]) at('error', 'binding-unknown-field', `${rec.entity} has no field ${field}`, path);
        const template = mapping.transform?.find((t): t is { template: string } => typeof t === 'object' && 'template' in t);
        if (mapping.from === undefined && !template) at('error', 'mapping-without-source', `${field} names no source field: add \`from:\` or a template`, path);
        if (mapping.from !== undefined && !hasSourceField(mapping.from)) at('warning', 'unknown-source-field', `${name} records have no field ${mapping.from.split('.')[0]}`, path);
        for (const f of template ? templateFields(template.template) : []) {
          if (!hasSourceField(f)) at('warning', 'unknown-source-field', `the template names {${f}}, which ${name} records don't have`, path);
        }
        if (template && !templateFields(template.template).length) at('error', 'invalid-transform', `the template of ${field} names no source field: write it like "{first} {last}"`, path);
        if (mapping.direction && mapping.direction !== 'read' && entity.fields[field] && !source?.get) {
          at('warning', 'mapping-write-without-get', `${field} is mapped \`${mapping.direction}\`, but ${name} has no get tool to check the round trip against`, path);
        }
      }
      const id = rec.identity;
      id.keys.forEach((key, i) => {
        if (!entity.fields[key]) at('error', 'identity-unknown-field', `identity key ${key}: ${rec.entity} has no field ${key}`, ['records', name, 'identity', 'keys', i]);
        else if (!rec.fields[key]) at('warning', 'identity-key-unmapped', `identity key ${key} is not mapped from ${name}, so it can never match`, ['records', name, 'identity', 'keys', i]);
      });
      if (id.fuzzy) {
        const fz = id.fuzzy;
        if (!entity.fields[fz.field]) at('error', 'identity-unknown-field', `fuzzy matching on ${fz.field}: ${rec.entity} has no field ${fz.field}`, ['records', name, 'identity', 'fuzzy', 'field']);
        if (!(fz.review <= fz.auto)) at('error', 'identity-thresholds', `the review threshold (${fz.review}) must not be above the auto-link one (${fz.auto})`, ['records', name, 'identity', 'fuzzy']);
      }
    }

    // ---- policy: the binding only tightens the plugin's defaults (D30)
    const pp = m.policy;
    const bp = binding.policy;
    if (bp) {
      for (const c of EFFECT_CLASSES) {
        const from = pp?.effects?.[c];
        const to = bp.effects?.[c];
        if (from && to && TREATMENTS.indexOf(to) < TREATMENTS.indexOf(from)) at('error', 'policy-loosened', `effects.${c}: the plugin says \`${from}\`; the binding may tighten it, not make it \`${to}\``, ['policy', 'effects', c]);
      }
      for (const [tool, rule] of Object.entries(bp.tools?.rules ?? {})) {
        if (!m.tools[tool]) at('warning', 'unknown-tool', `policy rule for ${tool}, which is not a tool of ${m.id}`, ['policy', 'tools', 'rules', tool]);
        const from = pp?.tools?.rules?.[tool]?.treatment;
        if (from && rule.treatment && TREATMENTS.indexOf(rule.treatment) < TREATMENTS.indexOf(from)) at('error', 'policy-loosened', `${tool}: the plugin says \`${from}\`; the binding may tighten it, not make it \`${rule.treatment}\``, ['policy', 'tools', 'rules', tool]);
      }
      for (const k of ['allow', 'deny', 'require'] as const) {
        for (const tool of bp.tools?.[k] ?? []) if (!m.tools[tool]) at('warning', 'unknown-tool', `policy tools.${k} names ${tool}, which is not a tool of ${m.id}`, ['policy', 'tools', k]);
      }
      for (const role of bp.approvals?.by ?? []) if (roles.length && !roles.includes(role)) at('error', 'unknown-role', `policy approvals.by: \`${role}\` is not a role in domain/roles.yaml`, ['policy', 'approvals', 'by']);
    }
    if (pp?.tools?.deny?.some((t) => bp?.tools?.allow?.includes(t))) at('error', 'policy-loosened', `the binding allows a tool the plugin denies`, ['policy', 'tools', 'allow']);
  }
  return out;
}
