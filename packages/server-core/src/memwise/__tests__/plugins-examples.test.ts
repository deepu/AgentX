/**
 * Phase 4 pieces that need no kernel (22 §7): the example plugins in `examples/plugins/`, the
 * sample CRM's stdio MCP server (raw JSON lines, and the official MCP client), and the bridge from
 * the workspace's MCP sources to plugins (`connectors.ts`), plus finding the example plugins.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parse as parseYaml } from 'yaml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { activeWorkspaceRoot, createConnectorBridge, sourcePluginManifest } from '../connectors'
import { addMissingMetaPlaybooks, findExamplePlugins, listExamplePlugins } from '../seed'

const REPO = resolve(import.meta.dir, '../../../../..')
const PLUGINS = join(REPO, 'examples', 'plugins')
const CRM = join(PLUGINS, 'sample-crm', 'server.mjs')

const teardown: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  teardown.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------- a raw JSON-RPC line client

interface RawServer {
  request(method: string, params?: unknown): Promise<{ result?: any; error?: { code: number; message: string } }>
  notify(method: string, params?: unknown): void
  sendLine(line: string): void
  next(): Promise<any>
  lines: string[]
  stderr: () => string
  close(): Promise<number | null>
}

function startRaw(env: Record<string, string> = {}): RawServer {
  const child: ChildProcessWithoutNullStreams = spawn('node', [CRM], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += String(d) })
  const lines: string[] = []
  const queue: any[] = []
  const waiters: ((m: any) => void)[] = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    lines.push(line)
    const msg = JSON.parse(line) // every stdout line must be a protocol message
    const w = waiters.shift()
    if (w) w(msg)
    else queue.push(msg)
  })
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((r) => waiters.push(r)))
  let id = 0
  const server: RawServer = {
    lines,
    stderr: () => err,
    sendLine: (line) => { child.stdin.write(`${line}\n`) },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`) },
    async request(method, params) {
      const myId = ++id
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, ...(params !== undefined ? { params } : {}) })}\n`)
      const msg = await next()
      expect(msg.jsonrpc).toBe('2.0')
      expect(msg.id).toBe(myId)
      return msg
    },
    next,
    close: () => new Promise((r) => {
      if (child.exitCode !== null) return r(child.exitCode)
      child.once('exit', (code) => r(code))
      child.stdin.end()
    }),
  }
  teardown.push(() => { if (child.exitCode === null) child.kill() })
  return server
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }

describe('the sample CRM MCP server (raw JSON lines)', () => {
  it('initializes, lists its tools and calls them', async () => {
    const s = startRaw()
    const init = await s.request('initialize', INIT)
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } })
    expect(init.result.serverInfo.name).toBe('sample-crm')
    s.notify('notifications/initialized')
    expect((await s.request('ping')).result).toEqual({})

    const list = await s.request('tools/list', {})
    const tools = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t]))
    expect(Object.keys(tools).sort()).toEqual(['create_contact', 'get_contact', 'list_contacts'])
    expect(tools.list_contacts.annotations).toEqual({ readOnlyHint: true })
    expect(tools.get_contact.annotations).toEqual({ readOnlyHint: true })
    expect(tools.get_contact.inputSchema.required).toEqual(['id'])
    expect(tools.create_contact.annotations).toBeUndefined()
    const item = tools.list_contacts.outputSchema.properties.contacts.items
    expect(item.required).toEqual(['id', 'company_name'])
    expect(item.properties.email.format).toBe('email')

    const listed = await s.request('tools/call', { name: 'list_contacts', arguments: {} })
    const contacts = listed.result.structuredContent.contacts
    expect(contacts.map((c: any) => c.id)).toEqual(['c-101', 'c-102', 'c-103'])
    expect(contacts[0]).toMatchObject({ company_name: 'Acme Traders Pvt Ltd', email: 'accounts@acme-traders.example', gst_number: '29aaaca1234a1z5' })
    expect(contacts[1].company_name).toBe('Menon Exports')
    expect(contacts[1].gst_number).toBeUndefined()
    expect(contacts[2].company_name).toBe('Zenith Logistics')
    expect(JSON.parse(listed.result.content[0].text)).toEqual(listed.result.structuredContent)

    const got = await s.request('tools/call', { name: 'get_contact', arguments: { id: 'c-102' } })
    expect(got.result.structuredContent.contact.company_name).toBe('Menon Exports')
    const missing = await s.request('tools/call', { name: 'get_contact', arguments: { id: 'c-999' } })
    expect(missing.result.isError).toBe(true)

    const created = await s.request('tools/call', { name: 'create_contact', arguments: { company_name: 'Nova Foods', email: 'hi@nova.example', idempotency_key: 'k1' } })
    expect(created.result.structuredContent).toEqual({ contact: { id: 'c-104', company_name: 'Nova Foods', email: 'hi@nova.example' }, created: true })
    const again = await s.request('tools/call', { name: 'create_contact', arguments: { company_name: 'Nova Foods', idempotency_key: 'k1' } })
    expect(again.result.structuredContent).toEqual({ contact: { id: 'c-104', company_name: 'Nova Foods', email: 'hi@nova.example' }, created: false })
    const count = await s.request('tools/call', { name: 'list_contacts', arguments: {} })
    expect(count.result.structuredContent.contacts).toHaveLength(4)

    expect((await s.request('resources/list', {})).error?.code).toBe(-32601)
    expect((await s.request('tools/call', { name: 'nope', arguments: {} })).error?.code).toBe(-32602)
    s.sendLine('{not json')
    expect((await s.next()).error.code).toBe(-32700)

    expect(await s.close()).toBe(0)
    // stdout held protocol messages only; the log went to stderr.
    for (const line of s.lines) expect(JSON.parse(line).jsonrpc).toBe('2.0')
    expect(s.stderr()).toContain('[sample-crm]')
  })

  it('starts from SAMPLE_CRM_SEED and persists created contacts to SAMPLE_CRM_DATA', async () => {
    const dir = tempDir('crm-')
    const seed = join(dir, 'seed.json')
    const data = join(dir, 'data', 'contacts.json')
    writeFileSync(seed, JSON.stringify([{ id: 'c-500', company_name: 'Seeded Co' }]))
    const s = startRaw({ SAMPLE_CRM_SEED: seed, SAMPLE_CRM_DATA: data })
    await s.request('initialize', INIT)
    s.notify('notifications/initialized')
    const created = await s.request('tools/call', { name: 'create_contact', arguments: { company_name: 'Later Ltd', idempotency_key: 'x' } })
    expect(created.result.structuredContent.contact.id).toBe('c-501')
    await s.close()
    expect(JSON.parse(readFileSync(data, 'utf8')).contacts.map((c: any) => c.id)).toEqual(['c-500', 'c-501'])

    // A restart reads the data file back, idempotency keys included.
    const s2 = startRaw({ SAMPLE_CRM_SEED: seed, SAMPLE_CRM_DATA: data })
    await s2.request('initialize', INIT)
    const again = await s2.request('tools/call', { name: 'create_contact', arguments: { company_name: 'Later Ltd', idempotency_key: 'x' } })
    expect(again.result.structuredContent).toMatchObject({ created: false, contact: { id: 'c-501' } })
    await s2.close()
  })
})

describe('the sample CRM with the official MCP client', () => {
  it('connects over stdio, lists and calls tools (structured content checked against the output schema)', async () => {
    const client = new Client({ name: 'memwise-test', version: '0.0.0' })
    const transport = new StdioClientTransport({ command: 'node', args: [CRM], stderr: 'pipe' })
    await client.connect(transport)
    teardown.push(() => client.close())
    expect(client.getServerVersion()?.name).toBe('sample-crm')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['create_contact', 'get_contact', 'list_contacts'])
    const listed = await client.callTool({ name: 'list_contacts', arguments: {} })
    expect((listed.structuredContent as any).contacts).toHaveLength(3)
    const got = await client.callTool({ name: 'get_contact', arguments: { id: 'c-101' } })
    expect((got.structuredContent as any).contact.gst_number).toBe('29aaaca1234a1z5')
    const created = await client.callTool({ name: 'create_contact', arguments: { company_name: 'Client Co', idempotency_key: 'sdk-1' } })
    expect((created.structuredContent as any).created).toBe(true)
    expect(await client.ping()).toEqual({})
  })
})

// ---------------------------------------------------------------- the example plugins

describe('the example plugins', () => {
  const yaml = (rel: string) => parseYaml(readFileSync(join(PLUGINS, rel), 'utf8'))

  it('client-intake is the intake playbook in its own terms', () => {
    const m = yaml('client-intake/memwise-plugin.yaml')
    expect(m).toMatchObject({ id: 'memwise/client-intake', version: '1.0.0', trust: 'first-party', workflows: ['client-intake'] })
    expect(m.requires.capabilities).toEqual({ email_send: { as: 'email.send' } })
    expect(m.requires.entities.Client.fields).toEqual({
      name: { type: 'PersonName', required: true }, email: 'Email', tax_id: 'Identifier(GSTIN)', pan: 'Identifier(PAN)',
    })
    expect(Object.keys(m.requires.roles)).toEqual(['staff', 'manager'])
    expect(m.tools['gst.validate_gstin']).toMatchObject({ effect: 'read', run: { builtin: 'gst.validate_gstin' } })
    expect(m.tools['intake.extract_fields']).toMatchObject({ effect: 'read', quarantine: true, run: { builtin: 'intake.extract_fields' } })
    expect(m.policy.tools.rules['intake.extract_fields'].rateLimit).toBe('30/min')
    const onboard = readFileSync(join(PLUGINS, 'client-intake/workflows/client-intake/steps/onboard.md'), 'utf8')
    expect(onboard).toContain('domain.client.create')
    expect(onboard).not.toMatch(/customer\.create|Ref<Customer>/)
    expect(readFileSync(join(PLUGINS, 'client-intake/workflows/client-intake/case.yaml'), 'utf8')).toContain('Ref<Client>')
  })

  it('sample-email provides email_send', () => {
    const m = yaml('sample-email/memwise-plugin.yaml')
    expect(m).toMatchObject({ id: 'memwise/sample-email', version: '1.0.0', trust: 'first-party', provides: { capabilities: { email_send: { tool: 'email.send' } } } })
    expect(m.tools['email.send']).toMatchObject({ effect: 'outbound', idempotent: true, run: { builtin: 'email.send' } })
  })

  it('email-smtp and whatsapp-cloud provide the channel tools by their fixed names (Phase 5)', async () => {
    const { parsePluginManifest } = await import('@memwise/defs')
    const { channelTools, EMAIL_SMTP_BUILTIN, WHATSAPP_CLOUD_BUILTIN } = await import('../channels')
    const builtins = new Set(channelTools().map((t) => t.name))
    const cases = [
      { dir: 'email-smtp', id: 'memwise/email-smtp', cap: 'email_send', tool: 'email.send', builtin: EMAIL_SMTP_BUILTIN },
      { dir: 'whatsapp-cloud', id: 'memwise/whatsapp-cloud', cap: 'whatsapp_send', tool: 'whatsapp.send', builtin: WHATSAPP_CLOUD_BUILTIN },
    ]
    for (const c of cases) {
      const file = join(PLUGINS, c.dir, 'memwise-plugin.yaml')
      const r = parsePluginManifest(readFileSync(file, 'utf8'), file)
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      expect(r.value).toMatchObject({ id: c.id, version: '1.0.0', trust: 'first-party', provides: { capabilities: { [c.cap]: { tool: c.tool } } } })
      expect(r.value!.tools[c.tool]).toMatchObject({ effect: 'outbound', idempotent: true, capability: c.cap, run: { builtin: c.builtin } })
      expect(builtins.has(c.builtin)).toBe(true)
      expect(readFileSync(join(PLUGINS, c.dir, 'README.md'), 'utf8')).toContain(c.tool)
    }
  })

  it('sample-crm is a Claude plugin and connectors ships the setup guide as a skill', () => {
    expect(existsSync(join(PLUGINS, 'sample-crm', 'memwise-plugin.yaml'))).toBe(false)
    expect(JSON.parse(readFileSync(join(PLUGINS, 'sample-crm/.claude-plugin/plugin.json'), 'utf8'))).toMatchObject({ name: 'sample-crm', version: '1.0.0' })
    expect(JSON.parse(readFileSync(join(PLUGINS, 'sample-crm/.mcp.json'), 'utf8')).mcpServers.crm).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] })
    const m = yaml('connectors/memwise-plugin.yaml')
    expect(m).toMatchObject({ id: 'memwise/connectors', version: '1.0.0', trust: 'first-party', skills: ['connector-setup'] })
    expect(m.tools).toBeUndefined()
    const skill = readFileSync(join(PLUGINS, 'connectors/skills/connector-setup/SKILL.md'), 'utf8')
    const front = parseYaml(skill.split('---')[1]!)
    expect(front.name).toBe('connector-setup')
    expect(skill).toContain(readFileSync(join(REPO, 'apps/electron/resources/docs/sources.md'), 'utf8').trim())
  })

  it('are found next to the example project', () => {
    const found = findExamplePlugins([REPO])
    expect(found).toBe(PLUGINS)
    expect(listExamplePlugins(found).map((p) => p.name)).toEqual(['client-intake', 'connectors', 'email-smtp', 'medidata-rave', 'sample-crm', 'sample-email', 'whatsapp-cloud'])
    expect(findExamplePlugins([tempDir('none-')])).toBe(PLUGINS) // walks up from cwd in the repo
    expect(listExamplePlugins(undefined)).toEqual([])
  })

  it('adds bind-plugin to a project when the example has it', () => {
    const example = tempDir('example-')
    for (const id of ['create-playbook', 'change-playbook', 'bind-plugin']) {
      mkdirSync(join(example, 'workflows', id), { recursive: true })
      writeFileSync(join(example, 'workflows', id, 'workflow.yaml'), `workflow: ${id}\n`)
    }
    const project = tempDir('project-')
    mkdirSync(join(project, 'workflows', 'create-playbook'), { recursive: true })
    expect(addMissingMetaPlaybooks(project, example)).toEqual(['change-playbook', 'bind-plugin'])
    expect(addMissingMetaPlaybooks(project, example)).toEqual([])
  })
})

// ---------------------------------------------------------------- the connector bridge

function workspaceWithSources(): { configDir: string; root: string } {
  const configDir = tempDir('cfg-')
  const root = join(configDir, 'workspaces', 'ws-1')
  const source = (slug: string, config: Record<string, unknown>) => {
    mkdirSync(join(root, 'sources', slug), { recursive: true })
    writeFileSync(join(root, 'sources', slug, 'config.json'), JSON.stringify({ id: `${slug}_1`, slug, provider: slug, ...config }))
  }
  source('crm', { name: 'Sample CRM', enabled: true, type: 'mcp', mcp: { transport: 'stdio', command: 'node', args: [CRM], env: { SAMPLE_CRM_SEED: '' } } })
  source('docs-search', { name: 'Docs search', enabled: true, type: 'mcp', mcp: { transport: 'http', url: 'https://mcp.example.com/mcp', authType: 'none', headers: { 'X-Team': 'ops' } } })
  source('old', { name: 'Old', enabled: false, type: 'mcp', mcp: { transport: 'stdio', command: 'node', args: ['x.js'] } })
  source('weather', { name: 'Weather', enabled: true, type: 'api', api: { baseUrl: 'https://api.example.com', authType: 'none' } })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ workspaces: [{ id: 'w-other', rootPath: '/nowhere' }, { id: 'w1', rootPath: root }], activeWorkspaceId: 'w1' }))
  return { configDir, root }
}

describe('the connector bridge', () => {
  it('resolves MCP sources of the active workspace, and nothing else', async () => {
    const { configDir, root } = workspaceWithSources()
    expect(activeWorkspaceRoot(configDir)).toBe(root)
    const bridge = createConnectorBridge({ configDir })
    expect(bridge.workspaceRoot()).toBe(root)
    expect(await bridge.resolveMcpSource('crm')).toEqual({ command: 'node', args: [CRM], env: { SAMPLE_CRM_SEED: '' } })
    expect(await bridge.resolveMcpSource('docs-search')).toEqual({ url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'ops' } })
    expect(await bridge.resolveMcpSource('old')).toBeUndefined()      // disabled
    expect(await bridge.resolveMcpSource('weather')).toBeUndefined()  // not MCP
    expect(await bridge.resolveMcpSource('missing')).toBeUndefined()
    expect(await bridge.resolveMcpSource('../ws-1')).toBeUndefined()
  })

  it('a resolved stdio source is a working MCP server', async () => {
    const { configDir } = workspaceWithSources()
    const def = await createConnectorBridge({ configDir }).resolveMcpSource('crm')
    if (!def || !('command' in def)) throw new Error('expected a stdio server')
    const client = new Client({ name: 'memwise-test', version: '0.0.0' })
    await client.connect(new StdioClientTransport({ command: def.command, args: def.args ?? [], env: { ...(process.env as Record<string, string>), ...def.env }, stderr: 'pipe' }))
    teardown.push(() => client.close())
    const listed = await client.callTool({ name: 'list_contacts', arguments: {} })
    expect((listed.structuredContent as any).contacts).toHaveLength(3)
  })

  it('writes an installable plugin folder per enabled MCP source', async () => {
    const { configDir, root } = workspaceWithSources()
    const bridge = createConnectorBridge({ configDir })
    const folders = await bridge.sourcePluginFolders()
    expect(folders.map((f) => [f.slug, f.name])).toEqual([['crm', 'Sample CRM'], ['docs-search', 'Docs search']])
    const crm = folders[0]!
    expect(crm.dir).toBe(join(configDir, 'memwise', 'source-plugins', 'crm'))
    const manifest = parseYaml(readFileSync(join(crm.dir, 'memwise-plugin.yaml'), 'utf8'))
    expect(manifest).toMatchObject({ id: 'source/crm', version: '1.0.0', title: 'Sample CRM', trust: 'local', mcp_servers: { crm: { source: 'crm' } } })
    expect(manifest.tools).toBeUndefined()
    expect(readFileSync(join(crm.dir, 'memwise-plugin.yaml'), 'utf8')).toBe(sourcePluginManifest('crm', 'Sample CRM'))

    // A source that goes away takes its folder with it.
    rmSync(join(root, 'sources', 'docs-search'), { recursive: true })
    expect((await bridge.sourcePluginFolders()).map((f) => f.slug)).toEqual(['crm'])
    expect(existsSync(join(configDir, 'memwise', 'source-plugins', 'docs-search'))).toBe(false)
  })

  it('is empty, not broken, without a workspace or sources', async () => {
    const configDir = tempDir('cfg-empty-')
    const bridge = createConnectorBridge({ configDir })
    expect(bridge.workspaceRoot()).toBeUndefined()
    expect(await bridge.resolveMcpSource('crm')).toBeUndefined()
    expect(await bridge.sourcePluginFolders()).toEqual([])
    const bare = tempDir('ws-bare-')
    const pinned = createConnectorBridge({ configDir, workspaceRoot: () => bare })
    expect(pinned.workspaceRoot()).toBe(bare)
    expect(await pinned.sourcePluginFolders()).toEqual([])
    expect(existsSync(join(bare, 'sources'))).toBe(false) // listing creates nothing in the workspace
  })

})
