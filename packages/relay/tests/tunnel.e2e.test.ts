// End to end: the Bun relay and a real tunnel client, over local sockets.
import { afterEach, describe, expect, test } from 'bun:test';
import { startRelayTunnel } from '../src/client.ts';
import { generateIdentity } from '../src/protocol-impl.ts';
import { CLOSE_REFUSED, type RelayTunnel } from '../src/protocol.ts';
import { bytes, headersObject, quietLog, relay, sha256Hex, tunnel, waitFor } from './helpers.ts';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(opts: Parameters<typeof relay>[0] = {}, handle?: (req: Request) => Promise<Response>) {
  const r = relay(opts);
  cleanup.push(() => r.stop());
  const t = await tunnel(r.url, handle ?? (async (req) => echo(req)));
  cleanup.push(() => t.tunnel.close());
  return { relay: r, ...t, base: `${r.url}/x/${t.identity.installId}` };
}

async function echo(req: Request): Promise<Response> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());
  return Response.json(
    {
      method: req.method,
      url: req.url,
      headers: headersObject(req.headers),
      bodyBytes: body.length,
      bodySha: await sha256Hex(body),
    },
    { headers: { 'set-cookie': 'session=1', 'x-from-core': 'yes', connection: 'keep-alive' } },
  );
}

