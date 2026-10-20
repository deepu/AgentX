// The install's key pair on disk (server-core keeps it at ~/.memwise/relay/identity.json).
// Node fs, so it stays out of the runtime-free files the Worker bundles.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RelayIdentity } from './protocol.ts';
import { checkIdentity, generateIdentity } from './protocol-impl.ts';

/** Reads the identity at `file`, or makes one and writes it there (mode 0600). */
export async function loadOrCreateIdentity(file: string): Promise<RelayIdentity> {
  if (existsSync(file)) {
    let identity: RelayIdentity;
    try {
      identity = JSON.parse(readFileSync(file, 'utf8')) as RelayIdentity;
    } catch (err) {
      throw new Error(`the relay identity at ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    await checkIdentity(identity);
    try {
      chmodSync(file, 0o600); // tighten a file someone loosened
    } catch {
      // not ours to change (a read-only mount); reading it still works
    }
    return identity;
  }
  const identity = await generateIdentity();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  return identity;
}
