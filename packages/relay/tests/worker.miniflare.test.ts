// The Cloudflare Worker and its Durable Object under Miniflare (a local workerd), with the
// real tunnel client dialling it. Skips with a reason when Miniflare or workerd can't run here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startRelayTunnel } from '../src/client.ts';
import { generateIdentity } from '../src/protocol-impl.ts';
import type { RelayTunnel } from '../src/protocol.ts';
import { bytes, quietLog, sha256Hex, waitFor } from './helpers.ts';

type MiniflareLike = { ready: Promise<URL>; dispose(): Promise<void> };

let mf: MiniflareLike | null = null;
let base = '';
let skipReason = '';

async function bundleWorker(): Promise<string> {
  const out = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/cloudflare/worker.ts')], target: 'browser', format: 'esm', minify: false });
  if (!out.success) throw new Error(out.logs.map(String).join('\n'));
  return out.outputs[0]!.text();
}

beforeAll(async () => {
  let Miniflare: new (opts: Record<string, unknown>) => MiniflareLike;
  try {
    ({ Miniflare } = (await import('miniflare')) as unknown as { Miniflare: typeof Miniflare });
  } catch (err) {
    skipReason = `miniflare is not installed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  try {
    const script = await bundleWorker();
    // Port 0: workerd picks one. PUBLIC_URL is only used in `welcome` and page links.
    mf = new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-07-01',
      port: 0,
      host: '127.0.0.1',
      durableObjects: { INSTALL_TUNNEL: 'InstallTunnel' },
      r2Buckets: ['PAGES'],
      bindings: { PUBLIC_URL: 'http://relay.test', LIMITS_JSON: JSON.stringify({ requestTimeoutMs: 2_000 }) },
    });
    base = (await mf.ready).toString().replace(/\/$/, '');
  } catch (err) {
    skipReason = `Miniflare could not start workerd here: ${err instanceof Error ? err.message : String(err)}`;
    mf = null;
  }
});

afterAll(async () => {
  await mf?.dispose();
});

const running = () => {
  if (!mf) console.warn(`[skipped] ${skipReason}`);
  return Boolean(mf);
};

describe('the Worker under Miniflare', () => {
  let tunnel: RelayTunnel | null = null;
  let installId = '';

  afterAll(async () => {
    await tunnel?.close();
  });

  test('health and the offline page come from the Worker and the Durable Object', async () => {
    if (!running()) return;
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    const id = (await generateIdentity()).installId;
    const res = await fetch(`${base}/x/${id}/f/mwl_abc`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('The business&#39;s MemWise app is offline; please try again later.');
    expect((await fetch(`${base}/x/${id}/admin`)).status).toBe(404);
  });

  test('the tunnel handshake goes through the Durable Object', async () => {
    if (!running()) return;
    const identity = await generateIdentity();
    installId = identity.installId;
    tunnel = startRelayTunnel({
      relayUrl: base,
      identity,
      log: quietLog,
      backoff: { minMs: 100, maxMs: 500 },
      handle: async (req) => {
        const body = req.method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
        return Response.json(
          { method: req.method, url: req.url, ip: req.headers.get('x-memwise-client-ip'), bytes: body.length, sha: await sha256Hex(body) },
          { headers: { 'set-cookie': 'x=1' } },
        );
      },
    });
    await waitFor(() => tunnel!.status().state === 'connected', 10_000, 'the tunnel to connect through the Worker');
    expect(tunnel.status().publicUrl).toBe(`http://relay.test/x/${installId}`);
  });

  test('a GET and a POST are forwarded through the Durable Object', async () => {
    if (!running() || !tunnel) return;
    const get = await fetch(`${base}/x/${installId}/f/mwl_abc/api/form?x=1`, { headers: { 'cf-connecting-ip': '203.0.113.9', cookie: 'a=b' } });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ method: 'GET', url: `http://relay.test/x/${installId}/f/mwl_abc/api/form?x=1`, ip: '203.0.113.9' });
    expect(get.headers.get('set-cookie')).toBeNull();
    expect(get.headers.get('x-robots-tag')).toBe('noindex');

    const small = await fetch(`${base}/x/${installId}/f/mwl_abc/api/submit`, { method: 'POST', body: JSON.stringify({ values: {} }) });
    expect(await small.json()).toMatchObject({ method: 'POST', bytes: 13 });

    const body = bytes(2 * 1024 * 1024, 9);
    const big = await fetch(`${base}/x/${installId}/f/mwl_abc/api/files?name=a.pdf`, { method: 'POST', body });
    expect(await big.json()).toMatchObject({ method: 'POST', bytes: body.length, sha: await sha256Hex(body) });
  });

  test('a large response streams back through the Durable Object', async () => {
    if (!running() || !tunnel) return;
    // A second install whose core answers 3 MiB, more than one WebSocket message can hold.
    const identity = await generateIdentity();
    const payload = bytes(3 * 1024 * 1024, 4);
    const t = startRelayTunnel({ relayUrl: base, identity, log: quietLog, handle: async () => new Response(payload) });
    try {
      await waitFor(() => t.status().state === 'connected', 10_000, 'the second tunnel');
      const got = new Uint8Array(await (await fetch(`${base}/x/${identity.installId}/assets/big.bin`)).arrayBuffer());
      expect(got.length).toBe(payload.length);
      expect(await sha256Hex(got)).toBe(await sha256Hex(payload));
    } finally {
      await t.close();
    }
  });

  test('after the tunnel closes the install is offline again', async () => {
    if (!running() || !tunnel) return;
    await tunnel.close();
    tunnel = null;
    let status = 0;
    for (let i = 0; i < 50 && status !== 503; i++) {
      status = (await fetch(`${base}/x/${installId}/f/mwl_abc`)).status;
      if (status !== 503) await Bun.sleep(50);
    }
    expect(status).toBe(503);
  });

  test('shared pages are stored in R2', async () => {
    if (!running()) return;
    const content = '<html><body>hi</body></html>';
    const digest = await sha256Hex(new TextEncoder().encode(content));
    const form = new FormData();
    form.set('manifest', JSON.stringify({ version: 1, slug: 's', title: 'T', kind: 'static', contentDigest: digest, includesData: false }));
    form.set('content', new Blob([content], { type: 'text/html' }), 'index.html');
    const res = await fetch(`${base}/p/api/publications`, { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; url: string; adminToken: string };
    expect(dto.url).toBe(`http://relay.test/p/${dto.id}`);
    expect(await (await fetch(`${base}/p/${dto.id}/content`)).text()).toBe(content);
    const del = await fetch(`${base}/p/api/publications/${dto.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${dto.adminToken}` } });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/p/${dto.id}`)).status).toBe(404);
  });
});
