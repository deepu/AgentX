/**
 * Hosting pieces that need no kernel: person sign-in on the WS handshake (the shared token
 * still works, as the admin; a person reaches the playbook channels only and is cut off once
 * disabled), model-role resolution, and seeding the project folder.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import { WsRpcServer, type WsRpcServerOptions } from '../../transport/server'
import { WsRpcClient } from '../../transport/client'
import { personMayCall } from '../../transport/person-channels'
import { connectionModels, NO_MODEL_MESSAGE, pickPlaybookConnection, piAiProviderIdFor, unconfiguredModels } from '../models'
import { addMissingMetaPlaybooks, affectsIndex, findExampleProject, seedProject } from '../seed'
import { createSessionToken, sessionPersonId } from '../../webui/auth'

const SHARED = 'shared-server-token-0123456789abcdef'
const teardown: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

const WHO = RPC_CHANNELS.memwise.STATUS
const SESSIONS = RPC_CHANNELS.sessions.GET

async function connect(token: string, extra: Partial<WsRpcServerOptions> = {}) {
  const expired: string[] = []
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => t === SHARED,
    authenticatePersonToken: async (t) => (t === 'priya-personal-token' ? 'person_priya' : null),
    serverId: 'test',
    onClientExpired: (id) => { expired.push(id) },
    ...extra,
  })
  let seen: string | undefined | null = null
  server.handle(WHO, (ctx) => { seen = ctx.personId; return ctx.personId ?? 'admin' })
  server.handle(SESSIONS, () => ['every chat on the server'])
  server.handle(RPC_CHANNELS.memwise.CHAT_OPEN, () => ({ sessionId: 's' }))
  await server.listen()
  teardown.push(() => server.close())
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { token, workspaceId: 'ws', autoReconnect: false })
  client.connect()
  teardown.push(() => client.destroy())
  const status = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 2000)
    const off = client.onConnectionStateChanged((s) => {
      if (s.status === 'connected' || s.status === 'failed' || s.status === 'disconnected') { clearTimeout(t); off(); resolve(s.status) }
    })
  })
  return { server, client, status, seen: () => seen, expired }
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e?.code ?? 'error')

describe('person sign-in on the WS handshake', () => {
  it('puts the person on the request context for a personal token', async () => {
    const { client, status } = await connect('priya-personal-token')
    expect(status).toBe('connected')
    expect(await client.invoke(WHO)).toBe('person_priya')
  })

  it('keeps the shared token working, as the admin', async () => {
    const { client, status } = await connect(SHARED)
    expect(status).toBe('connected')
    expect(await client.invoke(WHO)).toBe('admin')
  })

  it('refuses an unknown token', async () => {
    const { status } = await connect('nope')
    expect(status).not.toBe('connected')
  })

  it('gives a person the playbook channels only, and advertises just those', async () => {
    const { client } = await connect('priya-personal-token')
    expect(await codeOf(client.invoke(SESSIONS))).toBe('FORBIDDEN')
    expect(await codeOf(client.invoke(RPC_CHANNELS.memwise.CHAT_OPEN))).toBe('FORBIDDEN')
    expect(client.isChannelAvailable(SESSIONS)).toBe(false)
    expect(client.isChannelAvailable(WHO)).toBe(true)
    expect(await client.invoke(WHO)).toBe('person_priya')
  })

  it('gives the shared token everything', async () => {
    const { client } = await connect(SHARED)
    expect(await client.invoke(SESSIONS)).toEqual(['every chat on the server'])
    expect(client.isChannelAvailable(SESSIONS)).toBe(true)
  })

  it('cuts a person off on their next request once they are disabled, and refuses them after', async () => {
    let active = true
    const { client, server } = await connect('priya-personal-token', { personActive: async () => active })
    expect(await client.invoke(WHO)).toBe('person_priya')
    active = false
    expect(await codeOf(client.invoke(WHO))).toBe('AUTH_FAILED')
    await new Promise((r) => setTimeout(r, 100))
    expect(server.getConnectedClientCount()).toBe(0)
    const again = await connect('priya-personal-token', { personActive: async () => false })
    expect(again.status).not.toBe('connected')
  })

  it('ends a person\'s live connections on request', async () => {
    const { client, server } = await connect('priya-personal-token')
    expect(await client.invoke(WHO)).toBe('person_priya')
    expect(server.disconnectPerson('person_priya')).toBe(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('refuses a web session whose person cannot be resolved instead of treating it as the admin', async () => {
    const { status } = await connect('', {
      validateSessionCookie: async () => true,
      sessionCookiePerson: async () => { throw new Error('bad subject') },
    })
    expect(status).not.toBe('connected')
  })

  it('reports a client as gone once it can no longer reconnect', async () => {
    const { server, expired } = await connect('priya-personal-token')
    server.disconnectPerson('person_priya')
    await new Promise((r) => setTimeout(r, 100))
    expect(expired.length).toBe(1)
  })
})

describe('person channel allowlist', () => {
  it('allows the playbook API and a few shell reads, nothing that runs with the server\'s power', () => {
    expect(personMayCall(RPC_CHANNELS.memwise.INBOX_LIST)).toBe(true)
    expect(personMayCall(RPC_CHANNELS.workspaces.GET)).toBe(true)
    for (const ch of [
      RPC_CHANNELS.memwise.CHAT_OPEN, RPC_CHANNELS.memwise.PLAYBOOKS_BUILD, RPC_CHANNELS.sessions.CREATE, RPC_CHANNELS.sessions.SEND_MESSAGE, RPC_CHANNELS.sources.GET,
      RPC_CHANNELS.llmConnections.GET_API_KEY, RPC_CHANNELS.settings.SET_SERVER_CONFIG, RPC_CHANNELS.theme.SET_COLOR_THEME,
      RPC_CHANNELS.preferences.WRITE, RPC_CHANNELS.file.READ, RPC_CHANNELS.workspaces.CREATE,
    ]) expect(personMayCall(ch)).toBe(false)
  })
})

describe('web session cookies', () => {
  it('carry the person who signed in with email and password', async () => {
    const jwt = await createSessionToken('secret-secret-secret', 'person_ravi')
    expect(await sessionPersonId(`craft_session=${jwt}`, 'secret-secret-secret')).toBe('person_ravi')
    const shared = await createSessionToken('secret-secret-secret')
    expect(await sessionPersonId(`craft_session=${shared}`, 'secret-secret-secret')).toBeNull()
  })
})

describe('model roles', () => {
  const roles = ['checker', 'verifier', 'extractor', 'explainer']
  const conn = { slug: 'a', name: 'Anthropic', providerType: 'anthropic', authType: 'api_key', apiKey: 'sk-test' }

  it('maps API-key connections pi-ai can call', () => {
    expect(piAiProviderIdFor({ providerType: 'anthropic', authType: 'api_key' })).toBe('anthropic')
    expect(piAiProviderIdFor({ providerType: 'pi', authType: 'api_key', piAuthProvider: 'openai' })).toBe('openai')
    expect(piAiProviderIdFor({ providerType: 'anthropic', authType: 'oauth' })).toBeUndefined()
    expect(piAiProviderIdFor({ providerType: 'pi_compat', authType: 'api_key' })).toBeUndefined()
  })

  it('uses the default connection for every role', async () => {
    const r = await connectionModels({ roles }, conn)
    expect(r.configured).toBe(true)
    expect(Object.keys(r.modelRoles).sort()).toEqual([...roles].sort())
    expect(r.modelRoles.checker!.provider).toBe('anthropic')
    expect(r.message).not.toContain('sk-test')
  })

  it('a subscription default leaves playbook steps to another connection with an API key', () => {
    const max = { ...conn, slug: 'claude-max', name: 'Claude Max', authType: 'oauth', apiKey: null }
    const backend = { ...conn, slug: 'backend', name: 'MemWise Backend' }
    expect(pickPlaybookConnection(max, [backend])!.slug).toBe('backend')
    expect(pickPlaybookConnection(conn, [backend])!.slug).toBe(conn.slug)
    expect(pickPlaybookConnection(max, [{ ...backend, apiKey: null }])!.slug).toBe('claude-max')
    expect(pickPlaybookConnection(null, [])).toBeNull()
  })

  it('without a usable connection, every call says to connect a model', async () => {
    expect((await connectionModels({ roles }, null)).configured).toBe(false)
    expect((await connectionModels({ roles }, { ...conn, apiKey: null })).configured).toBe(false)
    expect((await connectionModels({ roles }, { ...conn, authType: 'oauth' })).configured).toBe(false)
    const none = unconfiguredModels(roles)
    await expect(none.providers[0]!.complete('none', { systemPrompt: '', messages: [], tools: [] }, { role: 'checker', sessionId: 's' }))
      .rejects.toThrow(NO_MODEL_MESSAGE)
  })
})

describe('project folder', () => {
  it('is seeded from examples/intake once, and left alone after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-seed-'))
    teardown.push(() => rmSync(dir, { recursive: true, force: true }))
    const example = findExampleProject([join(import.meta.dir, '..', '..', '..', '..', '..')])
    expect(example).toBeTruthy()
    const project = join(dir, 'project')
    expect(seedProject(project, example)).toBe(true)
    expect(existsSync(join(project, 'workflows', 'client-intake', 'workflow.yaml'))).toBe(true)
    writeFileSync(join(project, 'mine.txt'), 'x')
    expect(seedProject(project, example)).toBe(false)
  })

  it('gains the meta playbooks when an older install lacks them, and keeps its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-meta-'))
    teardown.push(() => rmSync(dir, { recursive: true, force: true }))
    const example = join(dir, 'example')
    for (const id of ['client-intake', 'create-playbook', 'change-playbook']) {
      mkdirSync(join(example, 'workflows', id), { recursive: true })
      writeFileSync(join(example, 'workflows', id, 'workflow.yaml'), `workflow: ${id}\n`)
    }
    const project = join(dir, 'project')
    mkdirSync(join(project, 'workflows', 'change-playbook'), { recursive: true })
    writeFileSync(join(project, 'workflows', 'change-playbook', 'workflow.yaml'), 'workflow: change-playbook # mine\n')
    expect(addMissingMetaPlaybooks(project, example)).toEqual(['create-playbook'])
    expect(existsSync(join(project, 'workflows', 'create-playbook', 'workflow.yaml'))).toBe(true)
    expect(readFileSync(join(project, 'workflows', 'change-playbook', 'workflow.yaml'), 'utf8')).toContain('# mine')
    expect(existsSync(join(project, 'workflows', 'client-intake'))).toBe(false)
    expect(addMissingMetaPlaybooks(project, example)).toEqual([])
  })

  it('re-indexes only for domain/ and workflows/, never for drafts/', () => {
    expect(affectsIndex('workflows/client-intake/steps/check.md')).toBe(true)
    expect(affectsIndex('domain/roles.yaml')).toBe(true)
    expect(affectsIndex('drafts/client-intake-abc/workflows/client-intake/steps/check.md')).toBe(false)
    expect(affectsIndex('drafts')).toBe(false)
    expect(affectsIndex('README.md')).toBe(false)
    expect(affectsIndex(null)).toBe(true)
  })
})
