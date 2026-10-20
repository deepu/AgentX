/**
 * McpClientPool effect journal (docs/memwise/07-agent-runtime.md §4): opt-in; when set, every
 * tool call is recorded with an effect class seeded from the tool's MCP annotations.
 */

import { describe, test, expect } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, effectFromAnnotations, type McpEffectJournalEntry } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import { proxyToolName } from '../proxy-tool-name.ts';

const tools: Tool[] = [
  { name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'send_email', inputSchema: { type: 'object' }, annotations: { openWorldHint: true } },
  { name: 'delete_all', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
  { name: 'mystery', inputSchema: { type: 'object' } },
];

class TestPool extends McpClientPool {
  async add(slug: string): Promise<void> {
    const client: PoolClient = {
      listTools: async () => tools,
      callTool: async (name: string) => {
        if (name === 'delete_all') throw new Error('refused');
        return { content: [{ type: 'text', text: `${name} ok` }] };
      },
      close: async () => {},
    };
    await this.registerClient(slug, client);
  }
}

describe('effectFromAnnotations', () => {
  test('only explicit hints classify', () => {
    expect(effectFromAnnotations(undefined)).toBeUndefined();
    expect(effectFromAnnotations({ readOnlyHint: true, openWorldHint: true })).toBe('read');
    expect(effectFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('irreversible');
    expect(effectFromAnnotations({ openWorldHint: true })).toBe('outbound');
    expect(effectFromAnnotations({ readOnlyHint: false, destructiveHint: false })).toBeUndefined();
  });
});

describe('McpClientPool effect journal', () => {
  test('without a journal, calls behave as before', async () => {
    const pool = new TestPool();
    await pool.add('crm');
    expect(await pool.callTool(proxyToolName('crm', 'search'), { q: 'x' })).toEqual({ content: 'search ok', isError: false });
  });

  test('records each call with its class, result or error', async () => {
    const pool = new TestPool();
    await pool.add('crm');
    const entries: McpEffectJournalEntry[] = [];
    pool.setEffectJournal({ record: (e) => { entries.push(e); } });

    for (const name of ['search', 'send_email', 'delete_all', 'mystery']) await pool.callTool(proxyToolName('crm', name), { n: name });
    await pool.callTool('mcp__crm__nope', {}); // unknown: nothing ran, nothing recorded

    expect(entries.map(({ startedAt, durationMs, ...rest }) => rest)).toEqual([
      { server: 'crm', tool: 'search', effect: 'read', classified: true, args: { n: 'search' }, result: 'search ok' },
      { server: 'crm', tool: 'send_email', effect: 'outbound', classified: true, args: { n: 'send_email' }, result: 'send_email ok' },
      { server: 'crm', tool: 'delete_all', effect: 'irreversible', classified: true, args: { n: 'delete_all' }, error: 'MCP tool "delete_all" (source: crm) failed: refused' },
      { server: 'crm', tool: 'mystery', effect: 'irreversible', classified: false, args: { n: 'mystery' }, result: 'mystery ok' },
    ]);
    expect(typeof entries[0]!.startedAt).toBe('string');
  });

  test('a failing journal does not change the result', async () => {
    const pool = new TestPool();
    await pool.add('crm');
    pool.setEffectJournal({ record: async () => { throw new Error('disk full'); } });
    expect(await pool.callTool(proxyToolName('crm', 'search'), {})).toEqual({ content: 'search ok', isError: false });
  });
});
