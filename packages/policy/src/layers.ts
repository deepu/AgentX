/**
 * Building the layer stack a step runs under (08 §2): platform → plugins → domain → workflow → step.
 */
import type { EffectClass, PolicyDoc, StepDef, Treatment, WorkflowDef } from '@memwise/defs';
import { compareRate, lowerMoney, stricter } from './order.ts';
import type { PolicyLayer } from './types.ts';

/** Tools the step engine provides to every step; never listed, never denied. */
export const BUILTIN_TOOLS: readonly string[] = ['step.finish', 'checkpoint.verdict'];

/** The model role that judges a step's prose checkpoint rules (the step engine's default). */
export const VERIFIER_ROLE = 'verifier';

/** The built-in defaults (06 §3): nothing that leaves or can't be undone runs without a person. */
export const PLATFORM_DEFAULTS: PolicyLayer = {
  kind: 'platform',
  name: 'platform',
  doc: {
    name: 'platform',
    effects: { read: 'allow', draft: 'allow', write: 'allow', outbound: 'approve', irreversible: 'approve' },
    taint: { enabled: true, outboundWhenTainted: 'approve' },
  },
};

/** The step's own layer: its tool list, budget and model roles, merged with its `policy:` block. */
export function stepLayer(step: StepDef, workflowId: string): PolicyLayer {
  const budgets: NonNullable<PolicyDoc['budgets']> = {};
  if (step.budget?.tokens !== undefined) budgets.tokens = step.budget.tokens;
  if (step.budget?.timeMs !== undefined) budgets.timeMs = step.budget.timeMs;
  if (step.budget?.modelCalls !== undefined) budgets.modelCalls = step.budget.modelCalls;

  // A step may call only what it lists, so the allow list is set even when it is empty. A form
  // step's extraction tool (Phase 5, `extract:`) is one it calls while it waits.
  const allow = step.extract && !step.tools.allowed.includes(step.extract.tool) ? [...step.tools.allowed, step.extract.tool] : [...step.tools.allowed];
  const derived: PolicyDoc = {
    tools: { allow, require: [...step.tools.required] },
    ...(Object.keys(budgets).length ? { budgets } : {}),
    // Prose checkpoint rules are judged by the verifier role, so the step permits it too.
    ...(step.model ? { modelRoles: step.checkpoint.length ? [...new Set([step.model, VERIFIER_ROLE])] : [step.model] } : {}),
  };
  return {
    kind: 'step',
    name: `${workflowId}/${step.id}`,
    source: step.file,
    doc: step.policy ? mergeStricter(derived, step.policy) : derived,
  };
}

export interface LayersForInput {
  domainPolicy?: PolicyDoc;
  /** Plugin layers, top to bottom (see `pluginLayers`). */
  plugins?: PolicyLayer[];
  workflow: WorkflowDef;
  step?: StepDef;
}

export function layersFor({ domainPolicy, plugins = [], workflow, step }: LayersForInput): PolicyLayer[] {
  const layers: PolicyLayer[] = [PLATFORM_DEFAULTS, ...plugins];
  if (domainPolicy) {
    layers.push({ kind: 'domain', name: domainPolicy.name ?? 'domain', source: domainPolicy.file, doc: domainPolicy });
  }
  if (workflow.policy) {
    layers.push({ kind: 'workflow', name: workflow.id, source: workflow.policy.file, doc: workflow.policy });
  }
  if (step) layers.push(stepLayer(step, workflow.id));
  return layers;
}

/**
 * What a bound plugin contributes to policy (22 §3, D30): its default policy, the domain's
 * tightening of it in the binding, and the tools it binds (so a step using one gets its layers).
 */
export interface PluginPolicy {
  plugin: string;
  /** The manifest's `policy:`, and where it was read. */
  policy?: PolicyDoc;
  source?: string;
  /** The binding's `policy:` (the domain's tightening), and the binding file. */
  bindingPolicy?: PolicyDoc;
  bindingSource?: string;
  /** Tool names the binding binds (not `off`). */
  tools: string[];
}

/**
 * The plugin layers of a step: for the plugin the workflow comes from (`origin.kind: plugin`),
 * then for each plugin owning a tool the step allows or requires (by plugin id), its default
 * policy followed by the binding's tightening. Without a step: the workflow's own plugin only.
 */
