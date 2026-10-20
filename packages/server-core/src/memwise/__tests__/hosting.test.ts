/**
 * Hosting pieces that need no kernel: person sign-in on the WS handshake (the shared token
 * still works, as the admin), model-role resolution, and seeding the project folder.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WsRpcServer } from '../../transport/server'
import { WsRpcClient } from '../../transport/client'
import { connectionModels, NO_MODEL_MESSAGE, piAiProviderIdFor, unconfiguredModels } from '../models'
import { findExampleProject, seedProject } from '../seed'
import { createSessionToken, sessionPersonId } from '../../webui/auth'

const SHARED = 'shared-server-token-0123456789abcdef'
const teardown: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

async function connect(token: string) {
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => t === SHARED,
    authenticatePersonToken: async (t) => (t === 'priya-personal-token' ? 'person_priya' : null),
    serverId: 'test',
  })
  let seen: string | undefined | null = null
  server.handle('who', (ctx) => { seen = ctx.personId; return ctx.personId ?? 'admin' })
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
  return { client, status, seen: () => seen }
}

describe('person sign-in on the WS handshake', () => {
  it('puts the person on the request context for a personal token', async () => {
    const { client, status } = await connect('priya-personal-token')
    expect(status).toBe('connected')
    expect(await client.invoke('who')).toBe('person_priya')
  })

  it('keeps the shared token working, as the admin', async () => {
    const { client, status } = await connect(SHARED)
    expect(status).toBe('connected')
    expect(await client.invoke('who')).toBe('admin')
  })

  it('refuses an unknown token', async () => {
    const { status } = await connect('nope')
    expect(status).not.toBe('connected')
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
})
