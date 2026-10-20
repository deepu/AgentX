// Plugin tool routes (22 §2): an MCP server over stdio (a tiny fixture server), a subprocess per
// call, and the app's builtins; which tools a binding binds, and with what class.
import { afterAll, describe, expect, test } from 'bun:test';
import type { BindingDef, InstalledPlugin, PluginManifest, PluginToolDef } from '@memwise/defs';
import type { StepToken } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import { join } from 'node:path';
import { discoverMcpTools, McpConnections, mcpResultValue, resolveCommand, runCommandTool } from '../src/plugins/routes.ts';
import { boundPlugins, pluginPolicies, pluginToolEnvironment, pluginTools, toolClass, type BoundPlugin } from '../src/plugins/tools.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'plugins');
const CRM = join(FIXTURES, 'tiny-crm');
const TOOLS = join(FIXTURES, 'tiny-tools');
const server = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] };
const token: StepToken = {
  runId: 'run_1', caseId: 'case_1', stepId: 's', stepRunId: 'run_1/0/s', workflowId: 'w', workflowVersion: 1, agentRole: 'w.s',
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const ctx = (key = 'k1') => ({ idempotencyKey: key, token, secrets: {} });

const tool = (name: string, run: PluginToolDef['run'], effect?: PluginToolDef['effect']): PluginToolDef => ({
  name, description: `${name} does things`, inputSchema: { type: 'object' }, run, ...(effect ? { effect } : {}),
});
const manifest = (id: string, tools: PluginToolDef[], extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id, version: '1.0.0', title: id, trust: 'local', provides: { capabilities: {} }, requires: { capabilities: {}, entities: {}, roles: {} },
  tools: Object.fromEntries(tools.map((t) => [t.name, t])), mcpServers: {}, workflows: [], skills: [], records: {}, file: 'memwise-plugin.yaml', ...extra,
});
const binding = (plugin: string, tools: BindingDef['tools'] = {}, extra: Partial<BindingDef> = {}): BindingDef => ({
  plugin, pluginVersion: '1.0.0', pluginHash: 'h', version: 1, frozen: { by: 'p', at: 'now' }, tools, capabilities: {}, entities: {}, roles: {},
  records: {}, file: `domain/bindings/${plugin.replace('/', '__')}.yaml`, hash: 'b', ...extra,
});
const bp = (m: PluginManifest, b: BindingDef, dir: string): BoundPlugin => ({ manifest: m, binding: b, dir, plugin: { manifest: m, dir, hash: 'h', skills: [], workflows: {} } });

const conns = new McpConnections();
afterAll(() => conns.closeAll());

