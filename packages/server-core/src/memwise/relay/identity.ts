/**
 * The install's relay identity (23 §2): an Ed25519 key pair kept at
 * `<configDir>/relay/identity.json` (mode 0600). Its install id is the lowercase base32 of the
 * first 10 bytes of sha256(publicKey): 16 characters, a valid DNS label.
 *
 * A minimal local version behind the name the relay package uses (`loadOrCreateIdentity` in
 * `packages/relay/src/identity-file.ts`); the file format is the same `RelayIdentity`.
 */
import { createHash, webcrypto } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RelayIdentity } from '@memwise/relay/protocol'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lower case, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** The install id of a raw public key given as base64url. */
export function installIdOf(publicKey: string): string {
  const raw = Buffer.from(publicKey, 'base64url')
  return base32(new Uint8Array(createHash('sha256').update(raw).digest()).subarray(0, 10))
}

export async function generateIdentity(): Promise<RelayIdentity> {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as unknown as webcrypto.CryptoKeyPair
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKey = String(jwk.x)
  return { installId: installIdOf(publicKey), publicKey, privateJwk: jwk as Record<string, unknown> }
}

function valid(x: unknown): x is RelayIdentity {
  const i = x as RelayIdentity
  return !!i && typeof i.publicKey === 'string' && typeof i.installId === 'string' && typeof i.privateJwk === 'object' && i.privateJwk !== null
    && installIdOf(i.publicKey) === i.installId && (i.privateJwk as { x?: unknown }).x === i.publicKey
}

/**
 * Reads the identity, or makes one and writes it (0600) when there is none. A file that is not a
 * valid identity is kept aside as `identity.json.broken` and replaced, so the install keeps
 * working (with a new id, which the status shows).
 */
export async function loadOrCreateIdentity(file: string): Promise<RelayIdentity> {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (valid(parsed)) return parsed
    } catch { /* replaced below */ }
    try { renameSync(file, `${file}.broken`) } catch { /* overwritten below */ }
  }
  const identity = await generateIdentity()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* not supported here (Windows) */ }
  return identity
}
