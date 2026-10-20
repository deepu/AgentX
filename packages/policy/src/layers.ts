/**
 * Building the layer stack a step runs under (08 §2): platform → plugins → domain → workflow → step.
 */
import type { PolicyDoc, StepDef, WorkflowDef } from '@memwise/defs';
import { compareRate, lowerMoney, stricter } from './order.ts';
import type { PolicyLayer } from './types.ts';

/** Tools the step engine provides to every step; never listed, never denied. */
export const BUILTIN_TOOLS: readonly string[] = ['step.finish', 'checkpoint.verdict'];

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

/** The step's own layer: its tool list, budget and model role, merged with its `policy:` block. */
export function stepLayer(step: StepDef, workflowId: string): PolicyLayer {
  const budgets: NonNullable<PolicyDoc['budgets']> = {};
  if (step.budget?.tokens !== undefined) budgets.tokens = step.budget.tokens;
  if (step.budget?.timeMs !== undefined) budgets.timeMs = step.budget.timeMs;
  if (step.budget?.modelCalls !== undefined) budgets.modelCalls = step.budget.modelCalls;

  // A step may call only what it lists, so the allow list is set even when it is empty.
  const derived: PolicyDoc = {
    tools: { allow: [...step.tools.allowed], require: [...step.tools.required] },
    ...(Object.keys(budgets).length ? { budgets } : {}),
    ...(step.model ? { modelRoles: [step.model] } : {}),
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
 * Two docs of the same layer combined: where both speak, the stricter wins. No violations here,
 * since neither sits above the other.
 */
export function mergeStricter(a: PolicyDoc, b: PolicyDoc): PolicyDoc {
  const out: PolicyDoc = { ...a, ...b };

  if (a.effects || b.effects) {
    const effects = { ...a.effects };
    for (const [cls, t] of Object.entries(b.effects ?? {}) as [keyof typeof effects, NonNullable<typeof t>][]) {
      effects[cls] = effects[cls] ? stricter(effects[cls]!, t) : t;
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
