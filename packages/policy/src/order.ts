/**
 * Orderings the compiler tightens along: treatments, rate limits, budgets.
 */
import { TREATMENTS, type Money, type Treatment } from '@memwise/defs';
import type { LayerKind, PolicyLayer, RuleOrigin } from './types.ts';

export const rank = (t: Treatment): number => TREATMENTS.indexOf(t);

export const stricter = (a: Treatment, b: Treatment): Treatment => (rank(b) > rank(a) ? b : a);

export interface RateLimit { count: number; perMs: number }

/** -1: `a` is stricter (fewer calls per ms), 0: same rate, 1: `a` is looser. */
export function compareRate(a: RateLimit, b: RateLimit): number {
  // Cross-multiplied so equal rates written differently (10/1m, 1/6s) compare equal.
  return Math.sign(a.count * b.perMs - b.count * a.perMs);
}

/** The lower amount when both are in one currency; `undefined` when they can't be compared. */
export function lowerMoney(a: Money, b: Money): Money | undefined {
  if (a.currency !== b.currency) return undefined;
  return b.amount < a.amount ? b : a;
}

export function originOf(layer: PolicyLayer): RuleOrigin {
  const source = layer.source ?? layer.doc.file;
  return source === undefined
    ? { layer: layer.kind, name: layer.name }
    : { layer: layer.kind, name: layer.name, source };
}

/** `domain, domain/policy.yaml` or `step client-intake/check, workflows/.../check.md`. */
export function originLabel(o: { layer: LayerKind; name: string; source?: string }): string {
  const who = o.name === o.layer ? o.name : `${o.layer} ${o.name}`;
  return o.source ? `${who}, ${o.source}` : who;
}
