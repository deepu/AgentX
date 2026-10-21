// Shared pages at the relay, driven by the app's own PagePublisher (packages/shared), so the
// relay answers exactly what the app sends and expects.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryPageStore } from '../src/pages.ts';
import { DirectoryPageStore } from '../src/bun/serve.ts';
import { relay, sha256Hex } from './helpers.ts';

// Loaded by path so the relay package itself never depends on @memwise/shared.
const sharedPages = '../../shared/src/pages/index.ts';
const shared = (await import(sharedPages)) as {
  PagePublisher: new (o: { tokenStore: unknown; apiBaseUrl: string }) => {
    publish(root: string, ws: string, slug: string, o: { includeData: boolean; password?: string }): Promise<{ share?: { publicationId: string; url: string; publishedRevision: string; passwordProtected: boolean } }>;
    setPassword(root: string, ws: string, slug: string, password: string | null): Promise<{ share?: { passwordProtected: boolean } }>;
    unpublish(root: string, ws: string, slug: string): Promise<{ config: { share?: unknown }; warning?: string }>;
  };
  createPage(root: string, input: { name: string; content: string; kind?: string }): { slug: string; id: string };
  savePageContent(root: string, slug: string, content: string): unknown;
  getPageSnapshotPath(root: string, slug: string): string;
};

const store = new MemoryPageStore();
const r = relay({ pages: store });
let root: string;
const tokens = new Map<string, string>();
const tokenStore = {
  async get(ws: string, page: string) { return tokens.get(`${ws}/${page}`) ?? null; },
  async set(ws: string, page: string, token: string) { tokens.set(`${ws}/${page}`, token); },
  async delete(ws: string, page: string) { return tokens.delete(`${ws}/${page}`); },
};
const previousFlag = process.env.MEMWISE_FEATURE_PAGES_SHARING;

beforeAll(() => {
  process.env.MEMWISE_FEATURE_PAGES_SHARING = '1';
  root = mkdtempSync(join(tmpdir(), 'memwise-relay-pages-'));
});
afterAll(async () => {
  if (previousFlag === undefined) delete process.env.MEMWISE_FEATURE_PAGES_SHARING;
  else process.env.MEMWISE_FEATURE_PAGES_SHARING = previousFlag;
  rmSync(root, { recursive: true, force: true });
  await r.stop();
});

