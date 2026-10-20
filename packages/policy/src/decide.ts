/**
 * The decision for one tool call (pure; the gateway journals it). The strictest applicable rule wins.
 */
import type { Treatment } from '@memwise/defs';
import { BUILTIN_TOOLS } from './layers.ts';
import { originLabel, rank } from './order.ts';
import type { EffectivePolicy, PolicyDecision, PolicyRequest, RuleOrigin } from './types.ts';

const PLATFORM: RuleOrigin = { layer: 'platform', name: 'platform' };

const VERB: Record<Treatment, string> = {
  allow: 'is allowed',
  preview: 'runs with a recorded preview',
  approve: 'needs approval',
  deny: 'is denied',
};

export function decide(effective: EffectivePolicy, req: PolicyRequest): PolicyDecision {
  const { tool } = req;
  if (BUILTIN_TOOLS.includes(tool)) {
    return { verdict: 'allow', reason: `${tool} is a built-in step tool, always allowed.`, origins: [PLATFORM] };
  }

  const denied = effective.tools.denied.find((d) => d.value === tool);
  if (denied) {
    return { verdict: 'deny', reason: `${tool} is denied by ${originLabel(denied.origin)}.`, origins: [denied.origin] };
  }
  const allowed = effective.tools.allowed;
  if (allowed && !allowed.value.includes(tool)) {
    return {
      verdict: 'deny',
      reason: `${tool} is not in the allowed tools of ${originLabel(allowed.origin)}.`,
      origins: [allowed.origin],
    };
  }

  // Every rule that applies, as [what it is, treatment, where it came from].
  const rules: [string, Treatment, RuleOrigin][] = [];
  const cls = effective.effects[req.effect];
  rules.push([`${req.effect} tools`, cls.value, cls.origin]);
  const own = effective.tools.perTool[tool]?.treatment;
  if (own) rules.push([`the rule for ${tool}`, own.value, own.origin]);
  const { taint } = effective;
  if (req.tainted && taint.enabled.value && (req.effect === 'outbound' || req.effect === 'irreversible')) {
    rules.push(['a tainted session', taint.outboundWhenTainted.value, taint.outboundWhenTainted.origin]);
  }

  const verdict = rules.reduce<Treatment>((v, [, t]) => (rank(t) > rank(v) ? t : v), 'allow');
  const winners = rules.filter(([, t]) => t === verdict);
  const what = req.classified ? `${tool} (${req.effect})` : `${tool} (unclassified tool, treated as irreversible)`;
  const why = winners.map(([label, t, o]) => `${label}: ${t} from ${originLabel(o)}`).join('; ');
  return { verdict, reason: `${what} ${VERB[verdict]}: ${why}.`, origins: winners.map(([, , o]) => o) };
}
