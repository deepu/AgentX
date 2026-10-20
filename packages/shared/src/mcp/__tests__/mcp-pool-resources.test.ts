/**
 * McpClientPool resources & prompts: the connect-time feature probe (counts +
 * server instructions), paginated listing, resource reads (text joined, blobs
 * saved, large results guarded), prompt rendering, and the errors the agent sees
 * for sources that are not connected, API sources and missing capabilities.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';

class TestPool extends McpClientPool {
  async add(slug: string, client: PoolClient): Promise<void> {
    await this.registerClient(slug, client);
  }
}

interface FakeServer {
  capabilities?: ServerCapabilities;
  instructions?: string;
  tools?: Tool[];
  /** One array per page; the cursor is the next page's index */
  resources?: Resource[][];
  templates?: ResourceTemplate[][] | 'fail';
  prompts?: Prompt[][];
  /** Overrides the index cursor (e.g. a server that keeps returning the same one) */
  nextCursor?: (page: number) => string | undefined;
  read?: (uri: string) => ReadResourceResult;
  prompt?: (name: string, args?: Record<string, string>) => GetPromptResult;
  callTool?: () => unknown;
  failProbe?: boolean;
}

interface FakeClient extends PoolClient {
  calls: Array<{ method: string; arg?: unknown; timeoutMs?: number }>;
}

function fakeClient(server: FakeServer): FakeClient {
  const calls: FakeClient['calls'] = [];
  const page = <T>(pages: T[][] | undefined, cursor?: string) => {
    const index = cursor ? Number(cursor.replace(/\D/g, '')) || 0 : 0;
    const nextCursor = server.nextCursor
      ? server.nextCursor(index)
      : pages && index + 1 < pages.length ? String(index + 1) : undefined;
    return { items: pages?.[index] ?? [], nextCursor };
  };
  return {
    calls,
    listTools: async () => server.tools ?? [],
    callTool: async () => server.callTool?.() ?? { content: [] },
    close: async () => {},
    getServerCapabilities: () => server.capabilities,
    getInstructions: () => server.instructions,
    listResources: async (cursor, options) => {
      calls.push({ method: 'listResources', arg: cursor, timeoutMs: options?.timeoutMs });
      if (server.failProbe && options?.timeoutMs !== undefined) throw new Error('Request timed out');
      const { items, nextCursor } = page(server.resources, cursor);
      return { resources: items, ...(nextCursor ? { nextCursor } : {}) };
    },
    listResourceTemplates: async (cursor, options) => {
      calls.push({ method: 'listResourceTemplates', arg: cursor, timeoutMs: options?.timeoutMs });
      if (server.templates === 'fail') throw new Error('MCP error -32601: Method not found');
      const { items, nextCursor } = page(server.templates, cursor);
      return { resourceTemplates: items, ...(nextCursor ? { nextCursor } : {}) };
    },
    readResource: async (uri) => {
      calls.push({ method: 'readResource', arg: uri });
      return server.read?.(uri) ?? { contents: [] };
    },
    listPrompts: async (cursor, options) => {
      calls.push({ method: 'listPrompts', arg: cursor, timeoutMs: options?.timeoutMs });
      const { items, nextCursor } = page(server.prompts, cursor);
      return { prompts: items, ...(nextCursor ? { nextCursor } : {}) };
    },
    getPrompt: async (name, args) => {
      calls.push({ method: 'getPrompt', arg: { name, args } });
      return server.prompt?.(name, args) ?? { messages: [] };
    },
  };
}

/** An API-source-like client: tools only. */
function toolsOnlyClient(): PoolClient {
  return { listTools: async () => [], callTool: async () => ({ content: [] }), close: async () => {} };
}

