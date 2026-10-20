/**
 * The public address through a real relay (23 §2, §4): a Bun relay on a local port, the core's
 * tunnel dialled by the public address with its own identity, and the public handler answering a
 * client's requests through it (the form, an upload, a webhook), with the relay's headers on top.
 * Skipped when the relay package isn't built yet.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelService, ExternalService } from '@memwise/runtime'
import { createPublicHandler } from '../public'
import { createPublicAddress } from '../relay'

// Through a variable, so this file type-checks before the relay's Bun host exists.
const BUN_HOST = '@memwise/relay/bun'
type BunRelay = { url: string; port: number; stop(): Promise<void> }
const relayHost = await import(BUN_HOST).catch(() => undefined) as { startBunRelay(o: { port?: number; hostname?: string }): BunRelay } | undefined
const tunnelBuilt = await import('@memwise/relay/client').then((m) => {
  try { m.startRelayTunnel({} as never) } catch (e) { return !String(e).includes('not built yet') }
  return true
}).catch(() => false)

const quiet = { info() {}, warn() {}, error() {} }
const teardown: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

async function until<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe.skipIf(!relayHost || !tunnelBuilt)('the public address through a Bun relay', () => {
  it('connects, and serves the form, uploads and webhooks through the tunnel', async () => {
    const relay = relayHost!.startBunRelay({ port: 0, hostname: '127.0.0.1' })
    teardown.push(() => relay.stop())
    const configDir = mkdtempSync(join(tmpdir(), 'mw-tunnel-'))
    teardown.push(() => rmSync(configDir, { recursive: true, force: true }))

    const seen: { method: string; args: unknown[] }[] = []
    const external = {
      form: async (...args: unknown[]) => { seen.push({ method: 'form', args }); return { status: 'open', title: 'Your details' } },
      upload: async (_t: string, file: { name: string; data: Uint8Array }) => ({ document: { id: 'file_1', name: file.name, mime: 'application/pdf', size: file.data.byteLength } }),
    } as unknown as ExternalService
    const channels = {
      receiveWebhook: async (_id: string, req: { query: Record<string, string> }) => ({ status: 200, body: req.query['hub.challenge'] ?? 'ok' }),
    } as unknown as ChannelService
    const handler = createPublicHandler({ kernel: () => ({ external, channels }), log: quiet })
    const address = createPublicAddress({ configDir, handler, mode: 'desktop', log: quiet, env: {} })
    teardown.push(() => address.stop())
    await address.start()
    expect(address.status().state).toBe('off')

    const s = await address.configure({ enabled: true, relayUrl: relay.url })
    expect(s.enabled).toBe(true)
    const base = await until(() => address.publicUrl())
    const status = address.status()
    expect(status).toMatchObject({ state: 'connected', source: 'relay' })
    expect(base).toContain(status.installId!)

    const token = 'mwl_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd'
    const r = await fetch(`${base}/f/${token}/api/form`, { headers: { 'user-agent': 'phone' } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'open', title: 'Your details' })
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    // The relay names the client's address; the token reached the kernel from the path.
    const [gotToken, info] = seen[0]!.args as [string, { ip?: string }]
    expect(gotToken).toBe(token)
    expect(info.ip).toBeTruthy()

    const page = await fetch(`${base}/f/${token}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("This form isn't available right now") // the form app isn't built here

    const bytes = new Uint8Array(600 * 1024).fill(7) // more than one 256 KiB chunk each way
    const up = await fetch(`${base}/f/${token}/api/files?name=pan-card.pdf`, { method: 'POST', body: bytes, headers: { 'content-type': 'application/pdf' } })
    expect(await up.json()).toEqual({ document: { id: 'file_1', name: 'pan-card.pdf', mime: 'application/pdf', size: bytes.byteLength } })

    const hook = await fetch(`${base}/h/hk_whatsapp?hub.mode=subscribe&hub.challenge=4242`)
    expect(await hook.text()).toBe('4242')

    // Turning it off closes the tunnel; links have no address again.
    await address.configure({ enabled: false })
    expect(address.publicUrl()).toBeUndefined()
  }, 30_000)
})
