/**
 * Proxy tools: tools the Pi subprocess registers but the main process executes
 * (session tools, source tools, call_llm). Each call is sent as one
 * `tool_execute_request` and its `tool_execute_response` becomes the Pi result.
 *
 * Permission is NOT checked here. Every tool, proxy tools included, is wrapped by
 * `wrapToolsWithHooks` in index.ts, which sends the one `pre_tool_use_request` per
 * call. Checking again here asked twice in Ask mode and fired PreToolUse
 * automations twice per call.
 */

import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Proxy tool definition from main process */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProxyToolResult {
  content: string;
  isError: boolean;
}

export interface ProxyToolDeps {
  /** Sends a tool_execute_request to the main process and resolves with its response. */
  executeInMainProcess: (toolName: string, toolCallId: string, args: Record<string, unknown>) => Promise<ProxyToolResult>;
  /** Takes (and removes) the in-flight speculative prefetch for this call, if any. */
  takePrefetched?: (toolCallId: string) => Promise<ProxyToolResult> | undefined;
  debugLog?: (message: string) => void;
}

/**
 * A main-process tool result as a Pi tool result. Failures are flagged with
 * `isError` (Pi >=0.99) so the model gets an error tool result and
 * `tool_execution_end.isError` marks the call failed in MemWise, as a thrown error
 * would; before, they reached both as successes.
 */
export function proxyToolResult(result: ProxyToolResult): AgentToolResult<undefined> {
  return {
    content: [{ type: 'text', text: result.content }],
    details: undefined,
    ...(result.isError ? { isError: true } : {}),
  };
}

export function buildProxyToolDefinitions(defs: ProxyToolDef[], deps: ProxyToolDeps): ToolDefinition<any, any>[] {
  deps.debugLog?.(`Building proxy tools from ${defs.length} definitions: ${defs.map(t => t.name).join(', ')}`);

  return defs.map<ToolDefinition<any, any>>(def => ({
    name: def.name,
    label: def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    description: def.description,
    // Pi SDK omits tools without promptSnippet from the system prompt's
    // "Available tools" section, making them invisible to the LLM.
    // Derive a snippet from the description so proxy tools are listed.
    promptSnippet: def.description.length > 200
      ? def.description.slice(0, 197) + '...'
      : def.description,
    parameters: def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<any>> => {
      // Check speculative prefetch cache first (parallel call_llm optimization).
      // If this tool was prefetched on message_end, the request is already in-flight —
      // just await the result instead of sending a duplicate request.
      const prefetched = deps.takePrefetched?.(toolCallId);
      if (prefetched) {
        deps.debugLog?.(`Prefetch cache hit for ${def.name} (toolCallId: ${toolCallId})`);
        return proxyToolResult(await prefetched);
      }

      // Already approved by the hook wrapper (wrapToolsWithHooks); execute via main process.
      const result = await deps.executeInMainProcess(def.name, toolCallId, params as Record<string, unknown>);
      return proxyToolResult(result);
    },
  }));
}
