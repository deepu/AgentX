// Shared pages at the relay (23 §8): the server side of the page-share API that
// packages/shared/src/pages/publisher.ts speaks, and the public copies at `/p/<id>`.
//
//   POST   /p/api/publications        manifest, content, snapshot?, password?  → 201 + admin token (once)
//   PUT    /p/api/publications/<id>   a new revision (manifest, content, snapshot?) and/or
//                                     passwordAction=set|clear (+ password)      → 200
//   DELETE /p/api/publications/<id>                                             → 200, or 404
//   GET    /p/<id>                    the viewer: a shell that frames the page and answers its
//                                     `craft-pages/v1` bridge view-only; a password form if set
//   POST   /p/<id>                    the password form
//   GET    /p/<id>/content            the page's HTML, sandboxed by CSP (opaque origin, no network)
//
// The admin token is 256 random bits returned once and kept only as its sha256. A password
// is kept as a PBKDF2 hash; the right password gets a cookie holding the publication's view
// key, which changes whenever the password does. Runtime-free; storage is a `PageStore`.
import type { RelayConfig, RelayLog } from './hub.ts';
import { RateLimiter } from './rate-limit.ts';
import { escapeHtml, htmlResponse, jsonResponse, RESPONSE_SECURITY_HEADERS } from './http.ts';
import type { Headers2 } from './protocol.ts';
import { randomBytes, sha256Hex, timingSafeEqual, toBase32, toBase64Url, fromBase64Url } from './protocol-impl.ts';

/** Bytes by key: R2 on Cloudflare, a folder under Bun, memory in tests. */
export interface PageStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

export class MemoryPageStore implements PageStore {
  readonly items = new Map<string, Uint8Array>();
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async put(key: string, data: Uint8Array) {
    this.items.set(key, data.slice());
  }
  async delete(keys: string[]) {
    for (const k of keys) this.items.delete(k);
  }
}

/** The same caps the app checks before publishing (share-bundle.ts), plus room for the form. */
export const PAGE_LIMITS = {
  contentBytes: 5 * 1024 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  manifestBytes: 64 * 1024,
  bundleBytes: 10 * 1024 * 1024,
  requestBytes: 11 * 1024 * 1024,
  passwordChars: 256,
  publishesPerHourPerIp: 60,
  passwordTriesPerMinute: 10,
} as const;

const PBKDF2_ITERATIONS = 100_000; // the most Cloudflare Workers allow

interface PublicManifest {
  version: 1;
  slug: string;
  title: string;
  description?: string;
  kind: 'static' | 'interactive' | 'live';
  contentDigest: string;
  includesData: boolean;
}

interface PublicationMeta {
  id: string;
  revision: string;
  adminTokenHash: string;
  manifest: PublicManifest;
  includesData: boolean;
  password?: { salt: string; hash: string; iterations: number };
  /** Given as a cookie to viewers who typed the password; changes with the password. */
  viewKey: string;
  createdAt: number;
  updatedAt: number;
}

const metaKey = (id: string) => `pages/${id}/meta.json`;
const contentKey = (id: string) => `pages/${id}/index.html`;
const snapshotKey = (id: string) => `pages/${id}/snapshot.json`;

const ID_RE = /^[a-z2-7]{26}$/;
const newPublicationId = () => toBase32(randomBytes(16));
const newRevision = () => `r_${toBase32(randomBytes(10))}`;

export interface PagesContext {
  store: PageStore;
  config: RelayConfig;
  clientIp: string;
  log?: RelayLog;
}

// Best effort per host (per isolate on Cloudflare): enough to stop a loop, not a determined abuser.
const publishLimiter = new RateLimiter(PAGE_LIMITS.publishesPerHourPerIp, 3_600_000);
const passwordLimiter = new RateLimiter(PAGE_LIMITS.passwordTriesPerMinute, 60_000);

const apiError = (status: number, code: string, message: string) => jsonResponse(status, { error: code, message });

