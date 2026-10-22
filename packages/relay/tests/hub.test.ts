// The runtime-free hub: routes, header rules, the handshake through fake sockets.
import { describe, expect, test } from 'bun:test';
import {
  classifyRoute,
  filterRequestHeaders,
  filterResponseHeaders,
  installPublicUrl,
  InstallHub,
  offlineResponse,
  type RelayConfig,
  type SocketMeta,
  type TunnelSocket,
} from '../src/hub.ts';
import { generateIdentity, signHello } from '../src/protocol-impl.ts';
import type { RelayToCore } from '../src/protocol.ts';

const ID = 'abcdefghijklmnop';
const pathMode: RelayConfig = { publicUrl: 'http://localhost:8788' };
const subMode: RelayConfig = { publicUrl: 'https://relay.memwise.ai', baseDomain: 'relay.memwise.ai' };

const route = (method: string, url: string, host: string, config: RelayConfig) => classifyRoute(method, new URL(url), host, config);

describe('routes', () => {
  test('path mode', () => {
    const host = 'localhost:8788';
    expect(route('GET', `http://h/x/${ID}/f/mwl_1`, host, pathMode)).toEqual({ kind: 'forward', installId: ID, path: '/f/mwl_1', query: '' });
    expect(route('POST', `http://h/x/${ID}/f/mwl_1/api/submit?a=b`, host, pathMode)).toEqual({ kind: 'forward', installId: ID, path: '/f/mwl_1/api/submit', query: 'a=b' });
    expect(route('PUT', `http://h/x/${ID}/f/mwl_1/api/draft`, host, pathMode).kind).toBe('forward');
    expect(route('GET', `http://h/x/${ID}/i/mwl_2`, host, pathMode).kind).toBe('forward');
    // Stage 5: an inspector's read-only view; it never takes a PUT.
    expect(route('GET', `http://h/x/${ID}/v/mwi_3`, host, pathMode).kind).toBe('forward');
    expect(route('POST', `http://h/x/${ID}/v/mwi_3/api/ask`, host, pathMode).kind).toBe('forward');
    expect(route('PUT', `http://h/x/${ID}/v/mwi_3/api/ask`, host, pathMode).kind).toBe('method-not-allowed');
    expect(route('POST', `http://h/x/${ID}/h/hook_1`, host, pathMode).kind).toBe('forward');
    expect(route('GET', `http://h/x/${ID}/assets/form/app.js`, host, pathMode).kind).toBe('forward');
    expect(route('POST', `http://h/x/${ID}/assets/form/app.js`, host, pathMode)).toEqual({ kind: 'method-not-allowed', allow: 'GET, HEAD' });
    expect(route('DELETE', `http://h/x/${ID}/f/mwl_1`, host, pathMode).kind).toBe('method-not-allowed');
    for (const p of ['/', '/api/x', '/f', '/f/', '/files/a', '/connect/x']) {
      expect(route('GET', `http://h/x/${ID}${p}`, host, pathMode).kind).toBe('not-found');
    }
    expect(route('GET', 'http://h/x/NOTANID/f/a', host, pathMode).kind).toBe('not-found');
    // Dot segments are resolved before routing, so they can't climb out of a prefix.
    expect(route('GET', `http://h/x/${ID}/f/../api/secret`, host, pathMode).kind).toBe('not-found');
    expect(route('GET', `http://h/x/${ID}/f/%2e%2e/admin`, host, pathMode).kind).toBe('not-found');
    expect(route('GET', 'http://h/health', host, pathMode)).toEqual({ kind: 'health' });
    expect(route('GET', `http://h/connect/${ID}`, host, pathMode)).toEqual({ kind: 'connect', installId: ID });
    expect(route('GET', 'http://h/connect/bad', host, pathMode).kind).toBe('not-found');
    expect(route('GET', 'http://h/auth/callback?code=1', host, pathMode)).toEqual({ kind: 'oauth-callback' });
    expect(route('POST', 'http://h/auth/callback', host, pathMode).kind).toBe('method-not-allowed');
    expect(route('POST', 'http://h/p/api/publications', host, pathMode)).toEqual({ kind: 'pages', path: '/p/api/publications' });
    expect(route('GET', 'http://h/f/mwl_1', host, pathMode).kind).toBe('not-found');
  });

  test('subdomain mode', () => {
    expect(route('GET', 'https://x/f/mwl_1?q=1', `${ID}.relay.memwise.ai`, subMode)).toEqual({ kind: 'forward', installId: ID, path: '/f/mwl_1', query: 'q=1' });
    expect(route('GET', 'https://x/f/mwl_1', `${ID.toUpperCase()}.Relay.Memwise.AI:443`, subMode).kind).toBe('forward');
    expect(route('GET', 'https://x/auth/callback', `${ID}.relay.memwise.ai`, subMode).kind).toBe('not-found');
    expect(route('GET', 'https://x/p/abc', `${ID}.relay.memwise.ai`, subMode).kind).toBe('not-found');
    expect(route('GET', 'https://x/health', `${ID}.relay.memwise.ai`, subMode).kind).toBe('health');
    expect(route('GET', `https://x/connect/${ID}`, 'relay.memwise.ai', subMode).kind).toBe('connect');
    expect(route('GET', 'https://x/auth/callback', 'relay.memwise.ai', subMode).kind).toBe('oauth-callback');
    expect(route('GET', 'https://x/f/mwl_1', 'relay.memwise.ai', subMode).kind).toBe('not-found');
    expect(route('GET', `https://x/x/${ID}/f/a`, 'relay.memwise.ai', subMode).kind).toBe('not-found');
    expect(route('GET', 'https://x/f/a', 'www.relay.memwise.ai', subMode).kind).toBe('not-found');
    expect(route('GET', 'https://x/f/a', `a.${ID}.relay.memwise.ai`, subMode).kind).toBe('not-found');
  });

  test('public URLs', () => {
    expect(installPublicUrl(pathMode, ID)).toBe(`http://localhost:8788/x/${ID}`);
    expect(installPublicUrl({ publicUrl: 'https://example.com/relay/' }, ID)).toBe(`https://example.com/relay/x/${ID}`);
    expect(installPublicUrl(subMode, ID)).toBe(`https://${ID}.relay.memwise.ai`);
    expect(installPublicUrl({ publicUrl: 'http://relay.test:8788', baseDomain: 'relay.test' }, ID)).toBe(`http://${ID}.relay.test:8788`);
  });
});

