/**
 * The relay's tunnel protocol and install identity (docs/memwise/23-phase-5-interfaces.md §2).
 *
 * PHASE 5 CONTRACT. The relay hub (`hub.ts`, run by the Cloudflare Worker and the Bun host)
 * and the core's tunnel client (`client.ts`) both code against this file. Runtime-free: only
 * Web Crypto and TextEncoder, so it runs in Workers, Bun and Node. Change only additively.
 */

export const PROTOCOL_VERSION = 1;

/** Signed with the install's key in `hello`: the relay's nonce, this label and the install id. */
export const HELLO_LABEL = 'memwise-relay-v1';

/** Bodies travel base64 in chunks of at most this many bytes (frames stay under 1 MiB). */
export const CHUNK_BYTES = 256 * 1024;

export const LIMITS = {
  requestBodyBytes: 25 * 1024 * 1024,
  responseBodyBytes: 25 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  requestsPerMinutePerIp: 120,
  concurrentPerInstall: 20,
  pingEveryMs: 30_000,
} as const;

/** The path prefixes the relay forwards to a core; anything else never reaches it. */
export const FORWARDED_PREFIXES = ['/f/', '/i/', '/h/', '/assets/'] as const;

/** Close code for a connection replaced by a newer one of the same install. */
export const CLOSE_REPLACED = 4000;
export const CLOSE_REFUSED = 4001;

export type Headers2 = [name: string, value: string][];

export type RelayToCore =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; installId: string; publicUrl: string }
  | { t: 'refused'; reason: string }
  /** `path` starts with one of FORWARDED_PREFIXES; `query` without the `?`. */
  | { t: 'req'; id: string; method: string; path: string; query: string; headers: Headers2; body?: string; more?: boolean }
  | { t: 'req.body'; id: string; chunk: string; end?: boolean }
  | { t: 'cancel'; id: string }
  | { t: 'ping' }
  | { t: 'pong' };

export type CoreToRelay =
  | { t: 'hello'; v: number; publicKey: string; sig: string; client: string }
  | { t: 'res'; id: string; status: number; headers: Headers2; body?: string; more?: boolean }
  | { t: 'res.body'; id: string; chunk: string; end?: boolean }
  | { t: 'cancel'; id: string }
  | { t: 'ping' }
  | { t: 'pong' };

/** An install's key pair as kept on disk (JWK, Ed25519). */
export interface RelayIdentity {
  installId: string;
  publicKey: string;   // base64url of the raw 32-byte key
  privateJwk: Record<string, unknown>; // an Ed25519 JWK
}

/** The text signed in `hello`. */
export const helloMessage = (nonce: string, installId: string) => `${nonce}:${HELLO_LABEL}:${installId}`;

// Implemented in protocol-impl.ts by the relay piece: generateIdentity, installIdOf(publicKey),
// signHello(identity, nonce), verifyHello(hello, nonce, installId), toBase64/fromBase64 chunking.

/** What the core's tunnel reports (Settings → Public address). */
export interface RelayTunnelStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  relayUrl?: string;
  installId?: string;
  publicUrl?: string;
  error?: string;
  since: string;
}

export interface RelayTunnelOptions {
  /** `https://relay.example.com` or `http://localhost:8788`; the tunnel dials `/connect/<installId>` on it. */
  relayUrl: string;
  identity: RelayIdentity;
  /** Answers a forwarded request (the core's public handler). */
  handle: (req: Request) => Promise<Response>;
  /** Shown to the relay in `hello` (`memwise-desktop/0.16.0`). */
  client?: string;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
}

export interface RelayTunnel {
  status(): RelayTunnelStatus;
  onStatus(listener: (s: RelayTunnelStatus) => void): () => void;
  close(): Promise<void>;
}