export async function handlePagesRequest(req: Request, path: string, ctx: PagesContext): Promise<Response> {
  if (path === '/p/api/publications' || path === '/p/api/publications/') {
    if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST to publish.');
    return createPublication(req, ctx);
  }
  const api = /^\/p\/api\/publications\/([^/]+)$/.exec(path);
  if (api) {
    const id = decodeURIComponent(api[1]!);
    if (req.method === 'PUT') return updatePublication(req, id, ctx);
    if (req.method === 'DELETE') return deletePublication(req, id, ctx);
    return apiError(405, 'method_not_allowed', 'Use PUT or DELETE.');
  }
  if (path.startsWith('/p/api')) return apiError(404, 'not_found', 'No such endpoint.');

  const view = /^\/p\/([a-z2-7]{26})(\/content)?\/?$/.exec(path);
  if (!view) return pageGone();
  const id = view[1]!;
  if (view[2]) return req.method === 'GET' || req.method === 'HEAD' ? serveContent(req, id, ctx) : methodNotAllowed('GET');
  if (req.method === 'GET' || req.method === 'HEAD') return serveViewer(req, id, ctx);
  if (req.method === 'POST') return checkPassword(req, id, ctx);
  return methodNotAllowed('GET, POST');
}

// ---- the API ----

interface BundleParts {
  manifest?: PublicManifest;
  content?: Uint8Array;
  snapshot?: Uint8Array;
  password?: string;
  passwordAction?: 'set' | 'clear';
}

class BadBundle extends Error {}

/** Whatever FormData the runtime's Response gives (DOM, undici or Workers types alike). */
type Form = Awaited<ReturnType<Response['formData']>>;

async function readForm(req: Request): Promise<Form> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (declared > PAGE_LIMITS.requestBytes) throw new BadBundle('too_large');
  const reader = req.body?.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > PAGE_LIMITS.requestBytes) {
        await reader.cancel().catch(() => {});
        throw new BadBundle('too_large');
      }
      parts.push(value);
    }
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  try {
    return await new Response(body, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData();
  } catch {
    throw new BadBundle('not_form');
  }
}

async function fieldBytes(value: string | Blob | null): Promise<Uint8Array | undefined> {
  if (value === null) return undefined;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(await value.arrayBuffer());
}

function parseManifest(text: string): PublicManifest {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BadBundle('bad_manifest');
  }
  const ok =
    m && typeof m === 'object' && m.version === 1 &&
    typeof m.slug === 'string' && m.slug.length <= 200 &&
    typeof m.title === 'string' && m.title.length <= 500 &&
    (m.description === undefined || (typeof m.description === 'string' && m.description.length <= 5000)) &&
    (m.kind === 'static' || m.kind === 'interactive' || m.kind === 'live') &&
    typeof m.contentDigest === 'string' && /^[0-9a-f]{64}$/.test(m.contentDigest) &&
    typeof m.includesData === 'boolean';
  if (!ok) throw new BadBundle('bad_manifest');
  return {
    version: 1,
    slug: m.slug as string,
    title: m.title as string,
    ...(m.description ? { description: m.description as string } : {}),
    kind: m.kind as PublicManifest['kind'],
    contentDigest: m.contentDigest as string,
    includesData: m.includesData as boolean,
  };
}

async function readBundle(form: Form): Promise<BundleParts> {
  const out: BundleParts = {};
  const manifest = await fieldBytes(form.get('manifest'));
  const content = await fieldBytes(form.get('content'));
  const snapshot = await fieldBytes(form.get('snapshot'));
  if (manifest || content) {
    if (!manifest || !content) throw new BadBundle('incomplete');
    if (manifest.length > PAGE_LIMITS.manifestBytes || content.length > PAGE_LIMITS.contentBytes) throw new BadBundle('too_large');
    if (snapshot && snapshot.length > PAGE_LIMITS.snapshotBytes) throw new BadBundle('too_large');
    if (manifest.length + content.length + (snapshot?.length ?? 0) > PAGE_LIMITS.bundleBytes) throw new BadBundle('too_large');
    out.manifest = parseManifest(new TextDecoder().decode(manifest));
    if ((await sha256Hex(content)) !== out.manifest.contentDigest) throw new BadBundle('digest_mismatch');
    out.content = content;
    if (snapshot) {
      try {
        JSON.parse(new TextDecoder().decode(snapshot));
      } catch {
        throw new BadBundle('bad_snapshot');
      }
      out.snapshot = snapshot;
    }
    if (out.manifest.includesData !== Boolean(snapshot)) out.manifest = { ...out.manifest, includesData: Boolean(snapshot) };
  }
  const action = form.get('passwordAction');
  if (action !== null && action !== 'set' && action !== 'clear') throw new BadBundle('bad_password_action');
  if (action) out.passwordAction = action;
  const password = form.get('password');
  if (password !== null) {
    if (typeof password !== 'string' || !password.length || password.length > PAGE_LIMITS.passwordChars) throw new BadBundle('bad_password');
    out.password = password;
  }
  if (out.passwordAction === 'set' && out.password === undefined) throw new BadBundle('bad_password');
  return out;
}

