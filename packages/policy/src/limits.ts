/**
 * Rate limits and money budgets as pure checks (19 §7). The counting itself (mw.rate_events)
 * and the spending (priced model calls) happen in the gateway and step engine; these say what
 * the rule is and how a refusal reads.
 */
import type { Money } from '@memwise/defs';
import { duration } from './describe.ts';
import type { RateLimit } from './order.ts';
import type { EffectivePolicy } from './types.ts';

/** The rate limit on a tool under this policy, if any. */
export function rateLimitOf(policy: EffectivePolicy, tool: string): RateLimit | undefined {
  const r = policy.tools.perTool[tool]?.rateLimit?.value;
  return r && { count: r.count, perMs: r.perMs };
}

/** Whether one more call fits, given the times (ms) of calls already counted. */
export function checkRateLimit(limit: RateLimit, callTimes: number[], now: number): { allowed: boolean; used: number } {
  const used = callTimes.filter((t) => t > now - limit.perMs && t <= now).length;
  return { allowed: used < limit.count, used };
}

/** The message the agent sees: `rate limit: gst.validate_gstin allows 10 calls per 1m; try later`. */
export function rateLimitRefusal(tool: string, limit: RateLimit): string {
  return `rate limit: ${tool} allows ${limit.count} call${limit.count === 1 ? '' : 's'} per ${duration(limit.perMs)}; try later`;
}

/**
 * Whether `spent` is over `budget`. `undefined` when they can't be compared (different
 * currencies and no rate): the caller reports that rather than guessing.
 */
export function moneyExceeded(spent: Money, budget: Money): boolean | undefined {
  if (spent.currency !== budget.currency) return undefined;
  return spent.amount >= budget.amount;
}
