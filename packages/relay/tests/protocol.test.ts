import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity } from '../src/identity-file.ts';
import {
  checkIdentity,
  chunkStream,
  concatBytes,
  encodeChunks,
  fromBase64,
  fromBase64Url,
  generateIdentity,
  installIdOf,
  isInstallId,
  signHello,
  splitChunks,
  toBase32,
  toBase64,
  toBase64Url,
  verifyHello,
} from '../src/protocol-impl.ts';
import { CHUNK_BYTES, helloMessage } from '../src/protocol.ts';
import { bytes } from './helpers.ts';

describe('install ids', () => {
  test('base32 follows RFC 4648 (lowercase, no padding)', () => {
    const enc = (s: string) => toBase32(new TextEncoder().encode(s));
    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foob')).toBe('mzxw6yq');
    expect(enc('fooba')).toBe('mzxw6ytb');
    expect(enc('foobar')).toBe('mzxw6ytboi');
  });

  test('an install id is 16 base32 characters of sha256(public key)', async () => {
    const id = await generateIdentity();
    expect(id.installId).toHaveLength(16);
    expect(isInstallId(id.installId)).toBe(true);
    expect(await installIdOf(id.publicKey)).toBe(id.installId);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fromBase64Url(id.publicKey) as BufferSource));
    expect(toBase32(digest.subarray(0, 10))).toBe(id.installId);
    expect(fromBase64Url(id.publicKey)).toHaveLength(32);
    await checkIdentity(id);
  });

  test('a fixed key gives a fixed id', async () => {
    // 32 zero bytes; checked against Python's hashlib + base64.b32encode.
    expect(await installIdOf(toBase64Url(new Uint8Array(32)))).toBe('mzuhvlpymk6xo3ep');
  });

  test('checkIdentity refuses a mismatched identity', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    await expect(checkIdentity({ ...a, installId: b.installId })).rejects.toThrow('install id');
    await expect(checkIdentity({ ...a, publicKey: b.publicKey })).rejects.toThrow('public key');
  });
});

describe('hello signatures', () => {
  test('a signed hello verifies', async () => {
    const id = await generateIdentity();
    const hello = await signHello(id, 'nonce-1', 'memwise-test/1');
    expect(hello).toMatchObject({ t: 'hello', v: 1, publicKey: id.publicKey, client: 'memwise-test/1' });
    expect(await verifyHello(hello, 'nonce-1', id.installId)).toBeNull();
  });

  test('it signs exactly nonce:memwise-relay-v1:installId', async () => {
    const id = await generateIdentity();
    const hello = await signHello(id, 'abc', 'x');
    const key = await crypto.subtle.importKey('raw', fromBase64Url(id.publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const message = new TextEncoder().encode(`abc:memwise-relay-v1:${id.installId}`);
    expect(helloMessage('abc', id.installId)).toBe(`abc:memwise-relay-v1:${id.installId}`);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(hello.sig) as BufferSource, message)).toBe(true);
  });

  test('the wrong key, nonce, id or version is refused', async () => {
    const id = await generateIdentity();
    const other = await generateIdentity();
    const hello = await signHello(id, 'n', 'x');
    expect(await verifyHello(hello, 'other-nonce', id.installId)).toBe('bad signature');
    expect(await verifyHello(hello, 'n', other.installId)).toBe('the key does not belong to this install id');
    // Someone else's key claiming this id.
    const forged = await signHello({ ...other, installId: id.installId }, 'n', 'x');
    expect(await verifyHello(forged, 'n', id.installId)).toBe('the key does not belong to this install id');
    // The right key with another key's signature.
    expect(await verifyHello({ ...hello, sig: forged.sig }, 'n', id.installId)).toBe('bad signature');
    expect(await verifyHello({ ...hello, v: 2 }, 'n', id.installId)).toContain('version');
    expect(await verifyHello({ ...hello, sig: 'short' }, 'n', id.installId)).toBe('malformed hello');
    expect(await verifyHello({ ...hello, publicKey: '!!' }, 'n', id.installId)).toBe('malformed hello');
  });
});

describe('base64 and chunks', () => {
  test('round trips', () => {
    for (const n of [0, 1, 2, 3, 255, 70_000]) {
      const b = bytes(n, n + 1);
      expect(fromBase64(toBase64(b))).toEqual(b);
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
      expect(toBase64Url(b)).not.toMatch(/[+/=]/);
    }
    expect(toBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  test('bodies split into pieces of at most CHUNK_BYTES and join back', () => {
    const b = bytes(CHUNK_BYTES * 2 + 10);
    const parts = splitChunks(b);
    expect(parts.map((p) => p.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 10]);
    expect(concatBytes(parts)).toEqual(b);
    const encoded = encodeChunks(b);
    expect(encoded).toHaveLength(3);
    // A chunk's frame stays well under Cloudflare's 1 MiB message limit.
    expect(Math.max(...encoded.map((e) => e.length))).toBeLessThan(400 * 1024);
    expect(concatBytes(encoded.map(fromBase64))).toEqual(b);
  });

  test('chunkStream passes pieces on and stops past the limit', async () => {
    const b = bytes(CHUNK_BYTES + 5);
    const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } });
    const got: Uint8Array[] = [];
    for await (const p of chunkStream(stream())) got.push(p);
    expect(got.map((p) => p.length)).toEqual([CHUNK_BYTES, 5]);
    let cancelled = false;
    const limited = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(bytes(1000)); },
      cancel() { cancelled = true; },
    });
    await expect((async () => { for await (const _ of chunkStream(limited, { limit: 5000 })) { /* read */ } })()).rejects.toThrow('body over 5000 bytes');
    expect(cancelled).toBe(true);
  });
});

describe('identity file', () => {
  test('is created with mode 0600 and read back the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwise-relay-id-'));
    try {
      const file = join(dir, 'relay', 'identity.json');
      const a = await loadOrCreateIdentity(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const b = await loadOrCreateIdentity(file);
      expect(b).toEqual(a);
      chmodSync(file, 0o644);
      await loadOrCreateIdentity(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, 'utf8')).installId).toBe(a.installId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a damaged file is an error, not a new identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwise-relay-id-'));
    try {
      const file = join(dir, 'identity.json');
      writeFileSync(file, '{not json');
      await expect(loadOrCreateIdentity(file)).rejects.toThrow('could not be read');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
