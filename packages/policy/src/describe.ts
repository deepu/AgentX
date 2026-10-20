/**
 * The effective-policy view (08 §2: "shown with the source of every rule"), and violations as
 * check diagnostics.
 */
import { EFFECT_CLASSES, type Diagnostic } from '@memwise/defs';
import { originLabel } from './order.ts';
import type { EffectivePolicy, PolicyViolation, Sourced } from './types.ts';

const line = (label: string, s: Sourced<unknown>, text: string) => `  ${label}: ${text}  (${originLabel(s.origin)})`;

export function describePolicy(effective: EffectivePolicy): string {
  const out: string[] = ['effects'];
  for (const cls of EFFECT_CLASSES) {
    const e = effective.effects[cls];
    out.push(line(cls, e, e.value));
  }

  const { allowed, denied, required, perTool } = effective.tools;
  out.push('tools');
  out.push(allowed ? line('allowed', allowed, allowed.value.join(', ') || '(none)') : '  allowed: any tool bound in the domain');
  for (const d of denied) out.push(line('denied', d, d.value));
  for (const r of required) out.push(line('required', r, r.value));
  for (const [tool, rule] of Object.entries(perTool)) {
    if (rule.treatment) out.push(line(tool, rule.treatment, rule.treatment.value));
    if (rule.rateLimit) {
      const { count, perMs } = rule.rateLimit.value;
      out.push(line(`${tool} rate limit`, rule.rateLimit, `${count} per ${duration(perMs)}`));
    }
  }

  const b = effective.budgets;
  out.push('budgets');
  if (b.tokens) out.push(line('tokens', b.tokens, String(b.tokens.value)));
  if (b.timeMs) out.push(line('time', b.timeMs, duration(b.timeMs.value)));
  if (b.modelCalls) out.push(line('model calls', b.modelCalls, String(b.modelCalls.value)));
  if (b.money) out.push(line('money', b.money, `${b.money.value.amount} ${b.money.value.currency}`));
  if (!b.tokens && !b.timeMs && !b.modelCalls && !b.money) out.push('  none');

  out.push('model roles');
  const roles = effective.modelRoles;
  out.push(roles ? line('roles', roles, roles.value.join(', ') || '(none)') : '  roles: any');

  const { enabled, outboundWhenTainted } = effective.taint;
  out.push('taint');
  out.push(line('enabled', enabled, enabled.value ? 'on' : 'off'));
  out.push(line('outbound when tainted', outboundWhenTainted, outboundWhenTainted.value));

  out.push(`layers: ${effective.layers.map(({ kind, ...rest }) => originLabel({ layer: kind, ...rest })).join(' → ')}`);
  return out.join('\n');
}

export function violationsToDiagnostics(violations: PolicyViolation[]): Diagnostic[] {
  return violations.map((v) => ({
    severity: 'error' as const,
    code: 'policy-loosened',
    message: v.message,
    ...(v.source ? { file: v.source } : {}),
    path: v.path,
  }));
}

/** 600000 → `10m`, 5400000 → `1h30m`, the way files write durations. */
function duration(ms: number): string {
  const units: [string, number][] = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]];
  let rest = ms;
  let text = '';
  for (const [unit, size] of units) {
    const n = Math.floor(rest / size);
    if (n) { text += `${n}${unit}`; rest -= n * size; }
  }
  return rest || !text ? `${text}${rest}ms` : text;
}
