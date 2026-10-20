/**
 * The effective-policy view (08 §2: "shown with the source of every rule"), and violations as
 * check diagnostics.
 */
import { EFFECT_CLASSES, type Diagnostic } from '@memwise/defs';
import { originLabel } from './order.ts';
import type { EffectivePolicy, PolicyViolation, Sourced } from './types.ts';

const line = (label: string, s: Sourced<unknown>, text: string) => `  ${label}: ${text}  (${originLabel(s.origin)})`;
/** Rules that are compiled but not yet enforced, so the view does not claim they are in force. */
const NOT_ENFORCED = '  (not enforced until Phase 2)';

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
      out.push(line(`${tool} rate limit`, rule.rateLimit, `${count} per ${duration(perMs)}`) + NOT_ENFORCED);
    }
  }

  const b = effective.budgets;
  out.push('budgets');
  if (b.tokens) out.push(line('tokens', b.tokens, String(b.tokens.value)));
  if (b.timeMs) out.push(line('time', b.timeMs, duration(b.timeMs.value)));
  if (b.modelCalls) out.push(line('model calls', b.modelCalls, String(b.modelCalls.value)));
  if (b.money) out.push(line('money', b.money, `${b.money.value.amount} ${b.money.value.currency}`) + NOT_ENFORCED);
  if (!b.tokens && !b.timeMs && !b.modelCalls && !b.money) out.push('  none');
  // A step that tightens a run budget hides it above; it still applies to the whole run.
  const run = effective.runBudgets ?? {};
  const byStep = (s?: Sourced<unknown>) => s?.origin.layer === 'step';
  if (run.tokens && byStep(b.tokens)) out.push(line('run tokens', run.tokens, String(run.tokens.value)));
  if (run.timeMs && byStep(b.timeMs)) out.push(line('run time', run.timeMs, duration(run.timeMs.value)));
  if (run.modelCalls && byStep(b.modelCalls)) out.push(line('run model calls', run.modelCalls, String(run.modelCalls.value)));
  if (run.money && byStep(b.money)) out.push(line('run money', run.money, `${run.money.value.amount} ${run.money.value.currency}`) + NOT_ENFORCED);

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
