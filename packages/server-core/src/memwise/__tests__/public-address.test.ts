/**
 * The public address (23 §2, §11) with a fake tunnel: the relay setting kept in
 * `<configDir>/relay/settings.json` (and `MEMWISE_RELAY_URL` without it), the install identity,
 * where links point (the relay while connected, else MEMWISE_PUBLIC_URL), restarting on
 * configure, status pushes, and a relay that fails never failing the app.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayTunnel, RelayTunnelOptions, RelayTunnelStatus } from '@memwise/relay/protocol'
import type { MwRelayStatus } from '@memwise/shared/protocol'
import {
  base32, createPublicAddress, effectiveRelaySettings, installIdOf, loadOrCreateIdentity, normalizeRelayUrl, readRelaySettings,
  relayIdentityFile, relaySettingsFile, writeRelaySettings,
} from '../relay'
import { createPublicHandler } from '../public'

const quiet = { info() {}, warn() {}, error() {} }
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function configDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mw-relay-'))
  dirs.push(d)
  return d
}

/** A tunnel the test drives: it records how it was started and reports what it is told. */
function fakeTunnels() {
  const started: { opts: RelayTunnelOptions; tunnel: FakeTunnel }[] = []
  class FakeTunnel implements RelayTunnel {
    s: RelayTunnelStatus
    closed = false
    listeners = new Set<(s: RelayTunnelStatus) => void>()
    constructor(opts: RelayTunnelOptions) { this.s = { state: 'connecting', relayUrl: opts.relayUrl, installId: opts.identity.installId, since: new Date().toISOString() } }
    status() { return this.s }
    onStatus(l: (s: RelayTunnelStatus) => void) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
    async close() { this.closed = true; this.set({ state: 'off' }) }
    set(next: Partial<RelayTunnelStatus>) { this.s = { ...this.s, ...next }; for (const l of this.listeners) l(this.s) }
  }
  return {
    started,
    start: (opts: RelayTunnelOptions) => { const tunnel = new FakeTunnel(opts); started.push({ opts, tunnel }); return tunnel },
  }
}

const handler = createPublicHandler({ kernel: () => null })

describe('the relay setting', () => {
  it('is off by default, on with MEMWISE_RELAY_URL, and the saved file wins', () => {
    const dir = configDir()
    expect(effectiveRelaySettings(dir, {})).toEqual({ enabled: false })
    expect(effectiveRelaySettings(dir, { MEMWISE_RELAY_URL: 'https://relay.memwise.app' })).toEqual({ enabled: true, relayUrl: 'https://relay.memwise.app' })
    writeRelaySettings(dir, { enabled: false })
    expect(readRelaySettings(dir)).toEqual({ enabled: false })
    // Turned off in Settings stays off; the environment still offers its address.
    expect(effectiveRelaySettings(dir, { MEMWISE_RELAY_URL: 'https://relay.memwise.app' })).toEqual({ enabled: false, relayUrl: 'https://relay.memwise.app' })
    writeRelaySettings(dir, { enabled: true, relayUrl: 'http://localhost:8788' })
    expect(JSON.parse(readFileSync(relaySettingsFile(dir), 'utf8'))).toEqual({ enabled: true, relayUrl: 'http://localhost:8788' })
    expect(effectiveRelaySettings(dir, { MEMWISE_RELAY_URL: 'https://other' })).toEqual({ enabled: true, relayUrl: 'http://localhost:8788' })
  })

  it('reads a broken file as no setting', () => {
    const dir = configDir()
    mkdirSync(join(dir, 'relay'), { recursive: true })
    writeFileSync(relaySettingsFile(dir), '{nope')
    expect(readRelaySettings(dir)).toBeUndefined()
  })

  it('normalises the address people type', () => {
    expect(normalizeRelayUrl(' relay.memwise.app/ ')).toBe('https://relay.memwise.app')
    expect(normalizeRelayUrl('wss://relay.example.com')).toBe('https://relay.example.com')
    expect(normalizeRelayUrl('http://localhost:8788')).toBe('http://localhost:8788')
    expect(() => normalizeRelayUrl('ftp://x')).toThrow('https://')
    expect(() => normalizeRelayUrl('https://u:p@x')).toThrow('user name')
    expect(() => normalizeRelayUrl('https://x/?a=1')).toThrow('without ?')
  })
})