describe('header rules', () => {
  test('requests lose hop-by-hop headers, cookies, cf-* and spoofed forwarding headers', () => {
    const h = new Headers({
      connection: 'keep-alive, x-hop',
      'x-hop': '1',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      upgrade: 'h2c',
      host: 'evil',
      cookie: 'a=b',
      'cf-ray': 'x',
      'cf-connecting-ip': '9.9.9.9',
      'x-forwarded-for': '9.9.9.9',
      'x-memwise-client-ip': '9.9.9.9',
      forwarded: 'for=9.9.9.9',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'user-agent': 'phone',
    });
    const out = filterRequestHeaders(h, { clientIp: '1.2.3.4', forwardedHost: 'id.relay', forwardedProto: 'https' });
    expect(Object.fromEntries(out)).toEqual({
      'content-type': 'application/json',
      'user-agent': 'phone',
      'x-memwise-client-ip': '1.2.3.4',
      'x-forwarded-host': 'id.relay',
      'x-forwarded-proto': 'https',
    });
  });

  test('responses lose set-cookie and hop-by-hop headers and gain the safety headers', () => {
    const out = filterResponseHeaders([
      ['content-type', 'text/html'],
      ['set-cookie', 'a=b'],
      ['Set-Cookie', 'c=d'],
      ['connection', 'close'],
      ['transfer-encoding', 'chunked'],
      ['content-length', '12'],
      ['x-content-type-options', 'whatever'],
      ['content-security-policy', "default-src 'self'"],
    ]);
    expect(out.get('set-cookie')).toBeNull();
    expect(out.get('connection')).toBeNull();
    expect(out.get('transfer-encoding')).toBeNull();
    expect(out.get('content-type')).toBe('text/html');
    expect(out.get('content-security-policy')).toBe("default-src 'self'");
    expect(out.get('x-content-type-options')).toBe('nosniff');
    expect(out.get('referrer-policy')).toBe('no-referrer');
    expect(out.get('x-robots-tag')).toBe('noindex');
  });
});