const publisher = () => new shared.PagePublisher({ tokenStore, apiBaseUrl: `${r.url}/p/api` });
const HTML_V1 = '<!doctype html><html><head><title>Sales</title></head><body><h1>Sales v1</h1><script>window.parent.postMessage({protocol:"craft-pages/v1",type:"ready"},"*")</script></body></html>';
const HTML_V2 = HTML_V1.replace('Sales v1', 'Sales v2');

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('publish, republish, password, unpublish', () => {
  test('the whole life of a shared page', async () => {
    const page = shared.createPage(root, { name: 'Sales', content: HTML_V1, kind: 'interactive' });
    mkdirSync(join(root, 'pages', page.slug, 'data'), { recursive: true });
    writeFileSync(shared.getPageSnapshotPath(root, page.slug), JSON.stringify({ kv: { total: 42 } }));

    // Publish (with data).
    const published = await publisher().publish(root, 'ws1', page.slug, { includeData: true });
    const share = published.share!;
    expect(share.url).toBe(`${r.url}/p/${share.publicationId}`);
    expect(share.passwordProtected).toBe(false);
    const token = tokens.get(`ws1/${page.id}`)!;
    expect(token.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url
    // Only the token's hash is kept.
    const meta = JSON.parse(new TextDecoder().decode((await store.get(`pages/${share.publicationId}/meta.json`))!));
    expect(meta.adminTokenHash).toBe(await sha256Hex(new TextEncoder().encode(token)));
    expect(JSON.stringify(meta)).not.toContain(token);

    // The viewer frames the page and hands it the snapshot, view-only.
    const viewer = await fetch(share.url);
    expect(viewer.status).toBe(200);
    const shell = await viewer.text();
    expect(shell).toContain(`src="/p/${share.publicationId}/content?r=`);
    expect(shell).toContain('sandbox="allow-scripts allow-forms"');
    expect(shell).toContain('"total":42');
    expect(shell).toContain('public-actions-disabled');
    expect(viewer.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const content = await fetch(`${share.url}/content`);
    expect(await content.text()).toBe(HTML_V1);
    const csp = content.headers.get('content-security-policy')!;
    expect(csp).toStartWith('sandbox allow-scripts allow-forms;');
    expect(csp).toContain("connect-src 'none'");

    // Republish a new revision, without data this time.
    shared.savePageContent(root, page.slug, HTML_V2);
    const republished = await publisher().publish(root, 'ws1', page.slug, { includeData: false });
    expect(republished.share!.publicationId).toBe(share.publicationId);
    expect(republished.share!.publishedRevision).not.toBe(share.publishedRevision);
    expect(await (await fetch(`${share.url}/content`)).text()).toBe(HTML_V2);
    expect(await (await fetch(share.url)).text()).not.toContain('"total":42');

    // Set a password: the viewer and the content ask for it.
    const locked = await publisher().setPassword(root, 'ws1', page.slug, 'open sesame');
    expect(locked.share!.passwordProtected).toBe(true);
    const gate = await fetch(share.url);
    expect(gate.status).toBe(401);
    expect(await gate.text()).toContain('type="password"');
    expect((await fetch(`${share.url}/content`)).status).toBe(401);

    const wrong = await fetch(share.url, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('not right');

    const right = await fetch(share.url, { method: 'POST', body: new URLSearchParams({ password: 'open sesame' }), redirect: 'manual' });
    expect(right.status).toBe(303);
    expect(right.headers.get('set-cookie')).toContain(`Path=/p/${share.publicationId}`);
    expect(right.headers.get('set-cookie')).toContain('HttpOnly');
    const cookie = cookieFrom(right);
    expect((await fetch(share.url, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${share.url}/content`, { headers: { cookie } })).text()).toBe(HTML_V2);

    // A new password shuts out the old cookie; clearing it opens the page to all.
    await publisher().setPassword(root, 'ws1', page.slug, 'second');
    expect((await fetch(share.url, { headers: { cookie } })).status).toBe(401);
    const cleared = await publisher().setPassword(root, 'ws1', page.slug, null);
    expect(cleared.share!.passwordProtected).toBe(false);
    expect((await fetch(share.url)).status).toBe(200);

    // Unpublish: gone, and a second unpublish of the same id is a 404 the app accepts.
    const result = await publisher().unpublish(root, 'ws1', page.slug);
    expect(result.warning).toBeUndefined();
    expect(result.config.share).toBeUndefined();
    expect((await fetch(share.url)).status).toBe(404);
    expect([...store.items.keys()].filter((k) => k.includes(share.publicationId))).toEqual([]);
  });

  test('a password given at publish time', async () => {
    const page = shared.createPage(root, { name: 'Private', content: '<html><body>secret</body></html>', kind: 'static' });
    const published = await publisher().publish(root, 'ws1', page.slug, { includeData: false, password: 'pw' });
    expect(published.share!.passwordProtected).toBe(true);
    expect((await fetch(published.share!.url)).status).toBe(401);
    await publisher().unpublish(root, 'ws1', page.slug);
  });
});

describe('the API refuses', () => {
  const form = (fields: Record<string, string | Blob>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const manifestFor = async (content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, slug: 's', title: 'T', kind: 'static', contentDigest: await sha256Hex(new TextEncoder().encode(content)), includesData: false, ...extra });

  test('a wrong or missing admin token', async () => {
    const res = await fetch(`${r.url}/p/api/publications`, { method: 'POST', body: form({ manifest: await manifestFor('<p>x</p>'), content: new Blob(['<p>x</p>']) }) });
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; adminToken: string };
    const put = (headers: Record<string, string>) =>
      fetch(`${r.url}/p/api/publications/${dto.id}`, { method: 'PUT', headers, body: form({ passwordAction: 'clear' }) });
    expect((await put({})).status).toBe(403);
    expect((await put({ authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await put({ authorization: `Bearer ${dto.adminToken}` })).status).toBe(200);
    expect((await fetch(`${r.url}/p/api/publications/${dto.id}`, { method: 'DELETE', headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
    expect((await fetch(`${r.url}/p/api/publications/${dto.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${dto.adminToken}` } })).status).toBe(200);
    expect((await fetch(`${r.url}/p/api/publications/${dto.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${dto.adminToken}` } })).status).toBe(404);
  });

  test('content that does not match its digest, a bad manifest, and too much', async () => {
    // A fresh connection each time: a refusal sent before the body is read leaves the connection
    // unusable, and Bun 1.3's fetch can hang reusing it.
    const post = (f: FormData) => fetch(`${r.url}/p/api/publications`, { method: 'POST', body: f, keepalive: false });
    expect((await post(form({ manifest: await manifestFor('<p>a</p>'), content: new Blob(['<p>b</p>']) }))).status).toBe(400);
    expect((await post(form({ manifest: '{"version":2}', content: new Blob(['x']) }))).status).toBe(400);
    expect((await post(form({ content: new Blob(['x']) }))).status).toBe(400);
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect((await post(form({ manifest: await manifestFor(big), content: new Blob([big]) }))).status).toBe(413);
    const huge = new Uint8Array(12 * 1024 * 1024);
    expect((await post(form({ manifest: await manifestFor('a'), content: new Blob([huge]) }))).status).toBe(413);
    expect((await fetch(`${r.url}/p/api/publications`, { method: 'POST', body: 'plain', headers: { 'content-type': 'text/plain' }, keepalive: false })).status).toBe(400);
  });

  test('unknown pages and ids are a plain 404', async () => {
    expect((await fetch(`${r.url}/p/aaaaaaaaaaaaaaaaaaaaaaaaaa`)).status).toBe(404);
    expect((await fetch(`${r.url}/p/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${r.url}/p/api/nothing`)).status).toBe(404);
  });
});

describe('pages on disk', () => {
  test('the Bun host keeps pages in a folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwise-relay-pagesdir-'));
    try {
      const s = new DirectoryPageStore(dir);
      await s.put('pages/abc/meta.json', new TextEncoder().encode('{}'));
      expect(new TextDecoder().decode((await s.get('pages/abc/meta.json'))!)).toBe('{}');
      expect(await s.get('pages/abc/missing')).toBeNull();
      await s.delete(['pages/abc/meta.json']);
      expect(await s.get('pages/abc/meta.json')).toBeNull();
      await expect(s.put('../escape', new Uint8Array())).rejects.toThrow('outside');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
