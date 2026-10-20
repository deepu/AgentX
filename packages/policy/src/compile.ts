/**
 * The policy compiler: layers in, effective policy out, tighten only (D30, 08 §2).
 *
 * Layers are applied top to bottom. Each rule remembers the layer that set it; a lower layer
 * that restates a rule keeps the upper origin (unless the upper one is a platform default), one
 * that tightens it takes over, and one that tries to loosen it is recorded as a violation and
 * ignored.
 */
import { EFFECT_CLASSES, type EffectClass, type PolicyDoc, type Treatment } from '@memwise/defs';
import { BUILTIN_TOOLS, PLATFORM_DEFAULTS } from './layers.ts';
import { compareRate, lowerMoney, originLabel, originOf, rank } from './order.ts';
import type {
  CompiledPolicy, EffectivePolicy, PolicyBudgets, PolicyLayer, PolicyViolation, RuleOrigin, Sourced,
} from './types.ts';

export function compilePolicy(layers: PolicyLayer[]): CompiledPolicy {
  const violations: PolicyViolation[] = [];
  const effects: Partial<Record<EffectClass, Sourced<Treatment>>> = {};
  let allowed: Sourced<string[]> | null = null;
  const denied: Sourced<string>[] = [];
  const required: Sourced<string>[] = [];
  const perTool: EffectivePolicy['tools']['perTool'] = {};
  const budgets: PolicyBudgets = {};
  const runBudgets: PolicyBudgets = {};
  let modelRoles: Sourced<string[]> | null = null;
  let approvers: Sourced<string[]> | undefined;
  let taintEnabled: Sourced<boolean> | undefined;
  let taintOutbound: Sourced<Treatment> | undefined;
  // Origins in layer order, to tell which of two rules sits lower.
  const origins: RuleOrigin[] = [];

  for (const layer of layers) {
    const origin = originOf(layer);
    origins.push(origin);
    const doc = layer.doc;
    // Restating an upper rule keeps its origin, except a platform default: a layer that says it
    // explicitly owns it from then on (the platform is only the fallback).
    const claims = (cur: Sourced<unknown>) => cur.origin.layer === 'platform' && layer.kind !== 'platform';
    const violate = (path: string, message: string, loosens: RuleOrigin) =>
      violations.push({ ...origin, path, message: `${layer.name}: ${message}`, loosens });

    // Treatments: effect classes, then the taint treatment.
    const tighten = (path: string, cur: Sourced<Treatment> | undefined, value: Treatment): Sourced<Treatment> => {
      if (!cur || rank(value) > rank(cur.value)) return { value, origin };
      if (rank(value) === rank(cur.value)) return claims(cur) ? { value, origin } : cur;
      violate(path, `sets ${path} to ${value}, looser than ${cur.value} from ${originLabel(cur.origin)}`, cur.origin);
      return cur;
    };
    for (const cls of EFFECT_CLASSES) {
      const t = doc.effects?.[cls];
      if (t) effects[cls] = tighten(`effects.${cls}`, effects[cls], t);
    }
    if (doc.taint?.outboundWhenTainted) {
      taintOutbound = tighten('taint.outboundWhenTainted', taintOutbound, doc.taint.outboundWhenTainted);
    }
    if (doc.taint?.enabled !== undefined) {
      if (!taintEnabled || (doc.taint.enabled && !taintEnabled.value) || (doc.taint.enabled === taintEnabled.value && claims(taintEnabled))) {
        taintEnabled = { value: doc.taint.enabled, origin };
      } else if (!doc.taint.enabled && taintEnabled.value) {
        violate('taint.enabled', `turns taint tracking off, which ${originLabel(taintEnabled.origin)} turns on`, taintEnabled.origin);
      }
    }

    // Tools. Built-ins are always available, so listing or denying them means nothing.
    const tools = doc.tools ?? {};
    const own = (list?: string[]) => list && [...new Set(list)].filter((t) => !BUILTIN_TOOLS.includes(t));
    for (const tool of own(tools.deny) ?? []) {
      if (!denied.some((d) => d.value === tool)) denied.push({ value: tool, origin });
    }
    const deniedAbove = (tool: string) => denied.find((d) => d.value === tool && d.origin !== origin);
    const allow = own(tools.allow);
    if (allow) {
      const kept: string[] = [];
      for (const tool of allow) {
        const d = deniedAbove(tool);
        if (d) violate('tools.allow', `allows ${tool}, which ${originLabel(d.origin)} denies`, d.origin);
        else if (allowed && !allowed.value.includes(tool)) {
          violate('tools.allow', `allows ${tool}, which is not in the allowed tools of ${originLabel(allowed.origin)}`, allowed.origin);
        } else kept.push(tool);
      }
      // Restating the same list keeps the upper origin; narrowing it takes over.
      if (!allowed || kept.length < allowed.value.length) allowed = { value: kept, origin };
    }
    for (const tool of own(tools.require) ?? []) {
      const d = deniedAbove(tool);
      if (d) violate('tools.require', `requires ${tool}, which ${originLabel(d.origin)} denies`, d.origin);
      else if (!required.some((r) => r.value === tool)) required.push({ value: tool, origin });
    }

    for (const [tool, rule] of Object.entries(tools.rules ?? {})) {
      const cur = (perTool[tool] ??= {});
      if (rule.treatment) cur.treatment = tighten(`tools.rules.${tool}.treatment`, cur.treatment, rule.treatment);
      if (rule.rateLimit) {
        const path = `tools.rules.${tool}.rateLimit`;
        const limit = { count: rule.rateLimit.count, perMs: rule.rateLimit.perMs };
        if (!cur.rateLimit || compareRate(limit, cur.rateLimit.value) < 0) cur.rateLimit = { value: limit, origin };
        else if (compareRate(limit, cur.rateLimit.value) > 0) {
          violate(path, `sets a looser rate limit for ${tool} than ${originLabel(cur.rateLimit.origin)}`, cur.rateLimit.origin);
        }
      }
    }

    // Budgets: the lowest wins. Those above the step layer are also the run's budgets.
    tightenBudgets(budgets, doc.budgets, origin, violate);
    if (layer.kind !== 'step') tightenBudgets(runBudgets, doc.budgets, origin, () => {});

    if (doc.modelRoles) {
      const kept: string[] = [];
      for (const role of new Set(doc.modelRoles)) {
        if (modelRoles && !modelRoles.value.includes(role)) {
          violate('modelRoles', `permits model role ${role}, which ${originLabel(modelRoles.origin)} does not`, modelRoles.origin);
        } else kept.push(role);
      }
      if (!modelRoles || kept.length < modelRoles.value.length) modelRoles = { value: kept, origin };
    }

    // Approver roles narrow like model roles: a lower layer may only take roles away.
    if (doc.approvals?.by) {
      const kept: string[] = [];
      for (const role of new Set(doc.approvals.by)) {
        if (approvers && !approvers.value.includes(role)) {
          violate('approvals.by', `lets ${role} decide approvals, which ${originLabel(approvers.origin)} does not`, approvers.origin);
        } else kept.push(role);
      }
      if (!approvers || kept.length < approvers.value.length) approvers = { value: kept, origin };
    }
  }

  // A tool denied anywhere is not allowed, whatever an upper allow list said.
  if (allowed && denied.length) {
    const value = allowed.value.filter((t) => !denied.some((d) => d.value === t));
    if (value.length < allowed.value.length) allowed = { value, origin: allowed.origin };
  }

  // A requirement the step can't meet. Blame whichever of the two rules sits lower.
  const keptRequired: Sourced<string>[] = [];
  for (const req of required) {
    const d = denied.find((x) => x.value === req.value);
    const excluder = d?.origin ?? (allowed && !allowed.value.includes(req.value) ? allowed.origin : undefined);
    if (!excluder) { keptRequired.push(req); continue; }
    const [blamed, other] = origins.indexOf(req.origin) >= origins.indexOf(excluder)
      ? [req.origin, excluder] : [excluder, req.origin];
    violations.push({
      ...blamed,
      path: 'tools.require',
      message: `${blamed.name}: ${req.value} is required by ${originLabel(req.origin)} but not allowed by ${originLabel(excluder)}`,
      loosens: other,
    });
  }

  // Anything no layer set falls back to the platform default, so a short stack still fails safe.
  const platform = originOf(PLATFORM_DEFAULTS);
  const defaults = PLATFORM_DEFAULTS.doc;
  const fullEffects = Object.fromEntries(EFFECT_CLASSES.map((cls) => [
    cls, effects[cls] ?? { value: defaults.effects![cls]!, origin: platform },
  ])) as Record<EffectClass, Sourced<Treatment>>;

  return {
    effective: {
      effects: fullEffects,
      tools: { allowed, denied, required: keptRequired, perTool },
      budgets,
      runBudgets,
      modelRoles,
      ...(approvers ? { approvers } : {}),
      taint: {
        enabled: taintEnabled ?? { value: defaults.taint!.enabled!, origin: platform },
        outboundWhenTainted: taintOutbound ?? { value: defaults.taint!.outboundWhenTainted!, origin: platform },
      },
      layers: layers.map((l) => {
        const { layer: kind, ...rest } = originOf(l);
        return { kind, ...rest };
      }),
    },
    violations,
  };
}