describe('offline page', () => {
  test('wording, status and shape', async () => {
    const res = offlineResponse('/f/mwl_1', 'GET');
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('This form isn&#39;t available right now.');
    expect(html).toContain('MemWise app is offline; please try again later.');
    expect(html).not.toContain('<script');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(offlineResponse('/i/mwl_1', 'GET').status).toBe(503);
    expect(await offlineResponse('/f/x/api/form', 'GET').json()).toMatchObject({ error: 'offline' });
  });
});

class FakeSocket implements TunnelSocket {
  sent: RelayToCore[] = [];
  closedWith?: [number, string];
  private meta: SocketMeta | null = null;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
  getMeta() {
    return this.meta;
  }
  setMeta(meta: SocketMeta) {
    this.meta = meta;
  }
  last<T extends RelayToCore['t']>(t: T) {
    return this.sent.filter((f) => f.t === t).at(-1) as Extract<RelayToCore, { t: T }> | undefined;
  }
}

describe('handshake', () => {
  test('challenge, hello, welcome; a newer socket replaces the older; restore picks the newest open one', async () => {
    const id = await generateIdentity();
    const hub = new InstallHub(id.installId, { publicUrl: `https://${id.installId}.relay`, helloTimeoutMs: 0 });
    const a = new FakeSocket();
    hub.open(a);
    const challenge = a.last('challenge')!;
    expect(challenge.nonce.length).toBeGreaterThan(20);
    await hub.message(a, JSON.stringify(await signHello(id, challenge.nonce)));
    expect(a.last('welcome')).toEqual({ t: 'welcome', installId: id.installId, publicUrl: `https://${id.installId}.relay` });
    expect(hub.connected).toBe(true);

    await hub.message(a, JSON.stringify({ t: 'ping' }));
    expect(a.sent.at(-1)).toEqual({ t: 'pong' });

    const b = new FakeSocket();
    hub.open(b);
    await hub.message(b, JSON.stringify(await signHello(id, b.last('challenge')!.nonce)));
    expect(a.closedWith).toEqual([4000, 'replaced by a newer connection']);
    expect(b.last('welcome')).toBeTruthy();

    // A replayed hello (a's nonce) on a fresh socket fails.
    const c = new FakeSocket();
    hub.open(c);
    await hub.message(c, JSON.stringify(await signHello(id, challenge.nonce)));
    expect(c.last('refused')?.reason).toBe('bad signature');
    expect(c.closedWith?.[0]).toBe(4001);

    // After the host forgets its state, the open socket is found again.
    const fresh = new InstallHub(id.installId, { publicUrl: 'x', helloTimeoutMs: 0 });
    fresh.restore([a, b, c]);
    expect(fresh.connected).toBe(true);
  });

  test('anything but hello first is refused, and so is silence', async () => {
    const id = await generateIdentity();
    const hub = new InstallHub(id.installId, { publicUrl: 'x', helloTimeoutMs: 50 });
    const a = new FakeSocket();
    hub.open(a);
    await hub.message(a, JSON.stringify({ t: 'res', id: '1', status: 200, headers: [] }));
    expect(a.last('refused')?.reason).toBe('expected hello');
    const b = new FakeSocket();
    hub.open(b);
    await Bun.sleep(100);
    expect(b.last('refused')?.reason).toBe('no hello in time');
  });
});

describe('the concurrent cap', () => {
  test('requests still reading a small body count toward it', async () => {
    const id = await generateIdentity();
    const hub = new InstallHub(id.installId, { publicUrl: 'x', helloTimeoutMs: 0, limits: { concurrentPerInstall: 2 } });
    const a = new FakeSocket();
    hub.open(a);
    await hub.message(a, JSON.stringify(await signHello(id, a.last('challenge')!.nonce)));
    // Two senders that never finish their (declared small) bodies.
    const dribble = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); } });
    const req = (n: number) => ({
      method: 'POST', path: `/f/t/${n}`, query: '', headers: [['content-length', '100']] as [string, string][], body: dribble(), clientIp: `10.0.0.${n}`,
    });
    void hub.forward(req(1));
    void hub.forward(req(2));
    await Bun.sleep(10);
    const third = await hub.forward(req(3));
    expect(third.status).toBe(429);
  });
});

