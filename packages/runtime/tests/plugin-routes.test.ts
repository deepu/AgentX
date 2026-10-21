// Plugin tool routes (22 §2): an MCP server over stdio (a tiny fixture server) or streamable HTTP
// (a fake of the PubMed connector, 25 §8), a subprocess per call, and the app's builtins; which
// tools a binding binds, and with what class.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  bindingToYaml, importClaudePlugin, installPlugin, loadProject, withDiscoveredTools,
  type BindingDef, type EffectLedger, type InstalledPlugin, type LedgerState, type PluginManifest, type PluginToolDef,
} from '@memwise/defs';
import type { StepToken } from '@memwise/defs';
import { createToolGateway, type ToolDefinition } from '@memwise/gateway';
import { compilePolicy, PLATFORM_DEFAULTS, pluginLayers } from '@memwise/policy';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTAIN_2, GLP1_QUERY, startFakePubmed } from './fixtures/fake-pubmed-http.ts';
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

describe('the MCP route (HTTP)', () => {
  // The PubMed Claude plugin as published (25 §1), its server's URL pointed at the fake.
  const EXAMPLE = join(import.meta.dir, '..', '..', '..', 'examples', 'literature');
  const http = new McpConnections();
  let fake: Awaited<ReturnType<typeof startFakePubmed>>;
  let tmp: string;
  let project: string;
  let source: string;

  beforeAll(async () => {
    fake = await startFakePubmed();
    tmp = mkdtempSync(join(tmpdir(), 'mw-pubmed-'));
    source = join(tmp, 'pubmed');
    project = join(tmp, 'project');
    mkdirSync(join(source, '.claude-plugin'), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(source, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'pubmed', version: '1.0.0', description: 'PubMed MCP server for searching biomedical literature and research articles',
      author: { name: 'U.S. National Library of Medicine', url: 'https://www.nlm.nih.gov' },
      mcpServers: { PubMed: { type: 'http', url: fake.url } },
    }, null, 2));
  });
  afterAll(async () => {
    await http.closeAll();
    await fake.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('the server is stateless: no session id, like the real one', async () => {
    const r = await fetch(fake.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeNull();
  });

  test('installing the Claude plugin finds its seven tools as PubMed.*, unclassified, with their schemas and hints', async () => {
    // What PluginsService.install does for an imported plugin, without the database it records into.
    let { manifest } = await importClaudePlugin(source);
    expect(manifest).toMatchObject({ id: 'claude/pubmed', version: '1.0.0', trust: 'community', mcpServers: { PubMed: { url: fake.url } } });
    const discovered = await discoverMcpTools(manifest.mcpServers.PubMed!, source, 'PubMed');
    manifest = withDiscoveredTools(manifest, 'PubMed', discovered);
    expect(await installPlugin(project, source, { manifest })).toMatchObject({ id: 'claude/pubmed', dir: 'plugins/claude__pubmed/1.0.0', created: true });

    const { project: defs } = await loadProject(project);
    const installed = defs.pluginVersions!['claude/pubmed']!['1.0.0']!;
    expect(Object.keys(installed.manifest.tools)).toEqual([
      'PubMed.convert_article_ids', 'PubMed.find_related_articles', 'PubMed.get_article_metadata', 'PubMed.get_copyright_status',
      'PubMed.get_full_text_article', 'PubMed.lookup_article_by_citation', 'PubMed.search_articles',
    ]);
    const search = installed.manifest.tools['PubMed.search_articles']!;
    expect(search).toMatchObject({ run: { mcp: 'PubMed', tool: 'search_articles' }, annotations: { readOnlyHint: true } });
    expect(search.effect).toBeUndefined();
    expect(toolClass(search)).toEqual({ from: 'none' });
    expect((search.inputSchema as { required: string[] }).required).toEqual(['query']);
    expect(Object.keys((search.inputSchema as { properties: object }).properties).sort())
      .toEqual(['date_from', 'date_to', 'datetype', 'max_results', 'query', 'retstart', 'sort']);

    // The example project ships the same tools (made this way), with the real server's URL.
    const { project: example } = await loadProject(EXAMPLE);
    const shipped = example.pluginVersions!['claude/pubmed']!['1.0.0']!.manifest;
    expect(shipped.tools).toEqual(installed.manifest.tools);
    expect(shipped.mcpServers).toEqual({ PubMed: { url: 'https://pubmed.mcp.claude.com/mcp' } });
    expect(example.bindings?.['claude/pubmed']?.tools['PubMed.search_articles']).toEqual({ effect: 'read' });
  });

  test('PubMed.search_articles through its binding and the gateway: structured content back', async () => {
    const { project: before } = await loadProject(project);
    const p = before.pluginVersions!['claude/pubmed']!['1.0.0']!;
    mkdirSync(join(project, 'domain', 'bindings'), { recursive: true });
    writeFileSync(join(project, 'domain', 'bindings', 'claude__pubmed.yaml'), bindingToYaml(binding('claude/pubmed',
      Object.fromEntries(Object.keys(p.manifest.tools).map((t) => [t, { effect: 'read' as const }])),
      { pluginHash: p.hash, file: 'domain/bindings/claude__pubmed.yaml' })));
    const { project: defs } = await loadProject(project);
    const bound = boundPlugins(defs);
    expect(bound.map((b) => b.dir)).toEqual(['plugins/claude__pubmed/1.0.0']);
    const { tools, diagnostics } = pluginTools(bound, new Map(), { root: defs.root, builtins: new Map(), mcp: http });
    expect(diagnostics).toEqual([]);
    expect(tools.map((t) => [t.name, t.effect])).toContainEqual(['PubMed.search_articles', 'read']);

    const rows = new Map<string, LedgerState>();
    const ledger: EffectLedger = {
      async begin(key) { const row = rows.get(key); if (row) return row; rows.set(key, { status: 'pending', startedAt: new Date().toISOString() }); return { status: 'new' }; },
      async complete(key, result) { rows.set(key, { status: 'done', result }); },
      async fail(key, error) { rows.set(key, { status: 'failed', error }); },
    };
    const gateway = createToolGateway({ tools, ledger });
    const { effective } = compilePolicy([PLATFORM_DEFAULTS, ...pluginLayers(pluginPolicies(bound), { origin: undefined }, { tools: { allowed: ['PubMed.search_articles'], required: [] } })]);
    const args = { query: GLP1_QUERY, datetype: 'edat', max_results: 50 };
    const decision = await gateway.check({ tool: 'PubMed.search_articles', args, token }, effective, { tainted: false });
    expect(decision.decision.verdict).toBe('allow');
    const r = await gateway.execute({ tool: 'PubMed.search_articles', args, callId: 'c1', idempotencyKey: 'run_1/0/s:PubMed.search_articles', token }, decision);
    expect(r).toMatchObject({ status: 'ok' });
    expect(r.status === 'ok' && r.result).toEqual({
      pmids: ['99000002', '41275875', '99000001'], total_count: 3, returned_count: 3, query: GLP1_QUERY,
      query_translation: expect.stringContaining('[All Fields]'), has_more: false,
    });
    expect(fake.calls.at(-1)).toEqual({ name: 'search_articles', args });

    // By entry date: nothing added since ATTAIN-2's week but Example Review B; a page of one says there is more.
    const pubmed = tools.find((t) => t.name === 'PubMed.search_articles')!;
    expect(await pubmed.execute({ query: GLP1_QUERY, datetype: 'edat', date_from: '2025/12/01' }, ctx('k2'))).toMatchObject({ pmids: ['99000002'], total_count: 1 });
    expect(await pubmed.execute({ query: GLP1_QUERY, max_results: 1, retstart: 1 }, ctx('k3'))).toMatchObject({ pmids: ['41275875'], returned_count: 1, has_more: true });

    const meta = await tools.find((t) => t.name === 'PubMed.get_article_metadata')!.execute({ pmids: ['41275875'] }, ctx('k4')) as { articles: unknown[]; count: number };
    expect(meta.count).toBe(1);
    expect(meta.articles[0]).toMatchObject({
      identifiers: { pmid: '41275875', doi: '10.1016/S0140-6736(25)02165-8' }, title: ATTAIN_2.title,
      journal: { iso_abbreviation: 'Lancet' }, publication_date: { year: '2025' }, citation: { volume: '406', issue: '10522', pages: '2927-2944' },
      abstract: expect.stringContaining('1613 (757 [46·9%] female) were randomly assigned'),
    });
    await expect(tools.find((t) => t.name === 'PubMed.get_full_text_article')!.execute({ pmc_ids: ['PMC1'] }, ctx('k5'))).rejects.toThrow(/get_full_text_article failed/);
    expect(http.open).toBe(1);
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
