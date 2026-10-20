/**
 * The install's public address (23 §2, §4, §11): the relay tunnel when it is turned on, and on a
 * server a direct listener for the public handler (`MEMWISE_PUBLIC_PORT`, plain HTTP behind the
 * operator's TLS, with `MEMWISE_PUBLIC_URL` as its base). Links are made from `publicUrl()`: the
 * relay's address while the tunnel is connected, else `MEMWISE_PUBLIC_URL`, else none.
 *
 * Nothing here ever blocks or fails the app: a relay that can't be reached, a missing identity or
 * a busy port is logged and shown in the status.
 */
import type { MwRelayConfigureInput, MwRelayStatus } from '@memwise/shared/protocol'
import type { RelayIdentity, RelayTunnel, RelayTunnelOptions, RelayTunnelStatus } from '@memwise/relay/protocol'
import type { PublicHandler } from '../public'
import { loadOrCreateIdentity } from './identity'
import { effectiveRelaySettings, normalizeRelayUrl, relayIdentityFile, writeRelaySettings, type RelaySettings } from './settings'

interface Log { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }

export interface DirectListener { stop(): void | Promise<void>; port: number }

export interface PublicAddressOptions {
  configDir: string
  handler: PublicHandler
  mode: 'desktop' | 'server'
  log: Log
  env?: Record<string, string | undefined>
  /** Shown to the relay in `hello`. */
  client?: string
  /** Tests: the tunnel (default `startRelayTunnel` from `@memwise/relay/client`). */
  startTunnel?: (opts: RelayTunnelOptions) => RelayTunnel | Promise<RelayTunnel>
  /** Tests: the identity (default `<configDir>/relay/identity.json`). */
  loadIdentity?: () => Promise<RelayIdentity>
  /** Tests: the direct listener (default Bun.serve). */
  listen?: (port: number, hostname: string, handler: PublicHandler, trustProxy: boolean) => DirectListener
  /** The status changed (pushes `memwise:changed { kind: 'relay' }`). */
  onChange?: (status: MwRelayStatus) => void
}

export interface PublicAddress {
  /** Where links point now, without a trailing slash; undefined when there is no public address. */
  publicUrl(): string | undefined
  status(): MwRelayStatus
  /** Save the setting and restart the tunnel by it. */
  configure(input: MwRelayConfigureInput): Promise<MwRelayStatus>
  /** Start what the settings say (tunnel, direct listener). Never throws. */
  start(): Promise<void>
  stop(): Promise<void>
}

const trimSlash = (u: string) => u.replace(/\/+$/, '')
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A server's own public base (`MEMWISE_PUBLIC_URL`), checked. */
export function serverPublicUrl(env: Record<string, string | undefined>, log?: Log): string | undefined {
  const raw = env.MEMWISE_PUBLIC_URL?.trim()
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)')
    return trimSlash(`${u.protocol}//${u.host}${u.pathname}`)
  } catch {
    log?.warn(`[memwise] MEMWISE_PUBLIC_URL is not a web address (${raw}); links can't be made from it`)
    return undefined
  }
}

/** Bun.serve for the public handler, with the socket's address (or the proxy's x-forwarded-for when trusted). */
export function bunListener(port: number, hostname: string, handler: PublicHandler, trustProxy: boolean): DirectListener {
  const server = Bun.serve({
    port,
    hostname,
    maxRequestBodySize: 26 * 1024 * 1024,
    fetch(req, srv) {
      const forwarded = trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
      const ip = forwarded || srv.requestIP(req)?.address
      return handler(req, ip ? { ip } : {})
    },
  })
  return { port: server.port ?? port, stop: () => server.stop(true) }
}