const BUNDLE_MESSAGES: Record<string, [number, string]> = {
  too_large: [413, 'The page is too large to publish.'],
  not_form: [400, 'Send the page as multipart form data.'],
  incomplete: [400, 'Send both the manifest and the content.'],
  bad_manifest: [400, 'The manifest is not valid.'],
  digest_mismatch: [400, 'The content does not match the digest in the manifest.'],
  bad_snapshot: [400, 'The data snapshot is not valid JSON.'],
  bad_password_action: [400, 'passwordAction must be set or clear.'],
  bad_password: [400, `The password must be 1 to ${PAGE_LIMITS.passwordChars} characters.`],
  nothing: [400, 'Send a new revision or a password change.'],
};

function bundleError(err: unknown): Response {
  if (!(err instanceof BadBundle)) throw err;
  const [status, message] = BUNDLE_MESSAGES[err.message] ?? [400, 'The request is not valid.'];
  return apiError(status, err.message, message);
}

async function hashPassword(password: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations }, key, 256);
  return toBase64Url(new Uint8Array(bits));
}

async function makePassword(password: string): Promise<PublicationMeta['password']> {
  const salt = randomBytes(16);
  return { salt: toBase64Url(salt), hash: await hashPassword(password, salt), iterations: PBKDF2_ITERATIONS };
}

async function passwordMatches(meta: PublicationMeta, password: string): Promise<boolean> {
  if (!meta.password) return true;
  const hash = await hashPassword(password, fromBase64Url(meta.password.salt), meta.password.iterations);
  return timingSafeEqual(hash, meta.password.hash);
}