describe('the MCP route (stdio)', () => {
  test('discovery lists the tools with their schemas and hints', async () => {
    const tools = await discoverMcpTools(server, CRM, 'crm');
    expect(tools.map((t) => t.name)).toEqual(['list_contacts', 'get_contact', 'create_contact', 'fail']);
    expect(tools[0]).toMatchObject({ description: 'List the contacts in the CRM.', annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } });
    expect(tools[2]!.annotations).toBeUndefined();
  });

  test('one connection per server; structured content, JSON text, the idempotency key in _meta; errors throw', async () => {
    const call = (t: string, args: unknown, key = 'k') => conns.call({ key: 'test/crm@1/crm', server, serverName: 'crm', root: CRM, tool: t, args, idempotencyKey: key });
    const listed = await call('list_contacts', {}) as { contacts: { id: string }[] };
    expect(listed.contacts.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(await call('get_contact', { id: 'c2' })).toEqual({ contact: expect.objectContaining({ company_name: 'Menon Exports' }) });
    expect(await call('create_contact', { company_name: 'New Co' }, 'key-1')).toEqual({ id: 'c4', repeated: false, idempotencyKey: 'key-1' });
    expect(await call('create_contact', { company_name: 'New Co' }, 'key-1')).toEqual({ id: 'c4', repeated: true, idempotencyKey: 'key-1' });
    await expect(call('fail', {})).rejects.toThrow('the CRM is down');
    await expect(call('get_contact', { id: 'nope' })).rejects.toThrow('no contact nope');
    expect(conns.open).toBe(1);
  });

  test('a server that does not start says so', async () => {
    await expect(discoverMcpTools({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/nowhere.mjs'] }, CRM, 'gone')).rejects.toThrow(/could not start the MCP server gone/);
    await expect(discoverMcpTools({ source: 'crm' }, CRM, 'crm')).rejects.toThrow(/resolveMcpSource/);
  });

  test('results: structured first, then JSON text, then the text', () => {
    expect(mcpResultValue({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] }, 't')).toEqual({ a: 1 });
    expect(mcpResultValue({ content: [{ type: 'text', text: '{"a":2}' }] }, 't')).toEqual({ a: 2 });
    expect(mcpResultValue({ content: [{ type: 'text', text: 'hello' }] }, 't')).toBe('hello');
    expect(() => mcpResultValue({ isError: true, content: [{ type: 'text', text: 'bad' }] }, 't')).toThrow('t failed: bad');
  });

  test('${CLAUDE_PLUGIN_ROOT} is the installed folder', () => {
    const r = resolveCommand('node', ['${CLAUDE_PLUGIN_ROOT}/server.mjs'], { DATA: '${CLAUDE_PLUGIN_ROOT}/data' }, '/opt/p');
    expect(r.args).toEqual(['/opt/p/server.mjs']);
    expect(r.env.DATA).toBe('/opt/p/data');
  });
});

describe('the command route', () => {
  test('JSON on stdin, JSON from stdout, the idempotency key in the environment', async () => {
    expect(await runCommandTool({ command: ['node', 'shout.mjs'], args: { word: 'hi' }, root: TOOLS, idempotencyKey: 'k9', tool: 'tiny.shout' }))
      .toEqual({ word: 'HI', key: 'k9' });
  });

  test("the subprocess gets a safe environment and the route's own, never the kernel's secrets", async () => {
    process.env.MW_TEST_DATABASE_SECRET = 'postgres://secret@db/memwise';
    try {
      const script = 'process.stdout.write(JSON.stringify({ secret: process.env.MW_TEST_DATABASE_SECRET ?? null, key: process.env.MEMWISE_IDEMPOTENCY_KEY, path: !!process.env.PATH }))';
      expect(await runCommandTool({ command: ['node', '-e', script], args: {}, root: TOOLS, idempotencyKey: 'k7', tool: 'env' }))
        .toEqual({ secret: null, key: 'k7', path: true });
    } finally {
      delete process.env.MW_TEST_DATABASE_SECRET;
    }
  });

  test('a failing command and a slow one are errors', async () => {
    await expect(runCommandTool({ command: ['node', 'shout.mjs'], args: { word: 'boom' }, root: TOOLS, idempotencyKey: 'k', tool: 'tiny.shout' }))
      .rejects.toThrow('tiny.shout exited with 3: it exploded');
    await expect(runCommandTool({ command: ['node', '-e', 'setTimeout(() => {}, 5000)'], args: {}, root: TOOLS, idempotencyKey: 'k', tool: 'slow', timeoutMs: 200 }))
      .rejects.toThrow('slow timed out after 200 ms');
  });
});

describe('plugin tools from bindings', () => {
  const lookup: ToolDefinition = {
    name: 'tiny.lookup', description: 'the app builtin', inputSchema: { type: 'object' }, effect: 'read', quarantine: true,
    execute: async (args: { word: string }) => ({ found: args.word }),
  };
  const tiny = manifest('test/tiny-tools', [
    tool('tiny.shout', { command: ['node', 'shout.mjs'] }, 'read'),
    tool('tiny.lookup', { builtin: 'tiny.lookup' }, 'read'),
    tool('tiny.missing', { builtin: 'tiny.nowhere' }, 'read'),
    tool('tiny.raw', { command: ['node', 'shout.mjs'] }),
    tool('tiny.off', { command: ['node', 'shout.mjs'] }, 'write'),
    tool('domain.thing.create', { command: ['node', 'shout.mjs'] }, 'write'),
    tool('email.send', { command: ['node', 'shout.mjs'] }, 'outbound'),
  ], { policy: { effects: { write: 'preview' } } });
  const tinyBinding = binding('test/tiny-tools', { 'tiny.off': { off: true }, 'tiny.raw': { effect: 'write', reason: 'it writes' } }, { policy: { effects: { outbound: 'deny' } } });
  const deps = { root: join(FIXTURES, '..'), builtins: new Map([['tiny.lookup', lookup]]), mcp: conns };
  // The fixture folder stands in for the project, the plugin for its installed folder.
  const bound = [bp(tiny, tinyBinding, 'plugins/tiny-tools')];

  test('classes: the binding wins, then the declared one; off is not bound; reserved and taken names are not bound', async () => {
    expect(toolClass(tiny.tools['tiny.raw']!, tinyBinding)).toEqual({ effect: 'write', from: 'binding' });
    expect(toolClass(tiny.tools['tiny.shout']!, tinyBinding)).toEqual({ effect: 'read', from: 'declared' });
    expect(toolClass(tiny.tools['tiny.raw']!)).toEqual({ from: 'none' });
    const taken = new Map<string, ToolDefinition>([['email.send', { ...lookup, name: 'email.send' }]]);
    const { tools, diagnostics } = pluginTools(bound, taken, deps);
    expect(tools.map((t) => t.name).sort()).toEqual(['tiny.lookup', 'tiny.missing', 'tiny.raw', 'tiny.shout']);
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['tool-name-reserved', 'tool-name-taken']);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('tiny.raw')).toMatchObject({ effect: 'write', source: { plugin: 'test/tiny-tools' } });
    // A builtin keeps the app's quarantine.
    expect(byName.get('tiny.lookup')!.quarantine).toBe(true);
    expect(await byName.get('tiny.lookup')!.execute({ word: 'gst' }, ctx())).toEqual({ found: 'gst' });
    await expect(byName.get('tiny.missing')!.execute({}, ctx())).rejects.toThrow('runs the built-in tool tiny.nowhere, which this app does not have');
  });

  test('a binding that loosens a declared class does not take effect; a stricter one does', () => {
    const send = tiny.tools['email.send']!;
    expect(toolClass(send, binding('test/tiny-tools', { 'email.send': { effect: 'read' } }))).toEqual({ effect: 'outbound', from: 'declared' });
    expect(toolClass(send, binding('test/tiny-tools', { 'email.send': { effect: 'irreversible' } }))).toEqual({ effect: 'irreversible', from: 'binding' });
    const loose = [bp(tiny, binding('test/tiny-tools', { 'tiny.shout': { effect: 'read' }, 'tiny.off': { effect: 'read' } }), 'plugins/tiny-tools')];
    expect(pluginToolEnvironment(loose)['tiny.off']).toMatchObject({ effect: 'write' });
    expect(pluginTools(loose, new Map(), deps).tools.find((t) => t.name === 'tiny.off')).toMatchObject({ effect: 'write' });
  });

  test('environment and policy sources come from the binding, without connecting', () => {
    const env = pluginToolEnvironment(bound);
    expect(env['tiny.raw']).toMatchObject({ effect: 'write' });
    expect(env['tiny.off']).toBeUndefined();
    expect(pluginPolicies(bound)).toEqual([expect.objectContaining({
      plugin: 'test/tiny-tools', policy: { effects: { write: 'preview' } }, bindingPolicy: { effects: { outbound: 'deny' } },
      bindingSource: 'domain/bindings/test__tiny-tools.yaml',
    })]);
    expect(pluginPolicies(bound)[0]!.tools).not.toContain('tiny.off');
  });

  test("a plugin's policy is renamed through its binding: capability aliases and roles", () => {
    const intake = manifest('test/intake', [], {
      requires: { capabilities: { email_send: { as: 'email.send' } }, entities: {}, roles: {} },
      policy: { tools: { deny: ['email.send'], rules: { 'email.send': { rateLimit: { count: 5, perMs: 60_000 } } } }, approvals: { by: ['boss'] } } as PluginManifest['policy'],
    });
    const b = binding('test/intake', {}, { capabilities: { email_send: 'mail.send_message' }, roles: { boss: 'manager' } });
    const [p] = pluginPolicies([bp(intake, b, 'plugins/test__intake/1.0.0')]);
    expect(p!.policy).toEqual({ tools: { deny: ['mail.send_message'], rules: { 'mail.send_message': { rateLimit: { count: 5, perMs: 60_000 } } } }, approvals: { by: ['manager'] } });
    // The manifest itself is untouched.
    expect(intake.policy!.tools!.deny).toEqual(['email.send']);
  });

  test('boundPlugins pins the version the binding names', () => {
    const v1 = { manifest: tiny, dir: 'plugins/test__tiny-tools/1.0.0', hash: 'h', skills: [], workflows: {} } as InstalledPlugin;
    const v2 = { manifest: { ...tiny, version: '2.0.0' }, dir: 'plugins/test__tiny-tools/2.0.0', hash: 'h2', skills: [], workflows: {} } as InstalledPlugin;
    const found = boundPlugins({ plugins: { 'test/tiny-tools': v2 }, pluginVersions: { 'test/tiny-tools': { '1.0.0': v1, '2.0.0': v2 } }, bindings: { 'test/tiny-tools': tinyBinding } });
    expect(found.map((b) => b.dir)).toEqual(['plugins/test__tiny-tools/1.0.0']);
    expect(boundPlugins({ plugins: { 'test/tiny-tools': v2 }, bindings: { 'test/tiny-tools': tinyBinding } })).toEqual([]);
  });
});
