/**
 * The install's relay identity (23 §2): an Ed25519 key pair kept at
 * `<configDir>/relay/identity.json` (mode 0600), read and made by the relay package. A file that
 * is not a valid identity is kept aside as `identity.json.broken` and replaced, so the install
 * keeps working (with a new id, which the status shows).
 */
import { existsSync, renameSync } from 'node:fs'
import { generateIdentity, installIdOf, toBase32 } from '@memwise/relay'
import { loadOrCreateIdentity as loadRelayIdentity } from '@memwise/relay/identity-file'
import type { RelayIdentity } from '@memwise/relay/protocol'

export { generateIdentity, installIdOf, toBase32 as base32 }

export async function loadOrCreateIdentity(file: string): Promise<RelayIdentity> {
  try {
    return await loadRelayIdentity(file)
  } catch (e) {
    if (!existsSync(file)) throw e
    renameSync(file, `${file}.broken`)
    return loadRelayIdentity(file)
  }
}
