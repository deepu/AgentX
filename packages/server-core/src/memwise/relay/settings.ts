/**
 * The relay setting (Settings → Public address, 23 §11): `{ enabled, relayUrl }` kept at
 * `<configDir>/relay/settings.json`. Without the file, `MEMWISE_RELAY_URL` turns the relay on with
 * that address; without either it is off.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface RelaySettings { enabled: boolean; relayUrl?: string }

export const relayDir = (configDir: string) => join(configDir, 'relay')
export const relaySettingsFile = (configDir: string) => join(relayDir(configDir), 'settings.json')
export const relayIdentityFile = (configDir: string) => join(relayDir(configDir), 'identity.json')

/** The relay's address as people type it: `https://relay.example.com` (http only for this machine). */
export function normalizeRelayUrl(raw: string): string {
  const text = raw.trim()
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch {
    throw new Error(`That is not a web address: ${text}`)
  }
  const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('The relay address starts with https://')
  if (url.username || url.password) throw new Error('The relay address may not carry a user name or password.')
  if (url.search || url.hash) throw new Error('The relay address is just the site, without ? or #.')
  return `${protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

/** The saved setting, if there is one. */
export function readRelaySettings(configDir: string): RelaySettings | undefined {
  const file = relaySettingsFile(configDir)
  if (!existsSync(file)) return undefined
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown; relayUrl?: unknown }
    return {
      enabled: data.enabled === true,
      ...(typeof data.relayUrl === 'string' && data.relayUrl.trim() ? { relayUrl: data.relayUrl.trim() } : {}),
    }
  } catch {
    return undefined
  }
}

export function writeRelaySettings(configDir: string, settings: RelaySettings): void {
  const file = relaySettingsFile(configDir)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ enabled: settings.enabled, ...(settings.relayUrl ? { relayUrl: settings.relayUrl } : {}) }, null, 2)}\n`)
  renameSync(tmp, file)
}

/** What applies now: the saved setting, else the environment's relay, else off. */
export function effectiveRelaySettings(configDir: string, env: Record<string, string | undefined> = process.env): RelaySettings {
  const saved = readRelaySettings(configDir)
  const fromEnv = env.MEMWISE_RELAY_URL?.trim() || undefined
  if (saved) return { enabled: saved.enabled, ...(saved.relayUrl ?? fromEnv ? { relayUrl: saved.relayUrl ?? fromEnv } : {}) }
  return fromEnv ? { enabled: true, relayUrl: fromEnv } : { enabled: false }
}
