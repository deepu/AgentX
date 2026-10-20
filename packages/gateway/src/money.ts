/**
 * Pricing model calls (19 §7). The step engine adds up `spendOf` per call and stops the step
 * when `exceedsMoney` says the policy's money budget is spent. Pure functions.
 */
import type { Money, TokenUsage } from '@memwise/defs';
import { moneyExceeded } from '@memwise/policy';
import type { ModelPrice } from './types.ts';

/**
 * What one call cost: from the role's `price` when it has one (cache reads and writes count as
 * input, and a provider that reports only a total, like the scripted one, has it priced as
 * input), else pi-ai's own cost in USD. Undefined when neither is known.
 */
export function spendOf(usage: TokenUsage, price?: ModelPrice): Money | undefined {
  if (price) {
    let input = usage.input + usage.cacheRead + usage.cacheWrite;
    const output = usage.output;
    if (input + output === 0 && usage.totalTokens > 0) input = usage.totalTokens;
    const amount = (input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000;
    return { amount: round(amount), currency: price.currency };
  }
  if (usage.costUsd !== undefined) return { amount: round(usage.costUsd), currency: 'USD' };
  return undefined;
}

/** `a + b` in one currency; undefined when the currencies differ. */
export function addMoney(a: Money | undefined, b: Money | undefined): Money | undefined {
  if (!a) return b && { ...b };
  if (!b) return { ...a };
  if (a.currency !== b.currency) return undefined;
  return { amount: round(a.amount + b.amount), currency: a.currency };
}

/**
 * Whether `spent` meets or passes `budget`. Undefined when the currencies differ and there is
 * no rate between them: the caller warns ("money budget not enforced: no rate from USD to INR")
 * instead of guessing.
 */
export function exceedsMoney(spent: Money, budget: Money): boolean | undefined {
  return moneyExceeded(spent, budget);
}

/** Avoids float dust (0.1 + 0.2) in stored amounts; well below any currency's smallest unit. */
const round = (n: number) => Math.round(n * 1e9) / 1e9;