describe('the install identity', () => {
  it('names the install by its key: 16 base32 characters of sha256(publicKey)', async () => {
    expect(base32(new Uint8Array([0xff, 0, 0xff, 0, 0xff, 0, 0xff, 0, 0xff, 0]))).toHaveLength(16)
    const dir = configDir()
    const file = relayIdentityFile(dir)
    const a = await loadOrCreateIdentity(file)
    expect(a.installId).toMatch(/^[a-z2-7]{16}$/)
    expect(installIdOf(a.publicKey)).toBe(a.installId)
    expect(a.privateJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', x: a.publicKey })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await loadOrCreateIdentity(file)).toEqual(a) // kept, not remade
    // The key signs, and the signature checks with the public key (what the relay does).
    const { webcrypto } = await import('node:crypto')
    const key = await webcrypto.subtle.importKey('jwk', a.privateJwk as import('node:crypto').webcrypto.JsonWebKey, { name: 'Ed25519' }, false, ['sign'])
    const pub = await webcrypto.subtle.importKey('raw', Buffer.from(a.publicKey, 'base64url'), { name: 'Ed25519' }, false, ['verify'])
    const msg = new TextEncoder().encode(`nonce:memwise-relay-v1:${a.installId}`)
    expect(await webcrypto.subtle.verify('Ed25519', pub, await webcrypto.subtle.sign('Ed25519', key, msg), msg)).toBe(true)
  })

  it('replaces a broken identity file, keeping it aside', async () => {
    const dir = configDir()
    const file = relayIdentityFile(dir)
    mkdirSync(join(dir, 'relay'), { recursive: true })
    writeFileSync(file, '{"installId":"x"}')
    const id = await loadOrCreateIdentity(file)
    expect(id.installId).toMatch(/^[a-z2-7]{16}$/)
    expect(existsSync(`${file}.broken`)).toBe(true)
  })
})

describe('the public address', () => {
  it('is off with no relay and no server address', async () => {
    const dir = configDir()
    const t = fakeTunnels()
    const a = createPublicAddress({ configDir: dir, handler, mode: 'desktop', log: quiet, env: {}, startTunnel: t.start })
    await a.start()
    expect(a.status()).toEqual({ enabled: false, state: 'off' })
    expect(a.publicUrl()).toBeUndefined()
    expect(t.started).toEqual([])
  })

  it('uses a server\'s MEMWISE_PUBLIC_URL when there is no relay', async () => {
    const a = createPublicAddress({ configDir: configDir(), handler, mode: 'server', log: quiet, env: { MEMWISE_PUBLIC_URL: 'https://forms.acme.example/' } })
    await a.start()
    expect(a.publicUrl()).toBe('https://forms.acme.example')
    expect(a.status()).toMatchObject({ enabled: false, state: 'off', publicUrl: 'https://forms.acme.example', source: 'server' })
  })

  it('connects with MEMWISE_RELAY_URL, points links at the relay once connected, and pushes each change', async () => {
    const dir = configDir()
    const t = fakeTunnels()
    const pushed: MwRelayStatus[] = []
    const a = createPublicAddress({
      configDir: dir, handler, mode: 'desktop', log: quiet, env: { MEMWISE_RELAY_URL: 'http://localhost:8788/', MEMWISE_PUBLIC_URL: 'https://own.example' },
      startTunnel: t.start, onChange: (s) => pushed.push(s), client: 'memwise-desktop/test',
    })
    await a.start()
    expect(t.started).toHaveLength(1)
    const { opts, tunnel } = t.started[0]!
    expect(opts.relayUrl).toBe('http://localhost:8788')
    expect(opts.client).toBe('memwise-desktop/test')
    expect(opts.handle).toBe(handler)
    expect(existsSync(relayIdentityFile(dir))).toBe(true)
    expect(a.status()).toMatchObject({ enabled: true, state: 'connecting', relayUrl: 'http://localhost:8788', installId: opts.identity.installId })
    // While connecting, links use the server's own address.
    expect(a.publicUrl()).toBe('https://own.example')
    tunnel.set({ state: 'connected', publicUrl: `http://localhost:8788/x/${opts.identity.installId}/` })
    expect(a.publicUrl()).toBe(`http://localhost:8788/x/${opts.identity.installId}`)
    expect(a.status()).toMatchObject({ state: 'connected', source: 'relay' })
    expect(pushed.at(-1)).toMatchObject({ state: 'connected' })
    tunnel.set({ state: 'error', error: 'relay unreachable' })
    expect(a.status()).toMatchObject({ state: 'error', error: 'relay unreachable', publicUrl: 'https://own.example' })
    // One push per change (connecting twice: before and after the install id is known).
    expect(pushed.map((p) => p.state).filter((s, i, all) => s !== all[i - 1])).toEqual(['connecting', 'connected', 'error'])
    await a.stop()
    expect(tunnel.closed).toBe(true)
  })

  it('saves Settings → Public address and restarts the tunnel on it', async () => {
    const dir = configDir()
    const t = fakeTunnels()
    const a = createPublicAddress({ configDir: dir, handler, mode: 'desktop', log: quiet, env: {}, startTunnel: t.start })
    await a.start()
    await expect(a.configure({ enabled: true })).rejects.toThrow('Enter the address of the relay')
    const s = await a.configure({ enabled: true, relayUrl: 'relay.memwise.app' })
    expect(s).toMatchObject({ enabled: true, state: 'connecting', relayUrl: 'https://relay.memwise.app' })
    expect(readRelaySettings(dir)).toEqual({ enabled: true, relayUrl: 'https://relay.memwise.app' })
    expect(t.started).toHaveLength(1)
    await a.configure({ enabled: true, relayUrl: 'http://localhost:8788' })
    expect(t.started).toHaveLength(2)
    expect(t.started[0]!.tunnel.closed).toBe(true)
    // Same install, same identity.
    expect(t.started[1]!.opts.identity).toEqual(t.started[0]!.opts.identity)
    const off = await a.configure({ enabled: false })
    expect(off).toMatchObject({ enabled: false, state: 'off', relayUrl: 'http://localhost:8788' })
    expect(t.started[1]!.tunnel.closed).toBe(true)
    expect(readRelaySettings(dir)).toEqual({ enabled: false, relayUrl: 'http://localhost:8788' })
    // A new start reads what was saved.
    const b = createPublicAddress({ configDir: dir, handler, mode: 'desktop', log: quiet, env: { MEMWISE_RELAY_URL: 'https://env' }, startTunnel: t.start })
    await b.start()
    expect(b.status()).toMatchObject({ enabled: false, state: 'off' })
  })

  it('shows a relay that cannot start as an error, without throwing', async () => {
    const dir = configDir()
    const warned: string[] = []
    const a = createPublicAddress({
      configDir: dir, handler, mode: 'desktop', log: { ...quiet, warn: (m: unknown) => warned.push(String(m)) }, env: { MEMWISE_RELAY_URL: 'https://relay.example' },
      startTunnel: () => { throw new Error('startRelayTunnel is not built yet') },
    })
    await a.start()
    expect(a.status()).toMatchObject({ enabled: true, state: 'error', error: 'The relay connection could not start: startRelayTunnel is not built yet' })
    expect(a.publicUrl()).toBeUndefined()
    expect(warned.join('\n')).toContain('not built yet')
    const broken = createPublicAddress({
      configDir: dir, handler, mode: 'desktop', log: quiet, env: { MEMWISE_RELAY_URL: 'https://relay.example' },
      loadIdentity: async () => { throw new Error('disk full') }, startTunnel: fakeTunnels().start,
    })
    await broken.start()
    expect(broken.status()).toMatchObject({ state: 'error', error: expect.stringContaining('disk full') })
  })

  it('serves the public handler directly on a server with MEMWISE_PUBLIC_PORT', async () => {
    const listened: { port: number; hostname: string; trustProxy: boolean }[] = []
    let stopped = false
    const a = createPublicAddress({
      configDir: configDir(), handler, mode: 'server', log: quiet,
      env: { MEMWISE_PUBLIC_PORT: '8443', MEMWISE_PUBLIC_URL: 'https://forms.acme.example', MEMWISE_PUBLIC_TRUST_PROXY: '1' },
      listen: (port, hostname, _h, trustProxy) => { listened.push({ port, hostname, trustProxy }); return { port, stop: () => { stopped = true } } },
    })
    await a.start()
    expect(listened).toEqual([{ port: 8443, hostname: '0.0.0.0', trustProxy: true }])
    await a.stop()
    expect(stopped).toBe(true)
    // Not on the desktop.
    const d = createPublicAddress({ configDir: configDir(), handler, mode: 'desktop', log: quiet, env: { MEMWISE_PUBLIC_PORT: '8443' }, listen: () => { throw new Error('no') } })
    await d.start()
  })

  it('answers real requests through Bun.serve with the socket address', async () => {
    const { bunListener } = await import('../relay')
    const seen: (string | undefined)[] = []
    const l = bunListener(0, '127.0.0.1', async (_req, conn) => { seen.push(conn?.ip); return new Response('ok') }, false)
    try {
      const r = await fetch(`http://127.0.0.1:${l.port}/f/x`, { headers: { 'x-memwise-client-ip': '6.6.6.6' } })
      expect(await r.text()).toBe('ok')
      expect(seen[0]).toMatch(/127\.0\.0\.1/)
    } finally {
      await l.stop()
    }
  })
})