function publicBase(config: RelayConfig): string {
  const u = new URL(config.publicUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function dto(meta: PublicationMeta, config: RelayConfig, adminToken?: string) {
  return {
    id: meta.id,
    url: `${publicBase(config)}/p/${meta.id}`,
    revision: meta.revision,
    ...(adminToken ? { adminToken } : {}),
    passwordProtected: Boolean(meta.password),
    status: 'published' as const,
    updatedAt: meta.updatedAt,
  };
}

async function loadMeta(store: PageStore, id: string): Promise<PublicationMeta | null> {
  if (!ID_RE.test(id)) return null;
  const raw = await store.get(metaKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as PublicationMeta;
  } catch {
    return null;
  }
}

const saveMeta = (store: PageStore, meta: PublicationMeta) =>
  store.put(metaKey(meta.id), new TextEncoder().encode(JSON.stringify(meta)));

async function authorize(req: Request, store: PageStore, id: string): Promise<PublicationMeta | Response> {
  const meta = await loadMeta(store, id);
  if (!meta) return apiError(404, 'not_found', 'No such publication.');
  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!token || !timingSafeEqual(await sha256Hex(token), meta.adminTokenHash)) {
    return apiError(403, 'forbidden', 'The key for this publication is not valid.');
  }
  return meta;
}

async function createPublication(req: Request, ctx: PagesContext): Promise<Response> {
  const wait = publishLimiter.take(ctx.clientIp);
  if (wait) return jsonResponse(429, { error: 'rate_limited', message: 'Too many publishes; try again later.' }, [['retry-after', String(wait)]]);
  let parts: BundleParts;
  try {
    parts = await readBundle(await readForm(req));
  } catch (err) {
    return bundleError(err);
  }
  if (!parts.manifest || !parts.content) return apiError(400, 'incomplete', BUNDLE_MESSAGES.incomplete![1]);

  const adminToken = toBase64Url(randomBytes(32));
  const now = Date.now();
  const meta: PublicationMeta = {
    id: newPublicationId(),
    revision: newRevision(),
    adminTokenHash: await sha256Hex(adminToken),
    manifest: parts.manifest,
    includesData: Boolean(parts.snapshot),
    ...(parts.password ? { password: await makePassword(parts.password) } : {}),
    viewKey: toBase64Url(randomBytes(32)),
    createdAt: now,
    updatedAt: now,
  };
  await ctx.store.put(contentKey(meta.id), parts.content);
  if (parts.snapshot) await ctx.store.put(snapshotKey(meta.id), parts.snapshot);
  await saveMeta(ctx.store, meta);
  ctx.log?.info(`[relay] published page ${meta.id}`);
  return jsonResponse(201, dto(meta, ctx.config, adminToken));
}

async function updatePublication(req: Request, id: string, ctx: PagesContext): Promise<Response> {
  const found = await authorize(req, ctx.store, id);
  if (found instanceof Response) return found;
  let meta = found;
  let parts: BundleParts;
  try {
    parts = await readBundle(await readForm(req));
  } catch (err) {
    return bundleError(err);
  }
  if (!parts.content && !parts.passwordAction) return apiError(400, 'nothing', BUNDLE_MESSAGES.nothing![1]);

  if (parts.content && parts.manifest) {
    await ctx.store.put(contentKey(id), parts.content);
    if (parts.snapshot) await ctx.store.put(snapshotKey(id), parts.snapshot);
    else await ctx.store.delete([snapshotKey(id)]);
    meta = { ...meta, manifest: parts.manifest, includesData: Boolean(parts.snapshot), revision: newRevision() };
  }
  if (parts.passwordAction === 'set') {
    meta = { ...meta, password: await makePassword(parts.password!), viewKey: toBase64Url(randomBytes(32)) };
  } else if (parts.passwordAction === 'clear') {
    const { password: _old, ...rest } = meta;
    meta = { ...rest, viewKey: toBase64Url(randomBytes(32)) };
  }
  meta = { ...meta, updatedAt: Date.now() };
  await saveMeta(ctx.store, meta);
  return jsonResponse(200, dto(meta, ctx.config));
}

async function deletePublication(req: Request, id: string, ctx: PagesContext): Promise<Response> {
  const found = await authorize(req, ctx.store, id);
  if (found instanceof Response) return found;
  await ctx.store.delete([metaKey(id), contentKey(id), snapshotKey(id)]);
  ctx.log?.info(`[relay] unpublished page ${id}`);
  return jsonResponse(200, { id, status: 'unpublished', updatedAt: Date.now() });
}

// ---- the viewer ----

const methodNotAllowed = (allow: string) =>
  new Response('Method not allowed', { status: 405, headers: [['allow', allow], ...RESPONSE_SECURITY_HEADERS] });

const pageGone = () => htmlResponse(404, "This page isn't available", 'It may have been unpublished, or the link is not complete.');

const cookieName = (id: string) => `mwp_${id}`;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function unlocked(req: Request, meta: PublicationMeta): boolean {
  if (!meta.password) return true;
  const value = readCookie(req, cookieName(meta.id));
  return value !== undefined && timingSafeEqual(value, meta.viewKey);
}

function passwordForm(meta: PublicationMeta, error?: string): Response {
  const body = `
<form method="post" action="/p/${meta.id}">
  <input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required autofocus>
  <button type="submit">Open the page</button>
</form>${error ? `\n<p class="error">${escapeHtml(error)}</p>` : ''}`;
  return htmlResponse(401, meta.manifest.title || 'Shared page', 'This page is protected with a password.', { body });
}

async function checkPassword(req: Request, id: string, ctx: PagesContext): Promise<Response> {
  const meta = await loadMeta(ctx.store, id);
  if (!meta) return pageGone();
  if (!meta.password) return new Response(null, { status: 303, headers: [['location', `/p/${id}`], ...RESPONSE_SECURITY_HEADERS] });
  if (passwordLimiter.take(`${ctx.clientIp}|${id}`)) return passwordForm(meta, 'Too many tries. Wait a minute and try again.');
  let password = '';
  try {
    const form = await req.formData();
    password = String(form.get('password') ?? '').slice(0, PAGE_LIMITS.passwordChars);
  } catch {
    // an empty or odd form is just a wrong password
  }
  if (!password || !(await passwordMatches(meta, password))) return passwordForm(meta, 'That password is not right.');
  const secure = new URL(ctx.config.publicUrl).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: [
      ['location', `/p/${id}`],
      ['set-cookie', `${cookieName(id)}=${meta.viewKey}; Path=/p/${id}; Max-Age=604800; HttpOnly; SameSite=Lax${secure}`],
      ['cache-control', 'no-store'],
      ...RESPONSE_SECURITY_HEADERS,
    ],
  });
}

