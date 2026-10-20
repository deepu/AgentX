// Identity, signatures and body encoding for the tunnel protocol (23 §2). Runtime-free: only
// Web Crypto, TextEncoder and atob/btoa, so it runs in Workers, Bun and Node 20+.
import { CHUNK_BYTES, helloMessage, PROTOCOL_VERSION, type CoreToRelay, type RelayIdentity } from './protocol.ts';

// ---- base64 ----

type B64Native = { toBase64?: (o?: { alphabet?: string; omitPadding?: boolean }) => string };
type B64Ctor = { fromBase64?: (s: string, o?: { alphabet?: string }) => Uint8Array };

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as B64Native).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  // String.fromCharCode takes its arguments on the stack, so feed it slices.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as B64Ctor).fromBase64;
  if (typeof native === 'function') return native(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromBase64Url(text: string): Uint8Array {
  const normal = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(normal + '='.repeat((4 - (normal.length % 4)) % 4));
}

// ---- base32 (RFC 4648, lowercase, no padding) ----

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** An install id is 16 base32 characters: a valid DNS label. */
export const INSTALL_ID_RE = /^[a-z2-7]{16}$/;
export const isInstallId = (value: string) => INSTALL_ID_RE.test(value);

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  let hex = '';
  for (const b of await sha256(data)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Compares two strings in time that depends only on their lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- identity ----

const ED25519 = { name: 'Ed25519' } as const;

/** The install id of a key: base32 of the first 10 bytes of sha256(raw public key). */
export async function installIdOf(publicKeyB64url: string): Promise<string> {
  const digest = await sha256(fromBase64Url(publicKeyB64url));
  return toBase32(digest.subarray(0, 10));
}

export async function generateIdentity(): Promise<RelayIdentity> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const publicKey = toBase64Url(raw);
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;
  return { installId: await installIdOf(publicKey), publicKey, privateJwk };
}

/** Checks that a loaded identity is whole: an Ed25519 JWK whose public half matches and an id that fits. */
export async function checkIdentity(identity: RelayIdentity): Promise<void> {
  const jwk = identity.privateJwk;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new Error('the relay identity is not an Ed25519 private key');
  }
  if (jwk.x !== identity.publicKey) throw new Error('the relay identity\'s public key does not match its private key');
  if ((await installIdOf(identity.publicKey)) !== identity.installId) {
    throw new Error('the relay identity\'s install id does not match its key');
  }
}

export async function signHello(identity: RelayIdentity, nonce: string, client = 'memwise'): Promise<Extract<CoreToRelay, { t: 'hello' }>> {
  const key = await crypto.subtle.importKey('jwk', identity.privateJwk as never /* a JsonWebKey; the type isn't in every lib this compiles under */, ED25519, false, ['sign']);
  const message = new TextEncoder().encode(helloMessage(nonce, identity.installId));
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, key, message));
  return { t: 'hello', v: PROTOCOL_VERSION, publicKey: identity.publicKey, sig: toBase64Url(sig), client };
}

/**
 * Checks a `hello` against the relay's nonce and the install id the core dialled: the
 * version, that the key hashes to the id, and the signature. Returns why not, or null.
 */
export async function verifyHello(
  hello: { v: number; publicKey: string; sig: string },
  nonce: string,
  installId: string,
): Promise<string | null> {
  if (hello.v !== PROTOCOL_VERSION) return `unsupported protocol version ${hello.v}`;
  if (typeof hello.publicKey !== 'string' || typeof hello.sig !== 'string') return 'malformed hello';
  let raw: Uint8Array;
  let sig: Uint8Array;
  try {
    raw = fromBase64Url(hello.publicKey);
    sig = fromBase64Url(hello.sig);
  } catch {
    return 'malformed hello';
  }
  if (raw.length !== 32 || sig.length !== 64) return 'malformed hello';
  if ((await installIdOf(hello.publicKey)) !== installId) return 'the key does not belong to this install id';
  try {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(raw), ED25519, false, ['verify']);
    const ok = await crypto.subtle.verify(ED25519, key, new Uint8Array(sig), new TextEncoder().encode(helloMessage(nonce, installId)));
    return ok ? null : 'bad signature';
  } catch {
    return 'bad signature';
  }
}

// ---- body chunks ----

/** Splits bytes into pieces of at most `size` bytes (views, not copies). */
export function splitChunks(bytes: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** Base64 pieces of a body, each at most CHUNK_BYTES before encoding. */
export const encodeChunks = (bytes: Uint8Array, size = CHUNK_BYTES) => splitChunks(bytes, size).map(toBase64);

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Reads a byte stream and hands it on in pieces of at most `size` bytes, as they arrive
 * (a slow stream is not held back to fill a piece). Stops with an error past `limit` bytes;
 * leaving the loop early cancels the stream.
 */
export async function* chunkStream(
  stream: ReadableStream<Uint8Array>,
  opts: { size?: number; limit?: number } = {},
): AsyncGenerator<Uint8Array> {
  const size = opts.size ?? CHUNK_BYTES;
  const reader = stream.getReader();
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (!value?.length) continue;
      total += value.length;
      if (opts.limit !== undefined && total > opts.limit) throw new BodyTooLargeError(opts.limit);
      yield* splitChunks(value, size);
    }
  } finally {
    // Stopped early (the reader left, or the body was too large): cancel the source.
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => {});
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`body over ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Parses a tunnel frame, or null when it is not a JSON object with a string `t`. */
export function parseFrame<T extends { t: string }>(text: string): T | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string' ? (value as T) : null;
  } catch {
    return null;
  }
}

/** The exact ping and pong frames (Cloudflare's auto-response matches the text). */
export const PING_FRAME = JSON.stringify({ t: 'ping' });
export const PONG_FRAME = JSON.stringify({ t: 'pong' });
