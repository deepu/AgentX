/**
 * A real model provider on pi-ai (D38): one streamed request per call, pi-ai's retries off.
 */
import { createModels, type Provider, type Tool } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { ModelProvider } from '../types.ts';

const BUILTIN: Record<string, () => Provider<any>> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export interface PiAiProviderOptions {
  /** pi-ai provider id: `anthropic` or `openai`, or any id when `provider` is given. */
  id: string;
  /** Otherwise pi-ai resolves the key from the environment (e.g. `ANTHROPIC_API_KEY`). */
  apiKey?: string;
  /** Point the catalog model at another endpoint (a gateway, or a fake server in tests). */
  baseUrl?: string;
  /** Any other pi-ai provider, e.g. from `@earendil-works/pi-ai/providers/<id>`. */
  provider?: Provider<any>;
}

export function piAiProvider({ id, apiKey, baseUrl, provider }: PiAiProviderOptions): ModelProvider {
  const make = provider ? () => provider : BUILTIN[id];
  if (!make) throw new Error(`pi-ai provider "${id}" is not built in (${Object.keys(BUILTIN).join(', ')}); pass it as \`provider\``);
  const models = createModels();
  models.setProvider(make());

  return {
    id,
    async complete(modelId, request, options) {
      const catalog = models.getModel(id, modelId);
      if (!catalog) throw new Error(`model "${modelId}" is not in pi-ai's ${id} catalog`);
      const model = baseUrl ? { ...catalog, baseUrl } : catalog;
      const stream = models.stream(model, {
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        // `parameters` is JSON Schema, which is what a TypeBox TSchema is at runtime.
        tools: request.tools as Tool[],
      }, {
        apiKey,
        sessionId: options.sessionId, // stable across resume; providers use it for cache affinity
        cacheRetention: 'short',
        maxRetries: 0, // retries belong to one layer: the DBOS step policy
        signal: options.signal,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      });
      for await (const _ of stream) {
        // Live deltas would go to the UI here; only the final message is journaled.
      }
      return stream.result();
    },
  };
}