/** JSON that is safe inside an inline <script> (no `</script>`, no line separators). */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

const VIEWER_HEADERS = (nonce: string): Headers2 => [
  ['content-type', 'text/html; charset=utf-8'],
  ['cache-control', 'no-store'],
  [
    'content-security-policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  ],
  ...RESPONSE_SECURITY_HEADERS,
];

async function serveViewer(req: Request, id: string, ctx: PagesContext): Promise<Response> {
  const meta = await loadMeta(ctx.store, id);
  if (!meta) return pageGone();
  if (!unlocked(req, meta)) return passwordForm(meta);

  let snapshot: unknown = null;
  if (meta.includesData) {
    const raw = await ctx.store.get(snapshotKey(id));
    if (raw) {
      try {
        snapshot = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        snapshot = null;
      }
    }
  }
  const nonce = toBase64Url(randomBytes(16));
  const sandbox = meta.manifest.kind === 'static' ? '' : 'allow-scripts allow-forms';
  const init = { page: { slug: meta.manifest.slug, kind: meta.manifest.kind }, nonce: 'public', snapshot, grants: [] };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(meta.manifest.title || 'Shared page')}</title>
<style>
  html, body { margin: 0; height: 100%; background: #ffffff; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: #ffffff; }
</style>
</head>
<body>
<iframe id="page" title="${escapeHtml(meta.manifest.title || 'Shared page')}" sandbox="${sandbox}" src="/p/${id}/content?r=${encodeURIComponent(meta.revision)}"></iframe>
<script nonce="${nonce}">
(function () {
  var P = 'craft-pages/v1';
  var INIT = ${scriptSafeJson(init)};
  var frame = document.getElementById('page');
  function post(type, payload) {
    if (frame.contentWindow) frame.contentWindow.postMessage({ protocol: P, type: type, payload: payload }, '*');
  }
  // A published copy is view-only: no grants, and every action is declined.
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    var m = event.data;
    if (!m || m.protocol !== P) return;
    if (m.type === 'ready') post('init', INIT);
    else if (m.type === 'grant-request') post('grants', { grants: [] });
    else if (m.type === 'action') post('action-result', { result: { requestId: String(m.requestId || '').slice(0, 128), ok: false, error: 'public-actions-disabled: actions are not available in a shared copy', durationMs: 0 } });
    else if (m.type === 'open-url' && typeof m.url === 'string' && m.url.length < 2048 && /^https?:\\/\\//i.test(m.url)) window.open(m.url, '_blank', 'noopener,noreferrer');
  });
  frame.addEventListener('load', function () { post('init', INIT); });
})();
</script>
</body>
</html>
`;
  return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers: VIEWER_HEADERS(nonce) });
}

/**
 * The page itself. The CSP `sandbox` gives it an opaque origin even when opened directly,
 * and `connect-src 'none'` and friends keep it from reaching the network (pages must be
 * self-contained, as the app's authoring guide says).
 */
async function serveContent(req: Request, id: string, ctx: PagesContext): Promise<Response> {
  const meta = await loadMeta(ctx.store, id);
  if (!meta) return pageGone();
  if (!unlocked(req, meta)) return htmlResponse(401, 'Password needed', 'Open the page from its link to type the password.');
  const content = await ctx.store.get(contentKey(id));
  if (!content) return pageGone();
  const sandbox = meta.manifest.kind === 'static' ? 'sandbox' : 'sandbox allow-scripts allow-forms';
  return new Response(req.method === 'HEAD' ? null : (content as never), {
    status: 200,
    headers: [
      ['content-type', 'text/html; charset=utf-8'],
      ['cache-control', 'private, no-cache'],
      [
        'content-security-policy',
        `${sandbox}; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`,
      ],
      ...RESPONSE_SECURITY_HEADERS,
    ],
  });
}