const resource = (n: number): Resource => ({ uri: `liza://guides/${n}`, name: `guide-${n}` });
const BOTH: ServerCapabilities = { tools: {}, resources: {}, prompts: {} };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('McpClientPool feature probe', () => {
  test('records server instructions and first-page counts when a source connects', async () => {
    const pool = new TestPool();
    const client = fakeClient({
      capabilities: BOTH,
      instructions: '  Read liza://guides/knowledge-authoring before writing entries.\n',
      resources: [[resource(1), resource(2)], [resource(3)]],
      templates: [[{ uriTemplate: 'liza://guides/{name}', name: 'guide' }]],
      prompts: [[{ name: 'playbook' }]],
    });
    await pool.add('liza', client);
    await pool.whenFeaturesProbed('liza');

    expect(pool.getSourceFeatures('liza')).toEqual({
      instructions: 'Read liza://guides/knowledge-authoring before writing entries.',
      resources: { count: 2, more: true },
      resourceTemplates: { count: 1, more: false },
      prompts: { count: 1, more: false },
    });
    // One page per list, bounded by the probe timeout
    expect(client.calls.filter(c => c.method === 'listResources')).toEqual([{ method: 'listResources', arg: undefined, timeoutMs: 3_000 }]);
  });

  test('only lists what the server declared, and a failing probe never fails the connection', async () => {
    const pool = new TestPool();
    const client = fakeClient({ capabilities: { tools: {}, resources: {} }, failProbe: true, tools: [{ name: 'search', inputSchema: { type: 'object' } }] });
    await pool.add('docs', client);
    await pool.whenFeaturesProbed('docs');

    expect(pool.isConnected('docs')).toBe(true);
    expect(pool.getProxyToolDefs().map(d => d.name)).toEqual(['mcp__docs__search']);
    expect(pool.getSourceFeatures('docs')).toEqual({ resourceTemplates: { count: 0, more: false } });
    expect(client.calls.some(c => c.method === 'listPrompts')).toBe(false);
  });

  test('does not hold up the connection for a slow probe', async () => {
    const pool = new TestPool();
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = fakeClient({ capabilities: BOTH, resources: [[resource(1)]] })
    const listResources = client.listResources!.bind(client)
    client.listResources = async (...args) => { await gate; return listResources(...args) }

    await pool.add('slow', client);
    expect(pool.isConnected('slow')).toBe(true);
    expect(pool.getSourceFeatures('slow')).toBeUndefined();

    release();
    await pool.whenFeaturesProbed('slow');
    expect(pool.getSourceFeatures('slow')?.resources).toEqual({ count: 1, more: false });
  });

  test('records nothing for API sources and forgets features on disconnect', async () => {
    const pool = new TestPool();
    await pool.add('api', toolsOnlyClient());
    expect(pool.getSourceFeatures('api')).toBeUndefined();

    await pool.add('liza', fakeClient({ capabilities: BOTH, instructions: 'hi' }));
    await pool.whenFeaturesProbed('liza');
    expect(pool.getSourceFeatures('liza')?.instructions).toBe('hi');
    await pool.disconnect('liza');
    expect(pool.getSourceFeatures('liza')).toBeUndefined();
  });
});

