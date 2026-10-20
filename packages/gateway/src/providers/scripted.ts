/**
 * A deterministic provider for example cases and tests: replies come from a script per model
 * role, chosen by the conversation turn (the number of assistant messages already in the
 * request), never by a counter. A repeated request, e.g. after a resume, gets the same reply.
 */
import type { AssistantMessage, TextContent, ToolCall, Usage } from '@earendil-works/pi-ai';
import type { ScriptedTurn } from '@memwise/defs';
import { modelToolName, type ModelProvider } from '../types.ts';

/** Tokens reported per scripted call, so token budgets can be exercised. */
export const SCRIPTED_TOKENS_PER_CALL = 100;

const usage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: SCRIPTED_TOKENS_PER_CALL,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export interface ScriptedProviderOptions {
  /** Called on every real invocation, so tests can count them. */
  onCall?: (role: string, turn: number) => void;
}

export function scriptedProvider(script: Record<string, ScriptedTurn[]>, opts: ScriptedProviderOptions = {}): ModelProvider {
  return {
    id: 'scripted',
    async complete(model, request, { role }) {
      const turn = request.messages.filter((m) => m.role === 'assistant').length;
      opts.onCall?.(role, turn);
      const base = {
        role: 'assistant' as const, api: 'anthropic-messages', provider: 'scripted', model, usage: usage(),
        // Deterministic: the same request yields a byte-identical reply.
        timestamp: request.messages.at(-1)?.timestamp ?? 0,
      };
      const step = script[role]?.[turn];
      if (!step) {
        return { ...base, content: [], stopReason: 'error', errorMessage: `script exhausted for role ${role} (turn ${turn})` } satisfies AssistantMessage;
      }
      const content: (TextContent | ToolCall)[] = [];
      if (step.text) content.push({ type: 'text', text: step.text });
      (step.toolCalls ?? []).forEach((call, i) => {
        content.push({ type: 'toolCall', id: `call_${role.replace(/[^A-Za-z0-9_-]/g, '_')}_${turn}_${i}`, name: modelToolName(call.name), arguments: structuredClone(call.args) as ToolCall['arguments'] });
      });
      return { ...base, content, stopReason: step.toolCalls?.length ? 'toolUse' : 'stop' } satisfies AssistantMessage;
    },
  };
}
