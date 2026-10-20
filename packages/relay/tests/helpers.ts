// Shared bits for the relay's tests: a Bun relay on a free port and a tunnel to it.
import { startBunRelay, type BunRelayOptions } from '../src/bun/serve.ts';
import { startRelayTunnel } from '../src/client.ts';
import { generateIdentity } from '../src/protocol-impl.ts';
import type { RelayIdentity, RelayTunnel } from '../src/protocol.ts';

export const quietLog = { info() {}, warn() {}, error() {} };

export function relay(opts: BunRelayOptions = {}) {
  return startBunRelay({ port: 0, log: quietLog, ...opts });
}

export async function waitFor<T>(check: () => T | undefined | false | null, timeoutMs = 5_000, what = 'a condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

export async function tunnel(
  relayUrl: string,
  handle: (req: Request) => Promise<Response>,
  identity?: RelayIdentity,
  extra: { minBackoffMs?: number; wait?: boolean; maxRequestBodyBytes?: number; maxBufferedBytes?: number } = {},
): Promise<{ tunnel: RelayTunnel; identity: RelayIdentity }> {
  const id = identity ?? (await generateIdentity());
  const t = startRelayTunnel({
    relayUrl,
    identity: id,
    handle,
    client: 'memwise-test/0',
    log: quietLog,
    backoff: { minMs: extra.minBackoffMs ?? 50, maxMs: 400, stableAfterMs: 1_000 },
    ...(extra.maxRequestBodyBytes ? { maxRequestBodyBytes: extra.maxRequestBodyBytes } : {}),
    ...(extra.maxBufferedBytes ? { maxBufferedBytes: extra.maxBufferedBytes } : {}),
  });
  if (extra.wait !== false) await waitFor(() => t.status().state === 'connected', 5_000, 'the tunnel to connect');
  return { tunnel: t, identity: id };
}

export function headersObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic bytes that do not compress (so sizes are real). */
export function bytes(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >>> 16;
  }
  return out;
}