describe('McpClientPool.listResources / listPrompts', () => {
  test('follows cursors across pages and includes resource templates', async () => {
    const pool = new TestPool();
    const client = fakeClient({
      capabilities: BOTH,
      resources: [[resource(1)], [resource(2)], [resource(3)]],
      templates: [[{ uriTemplate: 'liza://guides/{name}', name: 'guide' }]],
    });
    await pool.add('liza', client);

    const listing = await pool.listResources('liza');
    expect(listing.resources.map(r => r.uri)).toEqual(['liza://guides/1', 'liza://guides/2', 'liza://guides/3']);
    expect(listing.resourceTemplates.map(t => t.uriTemplate)).toEqual(['liza://guides/{name}']);
    expect(listing.truncated).toBe(false);
  });

  test('stops at the page cap, and at a cursor the server already returned', async () => {
    const pool = new TestPool();
    const endless = fakeClient({ capabilities: BOTH, resources: [[resource(1)]], nextCursor: page => `p${page + 1}` });
    await pool.add('endless', endless);
    const capped = await pool.listResources('endless');
    expect(capped.truncated).toBe(true);
    expect(endless.calls.filter(c => c.method === 'listResources' && c.timeoutMs === undefined)).toHaveLength(10);

    const looping = fakeClient({ capabilities: BOTH, prompts: [[{ name: 'a' }]], nextCursor: () => 'same' });
    await pool.add('looping', looping);
    const prompts = await pool.listPrompts('looping');
    expect(prompts.truncated).toBe(false);
    expect(looping.calls.filter(c => c.method === 'listPrompts' && c.timeoutMs === undefined)).toHaveLength(2);
  });

  test('a server without resource templates still lists its resources', async () => {
    const pool = new TestPool();
    await pool.add('liza', fakeClient({ capabilities: BOTH, resources: [[resource(1)]], templates: 'fail' }));
    const listing = await pool.listResources('liza');
    expect(listing.resources).toHaveLength(1);
    expect(listing.resourceTemplates).toEqual([]);
  });

  test('explains sources that are not connected, API sources and missing capabilities', async () => {
    const pool = new TestPool();
    await pool.add('api', toolsOnlyClient());
    await pool.add('tools-only', fakeClient({ capabilities: { tools: {} } }));

    await expect(pool.listResources('nope')).rejects.toThrow('Source "nope" is not connected');
    await expect(pool.readResource('api', 'x://y')).rejects.toThrow('Source "api" is an API source');
    await expect(pool.listResources('tools-only')).rejects.toThrow('did not declare the resources capability');
    await expect(pool.getPrompt('tools-only', 'p')).rejects.toThrow('did not declare the prompts capability');
  });
});

