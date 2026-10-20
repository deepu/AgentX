/**
 * Example-case tool stubs (05 §12): the same definitions, so classification, policy, previews
 * and the ledger behave as in a real run, with execution replaced by the example's results.
 */
import type { ToolDefinition } from './types.ts';

/** One result for every call, or `{ results: [...] }` consumed in call order. */
export type ToolStub = unknown | { results: unknown[] };

export type StubbedTools = ToolDefinition[] & {
  /** How many times each stubbed tool actually ran (ledger replays do not count). */
  calls: Record<string, number>;
};

const isSequence = (s: unknown): s is { results: unknown[] } =>
  !!s && typeof s === 'object' && Array.isArray((s as { results?: unknown }).results);

/** Tools without a stub are returned unchanged (built-ins such as `step.finish` and recall tools). */
export function stubTools(tools: ToolDefinition[], stubs: Record<string, ToolStub>): StubbedTools {
  const calls: Record<string, number> = {};
  const out = tools.map((tool): ToolDefinition => {
    if (!Object.hasOwn(stubs, tool.name)) return tool;
    const stub = stubs[tool.name];
    calls[tool.name] = 0;
    return {
      ...tool,
      async execute() {
        const n = calls[tool.name]!++;
        if (!isSequence(stub)) return structuredClone(stub);
        if (n >= stub.results.length) throw new Error(`stub for ${tool.name} has ${stub.results.length} result(s); call ${n + 1} has none`);
        return structuredClone(stub.results[n]);
      },
    };
  });
  return Object.assign(out, { calls });
}
