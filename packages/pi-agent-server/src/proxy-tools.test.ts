import { describe, expect, it } from 'bun:test';
import { buildProxyToolDefinitions, type ProxyToolDef } from './proxy-tools.ts';

const def: ProxyToolDef = {
  name: 'mcp__session__playbook_finish',
  description: 'Send the draft for review.',
  inputSchema: { type: 'object', properties: {} },
};

function run(tool: ReturnType<typeof buildProxyToolDefinitions>[number], toolCallId: string, params: Record<string, unknown>) {
  return tool.execute(toolCallId, params, undefined, undefined, undefined as never);
}

describe('proxy tools', () => {
  // The hook wrapper (wrapToolsWithHooks) approves every tool once. A proxy tool
  // that asked again prompted twice in Ask mode and fired PreToolUse automations twice.
  it('executes once in the main process; it has no approval step of its own', async () => {
    const calls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }> = [];
    const deps = {
      executeInMainProcess: async (toolName: string, toolCallId: string, args: Record<string, unknown>) => {
        calls.push({ toolName, toolCallId, args });
        return { content: 'sent', isError: false };
      },
    };
    const [tool] = buildProxyToolDefinitions([def], deps);

    const result = await run(tool!, 'call-1', { summary: 'x' });

    expect(calls).toEqual([{ toolName: def.name, toolCallId: 'call-1', args: { summary: 'x' } }]);
    expect(result.content).toEqual([{ type: 'text', text: 'sent' }]);
    expect(result.isError).toBeUndefined();
  });

  it('flags failed results as errors', async () => {
    const [tool] = buildProxyToolDefinitions([def], {
      executeInMainProcess: async () => ({ content: 'nope', isError: true }),
    });
    const result = await run(tool!, 'call-2', {});
    expect(result.isError).toBe(true);
  });

  it('uses an in-flight prefetch instead of executing again', async () => {
    let executed = 0;
    const [tool] = buildProxyToolDefinitions([def], {
      executeInMainProcess: async () => { executed++; return { content: 'fresh', isError: false }; },
      takePrefetched: (id) => (id === 'call-3' ? Promise.resolve({ content: 'prefetched', isError: false }) : undefined),
    });
    expect((await run(tool!, 'call-3', {})).content).toEqual([{ type: 'text', text: 'prefetched' }]);
    expect(executed).toBe(0);
    expect((await run(tool!, 'call-4', {})).content).toEqual([{ type: 'text', text: 'fresh' }]);
    expect(executed).toBe(1);
  });

  it('labels and lists tools for the model', () => {
    const [tool] = buildProxyToolDefinitions([def], { executeInMainProcess: async () => ({ content: '', isError: false }) });
    expect(tool!.label).toBe('playbook finish');
    expect(tool!.promptSnippet).toBe(def.description);
  });
});