describe('forwarding through the tunnel', () => {
  test('a GET reaches the core with the public URL and the relay\'s headers, and comes back filtered', async () => {
    const { base, tunnel: t, identity } = await setup();
    expect(t.status()).toMatchObject({ state: 'connected', installId: identity.installId, publicUrl: base });

    const res = await fetch(`${base}/f/mwl_abc/api/form?x=1&y=two`, {
      headers: { cookie: 'secret=1', 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6', 'x-memwise-client-ip': '6.6.6.6', 'x-custom': 'kept' },
    });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { method: string; url: string; headers: Record<string, string> };
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe(`${base}/f/mwl_abc/api/form?x=1&y=two`);
    expect(seen.headers['x-custom']).toBe('kept');
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['cf-connecting-ip']).toBeUndefined();
    expect(seen.headers['x-forwarded-for']).toBeUndefined();
    // The socket's own address: 127.0.0.1 or ::1, whichever localhost resolved to.
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(seen.headers['x-memwise-client-ip']!);
    expect(seen.headers['x-forwarded-host']).toBe(new URL(base).host);
    expect(seen.headers['x-forwarded-proto']).toBe('http');

    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-from-core')).toBe('yes');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  test('a POST with a 5 MiB body arrives whole', async () => {
    const { base } = await setup();
    const body = bytes(5 * 1024 * 1024);
    const res = await fetch(`${base}/f/mwl_abc/api/files?name=scan.pdf`, { method: 'POST', body, headers: { 'content-type': 'application/pdf' } });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { bodyBytes: number; bodySha: string; headers: Record<string, string> };
    expect(seen.bodyBytes).toBe(body.length);
    expect(seen.bodySha).toBe(await sha256Hex(body));
    expect(seen.headers['content-type']).toBe('application/pdf');
  });

  test('a streamed POST body (no content-length) arrives whole', async () => {
    const { base } = await setup();
    const body = bytes(700 * 1024, 3);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.length; i += 100_000) c.enqueue(body.slice(i, i + 100_000));
        c.close();
      },
    });
    const res = await fetch(`${base}/h/hook_1`, { method: 'POST', body: stream });
    const seen = (await res.json()) as { bodyBytes: number; bodySha: string };
    expect(seen.bodyBytes).toBe(body.length);
    expect(seen.bodySha).toBe(await sha256Hex(body));
  });

  test('a PUT for a draft is forwarded', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/f/mwl_abc/api/draft`, { method: 'PUT', body: JSON.stringify({ values: { a: 1 } }), headers: { 'content-type': 'application/json' } });
    expect(((await res.json()) as { method: string }).method).toBe('PUT');
  });

  test('a 20 MiB response comes back whole', async () => {
    const big = bytes(20 * 1024 * 1024, 11);
    const { base } = await setup({}, async () => new Response(big, { headers: { 'content-type': 'application/octet-stream' } }));
    const res = await fetch(`${base}/assets/form/big.bin`);
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(await sha256Hex(got)).toBe(await sha256Hex(big));
  });

  test('a streamed response with no length comes back whole', async () => {
    const part = bytes(300 * 1024, 5);
    const { base } = await setup({}, async () => {
      let n = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          if (n++ >= 4) return c.close();
          await Bun.sleep(5);
          c.enqueue(part);
        },
      }));
    });
    const got = new Uint8Array(await (await fetch(`${base}/assets/form/stream`)).arrayBuffer());
    expect(got.length).toBe(part.length * 4);
  });

  test('concurrent requests each get their own answer', async () => {
    const { base } = await setup({}, async (req) => {
      const n = new URL(req.url).searchParams.get('n')!;
      await Bun.sleep(Math.random() * 30);
      return new Response(`answer ${n}`);
    });
    const answers = await Promise.all(Array.from({ length: 15 }, (_, n) => fetch(`${base}/f/t/${n}?n=${n}`).then((r) => r.text())));
    expect(answers).toEqual(Array.from({ length: 15 }, (_, n) => `answer ${n}`));
  });

  test('more than the concurrent limit is refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { base } = await setup({ limits: { concurrentPerInstall: 3 } }, async () => {
      await gate;
      return new Response('ok');
    });
    const pending = [1, 2, 3].map((n) => fetch(`${base}/f/t/${n}`));
    await Bun.sleep(100);
    const extra = await fetch(`${base}/f/t/4`);
    expect(extra.status).toBe(429);
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  test('a core that takes too long gets a 504 and the request is cancelled', async () => {
    let aborted = false;
    const { base } = await setup({ limits: { requestTimeoutMs: 300 } }, (req) =>
      new Promise<Response>((resolve) => {
        req.signal.addEventListener('abort', () => {
          aborted = true;
          resolve(new Response('late'));
        });
      }));
    const res = await fetch(`${base}/f/mwl_slow`);
    expect(res.status).toBe(504);
    expect(await res.text()).toContain('took too long');
    await waitFor(() => aborted, 2_000, 'the core to see the cancel');
  });

  test('a client that gives up cancels the request at the core', async () => {
    let aborted = false;
    let started = false;
    const { base } = await setup({}, (req) =>
      new Promise<Response>((resolve) => {
        started = true;
        req.signal.addEventListener('abort', () => {
          aborted = true;
          resolve(new Response('late'));
        });
      }));
    const ac = new AbortController();
    const pending = fetch(`${base}/f/mwl_slow`, { signal: ac.signal }).catch((e) => e);
    await waitFor(() => started, 2_000, 'the core to get the request');
    ac.abort();
    await pending;
    await waitFor(() => aborted, 3_000, 'the core to see the cancel');
  });

  test('requests over the per-IP rate limit get a 429', async () => {
    const { base } = await setup({ limits: { requestsPerMinutePerIp: 5 } }, async () => new Response('ok'));
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await fetch(`${base}/f/t`)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    const res = await fetch(`${base}/f/t/api/form`);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
  });

  test('a request body over the limit is refused with 413', async () => {
    const { base } = await setup({ limits: { requestBodyBytes: 1024 * 1024 } });
    const res = await fetch(`${base}/f/t/api/files`, { method: 'POST', body: bytes(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  test('a response over the limit is cut off', async () => {
    const { base } = await setup({ limits: { responseBodyBytes: 1024 * 1024 } }, async () => {
      const big = bytes(3 * 1024 * 1024);
      return new Response(new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }));
    });
    const outcome = await fetch(`${base}/assets/big`).then((r) => r.arrayBuffer()).then((b) => b.byteLength, () => 'broken');
    expect(outcome === 'broken' || (typeof outcome === 'number' && outcome <= 1024 * 1024)).toBe(true);
  });

  test('a handler that throws gives a 500 and the tunnel stays up', async () => {
    const { base, tunnel: t } = await setup({}, async (req) => {
      if (req.url.includes('boom')) throw new Error('boom');
      return new Response('fine');
    });
    expect((await fetch(`${base}/f/boom`)).status).toBe(500);
    expect(await (await fetch(`${base}/f/ok`)).text()).toBe('fine');
    expect(t.status().state).toBe('connected');
  });
});

describe('what never reaches a core', () => {
  test('paths outside the forwarded prefixes are 404 at the relay', async () => {
    let calls = 0;
    const { base, relay: r } = await setup({}, async () => {
      calls++;
      return new Response('core');
    });
    for (const path of ['/', '/admin', '/api/sessions', '/f', '/f/', '/x', '/assetsx/a', '/rpc']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${r.url}/admin`)).status).toBe(404);
    expect((await fetch(`${r.url}/x/notaninstallid00/f/a`)).status).toBe(404);
    expect((await fetch(`${base}/assets/a.js`, { method: 'POST', body: 'x' })).status).toBe(405);
    expect((await fetch(`${base}/h/a`, { method: 'DELETE' })).status).toBe(405);
    expect(calls).toBe(0);
  });

  test('/health answers', async () => {
    const r = relay();
    cleanup.push(() => r.stop());
    expect(await (await fetch(`${r.url}/health`)).json()).toMatchObject({ ok: true });
  });
});