/** Lowers `budgets` to `doc`'s where they are lower; a higher one is a violation and ignored. */
function tightenBudgets(
  budgets: PolicyBudgets, doc: PolicyDoc['budgets'], origin: RuleOrigin,
  violate: (path: string, message: string, loosens: RuleOrigin) => void,
): void {
  for (const key of ['tokens', 'timeMs', 'modelCalls'] as const) {
    const v = doc?.[key];
    if (v === undefined) continue;
    const cur = budgets[key];
    if (!cur || v < cur.value) budgets[key] = { value: v, origin };
    else if (v > cur.value) {
      violate(`budgets.${key}`, `sets budgets.${key} to ${v}, above ${cur.value} from ${originLabel(cur.origin)}`, cur.origin);
    }
  }
  const money = doc?.money;
  if (money) {
    const cur = budgets.money;
    if (!cur) budgets.money = { value: money, origin };
    else {
      const lower = lowerMoney(cur.value, money);
      if (!lower) {
        violate('budgets.money', `currency mismatch: ${money.currency} against ${cur.value.currency} from ${originLabel(cur.origin)}`, cur.origin);
      } else if (money.amount < cur.value.amount) budgets.money = { value: money, origin };
      else if (money.amount > cur.value.amount) {
        violate('budgets.money', `sets budgets.money to ${money.amount} ${money.currency}, above ${cur.value.amount} from ${originLabel(cur.origin)}`, cur.origin);
      }
    }
  }
}
