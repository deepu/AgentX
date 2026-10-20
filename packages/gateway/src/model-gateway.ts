/**
 * The thin model gateway (docs/memwise/07-agent-runtime.md §5): role -> provider and model,
 * budget check before the call, fallback when a provider fails, a record of every attempt.
 * One attempt per provider: retries belong to the DBOS step policy (D38).
 */
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { TokenUsage } from '@memwise/defs';
import { spendOf } from './money.ts';
import {
  BudgetExceededError,
  type Budget, type ModelCallResult, type ModelGateway, type ModelGatewayOptions, type ModelProvider, type Spent,
} from './types.ts';

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const toTokenUsage = (u: Usage): TokenUsage => ({
  input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
  totalTokens: u.totalTokens, costUsd: u.cost?.total,
});

/** The first limit `spent` already meets, if any. */
export function exceededLimit(budget: Budget | undefined, spent: Spent | undefined): keyof Budget | undefined {
  if (!budget) return undefined;
  const s = spent ?? { tokens: 0, modelCalls: 0, elapsedMs: 0 };
  if (budget.tokens !== undefined && s.tokens >= budget.tokens) return 'tokens';
  if (budget.modelCalls !== undefined && s.modelCalls >= budget.modelCalls) return 'modelCalls';
  if (budget.timeMs !== undefined && s.elapsedMs >= budget.timeMs) return 'timeMs';
  return undefined;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createModelGateway({ roles, providers, sink }: ModelGatewayOptions): ModelGateway {
  const byId = new Map<string, ModelProvider>(providers.map((p) => [p.id, p]));

  return {
    roles: () => roles,

    async call(request, { role, sessionId, signal, budget, spent }): Promise<ModelCallResult> {
      const config = roles[role];
      if (!config) throw new Error(`unknown model role "${role}"; configured roles: ${Object.keys(roles).join(', ') || 'none'}`);
      const limit = exceededLimit(budget, spent);
      if (limit) throw new BudgetExceededError(limit, budget!, spent ?? { tokens: 0, modelCalls: 0, elapsedMs: 0 });

      const failures: string[] = [];
      for (const { provider: providerId, model, price } of [{ provider: config.provider, model: config.model, price: config.price }, ...(config.fallbacks ?? [])]) {
        const startedAt = new Date().toISOString();
        const t0 = performance.now();
        let message: AssistantMessage | undefined;
        let error: string | undefined;
        try {
          const provider = byId.get(providerId);
          if (!provider) throw new Error(`no provider "${providerId}" is registered`);
          message = await provider.complete(model, request, { role, sessionId, signal, maxTokens: config.maxTokens, temperature: config.temperature });
          // A provider reports most failures in the message; it still counts as a failed attempt.
          if (message.stopReason === 'error' || message.stopReason === 'aborted') error = `${message.stopReason}: ${message.errorMessage ?? 'no message'}`;
        } catch (e) {
          error = errorText(e);
        }
        const durationMs = Math.round(performance.now() - t0);
        const usage = message ? toTokenUsage(message.usage) : undefined;
        const cost = usage && spendOf(usage, price);
        if (usage && cost?.currency === 'USD') usage.costUsd = cost.amount;
        await record({
          name: role, sessionId, startedAt, durationMs, error,
          model: { provider: providerId, model, usage: usage ?? toTokenUsage(ZERO_USAGE), stopReason: message?.stopReason ?? 'error' },
        });
        if (!error && message && usage) return { message, provider: providerId, model, usage, durationMs, ...(cost ? { cost } : {}) };
        failures.push(`${providerId}/${model}: ${error}`);
        if (signal?.aborted) break; // cancelled: a fallback would be cancelled too
      }
      throw new Error(`model call for role "${role}" failed: ${failures.join('; ')}`);
    },
  };

  async function record(entry: Parameters<NonNullable<typeof sink>['record']>[0]) {
    if (!sink) return;
    try {
      await sink.record(entry);
    } catch {
      // Metering must not fail a call that already ran: a retry would bill the tokens twice.
    }
  }
}