describe('offline, replacement and reconnects', () => {
  test('with no core connected the relay answers the friendly offline page', async () => {
    const r = relay();
    cleanup.push(() => r.stop());
    const id = (await generateIdentity()).installId;
    const res = await fetch(`${r.url}/x/${id}/f/mwl_abc`);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain("This form isn&#39;t available right now.");
    expect(html).toContain('The business&#39;s MemWise app is offline; please try again later.');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('prefers-color-scheme: dark');

    const api = await fetch(`${r.url}/x/${id}/f/mwl_abc/api/form`);
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: 'offline' });
  });

  test('a newer connection replaces the older one (closed with 4000)', async () => {
    const r = relay();
    cleanup.push(() => r.stop());
    const first = await tunnel(r.url, async () => new Response('first'));
    cleanup.push(() => first.tunnel.close());
    const second = await tunnel(r.url, async () => new Response('second'), first.identity);
    cleanup.push(() => second.tunnel.close());
    await waitFor(() => first.tunnel.status().state === 'error', 3_000, 'the first tunnel to be replaced');
    expect(first.tunnel.status().error).toContain('Another copy');
    const base = `${r.url}/x/${first.identity.installId}`;
    expect(await (await fetch(`${base}/f/t`)).text()).toBe('second');
    // The replaced one does not come back to fight.
    await Bun.sleep(300);
    expect(await (await fetch(`${base}/f/t`)).text()).toBe('second');
    expect(second.tunnel.status().state).toBe('connected');
  });

  test('the tunnel reconnects after the relay restarts', async () => {
    const r1 = relay();
    const port = r1.port;
    const t = await tunnel(r1.url, async () => new Response('back'));
    cleanup.push(() => t.tunnel.close());
    const states: string[] = [];
    t.tunnel.onStatus((s) => states.push(s.state));
    await r1.stop();
    await waitFor(() => t.tunnel.status().state !== 'connected', 3_000, 'the tunnel to notice');
    await Bun.sleep(150);
    const r2 = relay({ port });
    cleanup.push(() => r2.stop());
    await waitFor(() => t.tunnel.status().state === 'connected', 5_000, 'the tunnel to reconnect');
    expect(states).toContain('connected');
    expect(await (await fetch(`${r2.url}/x/${t.identity.installId}/f/t`)).text()).toBe('back');
  });

  test('a hello signed with the wrong key is refused', async () => {
    const r = relay();
    cleanup.push(() => r.stop());
    const real = await generateIdentity();
    const other = await generateIdentity();
    // Claims `real`'s install id but holds `other`'s key.
    const t: RelayTunnel = startRelayTunnel({
      relayUrl: r.url,
      identity: { ...other, installId: real.installId },
      handle: async () => new Response('no'),
      log: quietLog,
      backoff: { minMs: 50, maxMs: 100 },
    });
    cleanup.push(() => t.close());
    await waitFor(() => t.status().state === 'error', 3_000, 'the refusal');
    expect(t.status().error).toContain('refused');
    expect(r.hub(real.installId)?.connected ?? false).toBe(false);
    expect(CLOSE_REFUSED).toBe(4001);
  });

  test('pings keep the tunnel up, and a relay that stops answering is left for a new connection', async () => {
    // A stand-in relay that welcomes anyone and then never answers a ping.
    let connections = 0;
    const silent = Bun.serve({
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          connections++;
          ws.send(JSON.stringify({ t: 'challenge', nonce: 'n' }));
        },
        message(ws, msg) {
          if (String(msg).includes('"hello"')) ws.send(JSON.stringify({ t: 'welcome', installId: 'x', publicUrl: 'http://x' }));
        },
      },
    });
    cleanup.push(() => silent.stop(true));
    const t = startRelayTunnel({
      relayUrl: `http://localhost:${silent.port}`,
      identity: await generateIdentity(),
      handle: async () => new Response('x'),
      log: quietLog,
      pingEveryMs: 40,
      backoff: { minMs: 20, maxMs: 40 },
    });
    cleanup.push(() => t.close());
    await waitFor(() => connections >= 2, 3_000, 'the tunnel to give up on the silent relay and dial again');

    // The real relay answers pings, so the same settings stay connected.
    const r = relay();
    cleanup.push(() => r.stop());
    const live = startRelayTunnel({
      relayUrl: r.url,
      identity: await generateIdentity(),
      handle: async () => new Response('x'),
      log: quietLog,
      pingEveryMs: 40,
    });
    cleanup.push(() => live.close());
    await waitFor(() => live.status().state === 'connected', 3_000, 'the live tunnel');
    const since = live.status().since;
    await Bun.sleep(400);
    expect(live.status().state).toBe('connected');
    expect(live.status().since).toBe(since);
  });

  test('close() turns the tunnel off and the install goes offline', async () => {
    const { base, tunnel: t, relay: r, identity } = await setup();
    await t.close();
    expect(t.status().state).toBe('off');
    await waitFor(() => !r.hub(identity.installId)?.connected, 2_000, 'the relay to see the close');
    expect((await fetch(`${base}/f/t`)).status).toBe(503);
  });
});