export function pluginLayers(plugins: PluginPolicy[] | Record<string, PluginPolicy> | undefined, workflow: Pick<WorkflowDef, 'origin'>, step?: Pick<StepDef, 'tools'>): PolicyLayer[] {
  const all = Array.isArray(plugins) ? plugins : Object.values(plugins ?? {});
  if (!all.length) return [];
  const relevant: PluginPolicy[] = [];
  const origin = workflow.origin?.kind === 'plugin' ? all.find((p) => p.plugin === workflow.origin!.plugin) : undefined;
  if (origin) relevant.push(origin);
  if (step) {
    const used = new Set([...step.tools.allowed, ...step.tools.required]);
    for (const p of [...all].sort((a, b) => a.plugin.localeCompare(b.plugin))) {
      if (p !== origin && p.tools.some((t) => used.has(t))) relevant.push(p);
    }
  }
  const layers: PolicyLayer[] = [];
  for (const p of relevant) {
    if (p.policy) layers.push({ kind: 'plugin', name: p.plugin, ...(p.source ? { source: p.source } : {}), doc: p.policy });
    if (p.bindingPolicy) layers.push({ kind: 'plugin', name: `${p.plugin} binding`, ...(p.bindingSource ? { source: p.bindingSource } : {}), doc: p.bindingPolicy });
  }
  return layers;
}

/**
 * Two docs of the same layer combined: where both speak, the stricter wins. No violations here,
 * since neither sits above the other.
 */
export function mergeStricter(a: PolicyDoc, b: PolicyDoc): PolicyDoc {
  const out: PolicyDoc = { ...a, ...b };

  if (a.effects || b.effects) {
    const effects: NonNullable<PolicyDoc['effects']> = { ...a.effects };
    for (const [cls, t] of Object.entries(b.effects ?? {}) as [EffectClass, Treatment][]) {
      const cur = effects[cls];
      effects[cls] = cur ? stricter(cur, t) : t;
    }
    out.effects = effects;
  }

  if (a.tools || b.tools) {
    const ta = a.tools ?? {};
    const tb = b.tools ?? {};
    const tools: NonNullable<PolicyDoc['tools']> = {};
    const allow = intersect(ta.allow, tb.allow);
    if (allow) tools.allow = allow;
    const deny = union(ta.deny, tb.deny);
    if (deny) tools.deny = deny;
    const require = union(ta.require, tb.require);
    if (require) tools.require = require;
    if (ta.rules || tb.rules) {
      const rules = { ...ta.rules };
      for (const [tool, r] of Object.entries(tb.rules ?? {})) {
        const prev = rules[tool];
        if (!prev) { rules[tool] = r; continue; }
        const merged = { ...prev, ...r };
        if (prev.treatment && r.treatment) merged.treatment = stricter(prev.treatment, r.treatment);
        if (prev.rateLimit && r.rateLimit) {
          merged.rateLimit = compareRate(r.rateLimit, prev.rateLimit) < 0 ? r.rateLimit : prev.rateLimit;
        }
        rules[tool] = merged;
      }
      tools.rules = rules;
    }
    out.tools = tools;
  }

  if (a.budgets || b.budgets) {
    const budgets = { ...a.budgets };
    const bb = b.budgets ?? {};
    for (const key of ['tokens', 'timeMs', 'modelCalls'] as const) {
      const v = bb[key];
      if (v !== undefined) budgets[key] = budgets[key] === undefined ? v : Math.min(budgets[key]!, v);
    }
    if (bb.money) budgets.money = budgets.money ? (lowerMoney(budgets.money, bb.money) ?? budgets.money) : bb.money;
    out.budgets = budgets;
  }

  const roles = intersect(a.modelRoles, b.modelRoles);
  if (roles) out.modelRoles = roles;

  if (a.approvals || b.approvals) {
    const by = intersect(a.approvals?.by, b.approvals?.by);
    out.approvals = by ? { ...a.approvals, ...b.approvals, by } : { ...a.approvals, ...b.approvals };
  }

  if (a.taint || b.taint) {
    const ea = a.taint?.enabled, eb = b.taint?.enabled;
    const wa = a.taint?.outboundWhenTainted, wb = b.taint?.outboundWhenTainted;
    out.taint = {
      ...(ea !== undefined || eb !== undefined ? { enabled: ea === true || eb === true } : {}),
      ...(wa || wb ? { outboundWhenTainted: wa && wb ? stricter(wa, wb) : (wa ?? wb)! } : {}),
    };
  }
  return out;
}

function intersect(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b && [...b];
  if (!b) return [...a];
  return a.filter((x) => b.includes(x));
}

function union(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