describe('McpClientPool.readResource / getPrompt', () => {
  let sessionPath: string;

  beforeEach(() => {
    sessionPath = mkdtempSync(join(tmpdir(), 'mcp-pool-resources-'));
  });
  afterEach(() => rmSync(sessionPath, { recursive: true, force: true }));

  test('returns a single text resource as-is', async () => {
    const pool = new TestPool({ sessionPath });
    await pool.add('liza', fakeClient({
      capabilities: BOTH,
      read: uri => ({ contents: [{ uri, mimeType: 'text/markdown', text: '# Knowledge authoring' }] }),
    }));
    expect(await pool.readResource('liza', 'liza://guides/knowledge-authoring')).toBe('# Knowledge authoring');
  });

  test('labels several contents and saves blobs to downloads/', async () => {
    const pool = new TestPool({ sessionPath });
    await pool.add('liza', fakeClient({
      capabilities: BOTH,
      read: () => ({
        contents: [
          { uri: 'liza://a', mimeType: 'text/markdown', text: 'A' },
          { uri: 'liza://b', mimeType: 'image/png', blob: PNG.toString('base64') },
        ],
      }),
    }));

    const text = await pool.readResource('liza', 'liza://dir');
    expect(text).toContain('--- liza://a (text/markdown) ---\nA');
    expect(text).toContain('--- liza://b (image/png) ---\n[Resource saved: ');
    const path = text.match(/\[Resource saved: (\S+) /)?.[1];
    expect(path?.startsWith(join(sessionPath, 'downloads'))).toBe(true);
    expect(path?.endsWith('.png')).toBe(true);
    expect(readFileSync(path!)).toEqual(PNG);
  });

  test('saves a large resource to long_responses/ like a large tool result', async () => {
    const pool = new TestPool({ sessionPath });
    const big = 'A guide paragraph that keeps going.\n'.repeat(4_000);
    await pool.add('liza', fakeClient({ capabilities: BOTH, read: uri => ({ contents: [{ uri, text: big }] }) }));

    const text = await pool.readResource('liza', 'liza://guides/huge');
    expect(text).toContain('Full data saved to: ');
    const saved = text.match(/Full data saved to: (\S+)/)?.[1];
    expect(saved?.includes('long_responses')).toBe(true);
    expect(existsSync(saved!)).toBe(true);
    expect(text.length).toBeLessThan(big.length);
  });

  test('renders prompt messages with roles, inlined text resources, saved images and resource links', async () => {
    const pool = new TestPool({ sessionPath });
    const client = fakeClient({
      capabilities: BOTH,
      prompt: (_name, args) => ({
        description: 'Write a knowledge entry',
        messages: [
          { role: 'user', content: { type: 'text', text: `Write an entry about ${args?.topic}.` } },
          { role: 'user', content: { type: 'resource', resource: { uri: 'liza://guides/style', mimeType: 'text/markdown', text: '# Style' } } },
          { role: 'assistant', content: { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' } },
          { role: 'user', content: { type: 'resource_link', uri: 'liza://guides/more', name: 'More' } },
        ],
      }),
    });
    await pool.add('liza', client);

    const text = await pool.getPrompt('liza', 'write-entry', { topic: 'MCP' });
    expect(client.calls.at(-1)).toEqual({ method: 'getPrompt', arg: { name: 'write-entry', args: { topic: 'MCP' } } });
    expect(text.startsWith('Description: Write a knowledge entry\n\n[user]\nWrite an entry about MCP.')).toBe(true);
    expect(text).toContain('[user]\n[Resource liza://guides/style (text/markdown)]\n# Style');
    expect(text).toMatch(/\[assistant\]\n\[Image saved: \S+\.png /);
    expect(text).toContain('[user]\n[Resource link: liza://guides/more (More). Read it with source_read_resource.]');
  });

  test('says so when a prompt has no messages', async () => {
    const pool = new TestPool({ sessionPath });
    await pool.add('liza', fakeClient({ capabilities: BOTH }));
    expect(await pool.getPrompt('liza', 'empty')).toBe('Prompt "empty" returned no messages.');
  });

  test('callTool still saves image blocks, and passes error results through unguarded', async () => {
    const pool = new TestPool({ sessionPath });
    let result: unknown = { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] };
    await pool.add('docs', fakeClient({ tools: [{ name: 'shot', inputSchema: { type: 'object' } }], callTool: () => result }));

    const ok = await pool.callTool('mcp__docs__shot', {});
    expect(ok.isError).toBe(false);
    expect(ok.content).toMatch(/^ok\n\[Image saved: \S+\.png \(12 B\)\]$/);

    const huge = 'x '.repeat(60_000);
    result = { content: [{ type: 'text', text: huge }], isError: true };
    expect(await pool.callTool('mcp__docs__shot', {})).toEqual({ content: huge, isError: true });
  });
});

describe('MemWiseMcpClient resources & prompts over stdio', () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-server-resources.mjs');

  test(
    'probes, lists across pages, reads and gets prompts from a real MCP server',
    async () => {
      const pool = new McpClientPool();
      try {
        await pool.connect('docs', { type: 'stdio', command: 'node', args: [FIXTURE] });
        await pool.whenFeaturesProbed('docs');

        expect(pool.getSourceFeatures('docs')).toEqual({
          instructions: 'Read docs://guides/start before calling tools.',
          resources: { count: 1, more: true },
          resourceTemplates: { count: 1, more: false },
          prompts: { count: 1, more: false },
        });

        const listing = await pool.listResources('docs');
        expect(listing.resources.map(r => r.uri)).toEqual(['docs://guides/start', 'docs://guides/style']);
        expect(listing.resourceTemplates.map(t => t.uriTemplate)).toEqual(['docs://guides/{name}']);

        expect(await pool.readResource('docs', 'docs://guides/style')).toBe('# style');
        await expect(pool.readResource('docs', 'docs://guides/missing')).rejects.toThrow('Resource not found');

        expect((await pool.listPrompts('docs')).prompts.map(p => p.name)).toEqual(['review']);
        expect(await pool.getPrompt('docs', 'review', { topic: 'MCP' })).toBe('[user]\nReview MCP');
      } finally {
        await pool.disconnectAll();
      }
    },
    15_000,
  );
});