describe('subdomain mode', () => {
  test('requests to <installId>.<base-domain> reach that install', async () => {
    const r = relay({ baseDomain: 'relay.test', publicUrl: 'http://relay.test' });
    cleanup.push(() => r.stop());
    const local = `http://localhost:${r.port}`;
    const t = await tunnel(local, async (req) => echo(req));
    cleanup.push(() => t.tunnel.close());
    const id = t.identity.installId;
    expect(t.tunnel.status().publicUrl).toBe(`http://${id}.relay.test`);

    const res = await fetch(`${local}/f/mwl_x?a=1`, { headers: { host: `${id}.relay.test` } });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(seen.url).toBe(`http://${id}.relay.test/f/mwl_x?a=1`);
    expect(seen.headers['x-forwarded-host']).toBe(`${id}.relay.test`);

    // Only forwarded routes answer on an install's host; relay pages don't.
    expect((await fetch(`${local}/auth/callback?state=x`, { headers: { host: `${id}.relay.test` } })).status).toBe(404);
    expect((await fetch(`${local}/p/api/publications`, { method: 'POST', headers: { host: `${id}.relay.test` } })).status).toBe(404);
    // A label that is not an install id is 404; path mode is off in subdomain mode.
    expect((await fetch(`${local}/f/a`, { headers: { host: `www.relay.test` } })).status).toBe(404);
    expect((await fetch(`${local}/x/${id}/f/a`, { headers: { host: `relay.test` } })).status).toBe(404);
  });
});