export function createPublicAddress(opts: PublicAddressOptions): PublicAddress {
  const env = opts.env ?? process.env
  const log = opts.log
  const serverUrl = serverPublicUrl(env, log)
  let settings: RelaySettings = effectiveRelaySettings(opts.configDir, env)
  // Shown and used as normalised; one that can't be is kept as typed, and the start says why.
  if (settings.relayUrl) {
    try { settings = { ...settings, relayUrl: normalizeRelayUrl(settings.relayUrl) } } catch { /* reported by restartTunnel */ }
  }
  let identity: RelayIdentity | undefined
  let tunnel: RelayTunnel | undefined
  let unsubscribe: (() => void) | undefined
  let localError: { message: string; since: string } | undefined
  let listener: DirectListener | undefined
  /** Bumped on each restart, so a slow start that was overtaken closes its tunnel. */
  let generation = 0
  let stopped = false
  let lastKey = ''

  const tunnelStatus = (): RelayTunnelStatus | undefined => {
    try { return tunnel?.status() } catch { return undefined }
  }

  function status(): MwRelayStatus {
    const t = tunnelStatus()
    const relayUrl = settings.relayUrl
    const installId = t?.installId ?? identity?.installId
    const connected = t?.state === 'connected' && !!t.publicUrl
    const publicUrl = connected ? trimSlash(t!.publicUrl!) : serverUrl
    const base = {
      enabled: settings.enabled,
      ...(relayUrl ? { relayUrl } : {}),
      ...(installId ? { installId } : {}),
      ...(publicUrl ? { publicUrl, source: connected ? 'relay' as const : 'server' as const } : {}),
    }
    if (!settings.enabled) return { ...base, state: 'off' }
    if (localError) return { ...base, state: 'error', error: localError.message, since: localError.since }
    if (!t) return { ...base, state: 'connecting' }
    return { ...base, state: t.state, ...(t.error ? { error: t.error } : {}), ...(t.since ? { since: t.since } : {}) }
  }

  function changed(): void {
    const s = status()
    const key = JSON.stringify([s.enabled, s.state, s.publicUrl, s.relayUrl, s.installId, s.error])
    if (key === lastKey) return
    lastKey = key
    try { opts.onChange?.(s) } catch { /* a listener's failure is its own */ }
  }

  async function closeTunnel(): Promise<void> {
    unsubscribe?.()
    unsubscribe = undefined
    const t = tunnel
    tunnel = undefined
    if (t) {
      try { await t.close() } catch (e) { log.warn(`[memwise] closing the relay tunnel: ${errText(e)}`) }
    }
  }

  async function restartTunnel(): Promise<void> {
    const mine = ++generation
    await closeTunnel()
    localError = undefined
    if (stopped || !settings.enabled) { changed(); return }
    const fail = (message: string) => {
      if (mine !== generation) return
      localError = { message, since: new Date().toISOString() }
      log.warn(`[memwise] public address: ${message}`)
      changed()
    }
    if (!settings.relayUrl) { fail('Enter the address of the relay to connect to.'); return }
    let relayUrl: string
    try { relayUrl = normalizeRelayUrl(settings.relayUrl) } catch (e) { fail(errText(e)); return }
    changed() // connecting
    try {
      identity ??= await (opts.loadIdentity ?? (() => loadOrCreateIdentity(relayIdentityFile(opts.configDir))))()
    } catch (e) {
      fail(`The install's key for the relay could not be read or made: ${errText(e)}`)
      return
    }
    try {
      const start = opts.startTunnel ?? (await import('@memwise/relay/client')).startRelayTunnel
      const t = await start({
        relayUrl, identity, handle: opts.handler, client: opts.client ?? `memwise-${opts.mode}`, log,
      })
      if (mine !== generation || stopped) { await t.close().catch(() => {}); return }
      tunnel = t
      unsubscribe = t.onStatus(() => changed())
      log.info(`[memwise] public address: connecting to the relay ${relayUrl} as ${identity.installId}`)
      changed()
    } catch (e) {
      fail(`The relay connection could not start: ${errText(e)}`)
    }
  }

  function startListener(): void {
    const raw = env.MEMWISE_PUBLIC_PORT?.trim()
    if (!raw || opts.mode !== 'server') return
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      log.warn(`[memwise] MEMWISE_PUBLIC_PORT is not a port number (${raw}); the public pages are not served`)
      return
    }
    if (!serverUrl) log.warn('[memwise] MEMWISE_PUBLIC_PORT is set without MEMWISE_PUBLIC_URL: the public pages are served, but links need MEMWISE_PUBLIC_URL (the address clients reach them at)')
    const hostname = env.MEMWISE_PUBLIC_HOST?.trim() || '0.0.0.0'
    const trustProxy = env.MEMWISE_PUBLIC_TRUST_PROXY === '1' || env.MEMWISE_PUBLIC_TRUST_PROXY === 'true'
    try {
      if (!opts.listen && typeof Bun === 'undefined') {
        log.warn('[memwise] MEMWISE_PUBLIC_PORT needs the server to run under Bun; the public pages are not served')
        return
      }
      listener = (opts.listen ?? bunListener)(port, hostname, opts.handler, trustProxy)
      log.info(`[memwise] public pages on http://${hostname}:${listener.port}${serverUrl ? ` (links: ${serverUrl})` : ''}`)
    } catch (e) {
      log.error(`[memwise] could not serve the public pages on port ${port}: ${errText(e)}`)
    }
  }

  return {
    publicUrl: () => status().publicUrl,
    status,
    async configure(input) {
      const enabled = input?.enabled === true
      const relayUrl = typeof input?.relayUrl === 'string' && input.relayUrl.trim() ? normalizeRelayUrl(input.relayUrl) : settings.relayUrl
      if (enabled && !relayUrl) throw new Error('Enter the address of the relay to connect to.')
      settings = { enabled, ...(relayUrl ? { relayUrl } : {}) }
      writeRelaySettings(opts.configDir, settings)
      await restartTunnel()
      return status()
    },
    async start() {
      stopped = false
      startListener()
      try { await restartTunnel() } catch (e) { log.warn(`[memwise] public address: ${errText(e)}`) }
    },
    async stop() {
      stopped = true
      generation++
      await closeTunnel()
      if (listener) {
        try { await listener.stop() } catch { /* already stopped */ }
        listener = undefined
      }
    },
  }
}
