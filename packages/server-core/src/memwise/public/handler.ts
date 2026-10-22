/**
 * The core's public handler (23 §4, §6-7): a fetch-style `(Request) → Response` for the routes
 * the relay forwards (forms, inbox links, webhooks, the form app's files). The relay tunnel, a
 * server's direct listener (`MEMWISE_PUBLIC_PORT`) and the tests all call it.
 *
 * Every link is checked by the kernel (`kernel.external`), never here. This layer only shapes
 * requests: tokens are read from the path alone, bodies are JSON (uploads raw bytes) and capped
 * while they stream in, methods are checked, each client address is rate limited as a second line
 * behind the relay and the kernel, and nothing it answers carries a stack trace or a token.
 */
import type { ChannelService, ExternalService, InspectorService, PublicRequestInfo } from '@memwise/runtime'
import { formApp, FORM_ASSETS_PREFIX, type FormApp } from './form-app'
import { BodyTooLarge, IpRateLimiter, MAX_JSON_BYTES, MAX_UPLOAD_BYTES, MAX_WEBHOOK_BYTES, readBody, type IpLimit } from './limits'

/** What the handler needs of the kernel: its Phase 5 services, and Stage 5's inspector links. */
export interface PublicKernel {
  readonly external: ExternalService
  readonly channels: ChannelService
  /** Stage 5 (26 §8): an inspector's read-only view (`/v/<token>`); absent, those links are unknown. */
  readonly inspectors?: InspectorService
}

export interface PublicHandlerLogger {
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface PublicHandlerOptions {
  /** The running kernel, or null while it is starting or stopped (answered with 503). */
  kernel: () => PublicKernel | null
  /** The built form app (`apps/external-form/dist`); without it the pages say the form is unavailable. */
  formAppDir?: string
  log?: PublicHandlerLogger
  /** Requests per client address; default 120 a minute. */
  ipLimit?: IpLimit
  /** Tests: the clock the limiter counts with. */
  now?: () => number
}

/**
 * What the caller knows about the connection. The direct listener passes the socket's address,
 * which then wins over `x-memwise-client-ip` (only the relay may set that header, and through the
 * tunnel there is no socket to read).
 */
export interface PublicConnectionInfo { ip?: string }

export type PublicHandler = (req: Request, conn?: PublicConnectionInfo) => Promise<Response>

/** The strict policy every answer carries (the form app is same-origin scripts and styles only). */
export const PUBLIC_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': PUBLIC_CSP,
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
}

/** A token as it may appear in a path: base64url with the `mwl_` prefix (checked by the kernel). */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/
const HOOK_RE = /^[A-Za-z0-9_-]{4,128}$/
/** `/x/<installId>` before the route, when the relay runs in path mode (an install id is 16 base32 characters). */
const PATH_MODE_PREFIX = /^\/x\/[a-z2-7]{16}(?=\/)/
const MAX_FILE_NAME = 255
/** Entity keys (`etmf.document`) and record ids, as an inspector's page may name them. */
const ENTITY_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const MAX_QUESTION = 4000
const MAX_FILTER = 200
const MAX_DOCUMENTS = 50

const MESSAGES = {
  unknown: 'This link is not valid. Check that you copied all of it, or ask for a new one.',
  unavailable: "This form isn't available right now. Please try again in a little while.",
  rateLimited: 'Too many requests from your connection. Please wait a minute and try again.',
  tooLarge: (limit: number) => `That is too large (the limit is ${Math.round(limit / (1024 * 1024)) || 1} MB).`,
  badJson: 'The request could not be read. Please reload the page and try again.',
  failed: 'Something went wrong. Please try again.',
  notFound: 'Not found.',
  method: 'That is not allowed here.',
  noName: 'The file needs a name.',
  noQuestion: 'Write your question first.',
}

type Json = Record<string, unknown>

function headersFor(extra: Record<string, string>, noStore: boolean): Headers {
  const h = new Headers(SECURITY_HEADERS)
  if (noStore) h.set('cache-control', 'no-store')
  for (const [k, v] of Object.entries(extra)) h.set(k, v)
  return h
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: headersFor({ 'content-type': 'application/json; charset=utf-8', ...extra }, true) })
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

class BadRequest extends Error {}

async function readJson(req: Request): Promise<Json> {
  const bytes = await readBody(req, MAX_JSON_BYTES)
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new BadRequest(MESSAGES.badJson) }
  if (!isObject(parsed)) throw new BadRequest(MESSAGES.badJson)
  return parsed
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return undefined
  if (!isObject(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new BadRequest(MESSAGES.badJson)
  return v as Record<string, string>
}

/** The client's address: the socket's when the caller knows it, else the relay's header. */
export function clientIp(req: Request, conn?: PublicConnectionInfo): string | undefined {
  if (conn?.ip) return conn.ip
  const h = req.headers.get('x-memwise-client-ip')?.trim()
  return h ? h.slice(0, 64) : undefined
}

/** A file name as typed on the phone, without any path, trimmed to a sensible length. */
export function cleanFileName(raw: string | null): string | undefined {
  if (!raw) return undefined
  // eslint-disable-next-line no-control-regex
  const base = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!base || base === '.' || base === '..') return undefined
  return base.length > MAX_FILE_NAME ? base.slice(base.length - MAX_FILE_NAME) : base
}

export function createPublicHandler(opts: PublicHandlerOptions): PublicHandler {
  const app: FormApp = formApp(opts.formAppDir)
  const limiter = new IpRateLimiter(opts.ipLimit ?? { count: 120, perMs: 60_000 }, opts.now)
  const log = opts.log

  const methodNotAllowed = (allow: string) => json({ status: 'error', message: MESSAGES.method }, 405, { allow })
  const notFound = () => new Response(MESSAGES.notFound, { status: 404, headers: headersFor({ 'content-type': 'text/plain; charset=utf-8' }, true) })
  const unavailable = () => json({ status: 'unavailable', message: MESSAGES.unavailable }, 503, { 'retry-after': '30' })

  function shell(req: Request, path: string): Response {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
    // `/f/<token>` is one segment below the base; a trailing slash adds one.
    const depth = path.split('/').length - 2
    const { html } = app.shell(depth)
    return new Response(req.method === 'HEAD' ? null : html, {
      status: 200, headers: headersFor({ 'content-type': 'text/html; charset=utf-8' }, true),
    })
  }

  function asset(req: Request, rest: string): Response {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD')
    const file = app.asset(rest)
    if (!file) return notFound()
    const html = file.mime.startsWith('text/html')
    return new Response(req.method === 'HEAD' ? null : file.data, {
      status: 200,
      headers: headersFor({
        'content-type': file.mime,
        // Built files are content-hashed: keep them a year. A stray HTML file is never cached.
        'cache-control': html ? 'no-store' : 'public, max-age=31536000, immutable',
      }, false),
    })
  }

  async function form(req: Request, token: string, action: string, info: PublicRequestInfo): Promise<Response> {
    const k = opts.kernel()
    if (!k) return unavailable()
    const unknownLink = () => json({ status: 'unknown', message: MESSAGES.unknown })
    switch (action) {
      case 'form':
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        return json(await k.external.form(token, info))
      case 'draft': {
        if (req.method !== 'PUT') return methodNotAllowed('PUT')
        if (!TOKEN_RE.test(token)) return unknownLink() // before any body is read
        const body = await readJson(req)
        if (!isObject(body.values)) throw new BadRequest(MESSAGES.badJson)
        return json(await k.external.saveDraft(token, body.values, info))
      }
      case 'files': {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        if (!TOKEN_RE.test(token)) return unknownLink() // before any body is read
        const name = cleanFileName(new URL(req.url).searchParams.get('name'))
        if (!name) return json({ status: 'invalid', message: MESSAGES.noName }, 400)
        const data = await readBody(req, MAX_UPLOAD_BYTES)
        const mime = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream'
        return json(await k.external.upload(token, { name, mime, data }, info))
      }
      case 'extract': {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        if (!TOKEN_RE.test(token)) return unknownLink() // before any body is read
        const body = await readJson(req)
        const docs = body.documents
        if (!Array.isArray(docs) || docs.length > MAX_DOCUMENTS || docs.some((d) => typeof d !== 'string' || !d)) throw new BadRequest(MESSAGES.badJson)
        return json(await k.external.extract(token, { documents: docs as string[] }, info))
      }
      case 'submit': {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        if (!TOKEN_RE.test(token)) return unknownLink() // before any body is read
        const body = await readJson(req)
        if (!isObject(body.values) || (body.outcome !== undefined && typeof body.outcome !== 'string')) throw new BadRequest(MESSAGES.badJson)
        const sources = stringRecord(body.sources)
        return json(await k.external.submit(token, {
          values: body.values, ...(typeof body.outcome === 'string' ? { outcome: body.outcome } : {}), ...(sources ? { sources } : {}),
        }, info))
      }
    }
    return notFound()
  }

  async function inbox(req: Request, token: string, action: string, info: PublicRequestInfo): Promise<Response> {
    const k = opts.kernel()
    if (!k) return unavailable()
    switch (action) {
      case 'item':
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return json({ status: 'unknown', message: MESSAGES.unknown })
        return json(await k.external.inboxItem(token, info))
      case 'decide': {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        if (!TOKEN_RE.test(token)) return json({ status: 'unknown', message: MESSAGES.unknown }) // before any body is read
        const body = await readJson(req)
        if (typeof body.outcome !== 'string' || !body.outcome || (body.comment !== undefined && typeof body.comment !== 'string')) {
          throw new BadRequest(MESSAGES.badJson)
        }
        return json(await k.external.decideInboxItem(token, {
          outcome: body.outcome, ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
        }, info))
      }
    }
    return notFound()
  }

  /**
   * An inspector's read-only view (Stage 5, 26 §8): filed documents, their signatures and audit
   * trail, downloads, and questions to the study team. The kernel checks the link (unknown,
   * expired, revoked) and logs every view and download; a refusal answers `{ refused }`.
   */
  async function inspector(req: Request, token: string, action: string, info: PublicRequestInfo): Promise<Response> {
    const k = opts.kernel()
    if (!k) return unavailable()
    const unknownLink = () => json({ refused: 'unknown' })
    const insp = k.inspectors
    if (!insp) return unknownLink()
    const q = new URL(req.url).searchParams
    const param = (name: string, re?: RegExp): string | undefined => {
      const v = q.get(name)?.trim()
      if (!v) return undefined
      if (v.length > MAX_FILTER || (re && !re.test(v))) throw new BadRequest(MESSAGES.badJson)
      return v
    }
    const record = (): { entity: string; id: string } => {
      const entity = param('entity', ENTITY_RE)
      const id = param('id', RECORD_ID_RE)
      if (!entity || !id) throw new BadRequest(MESSAGES.badJson)
      return { entity, id }
    }
    const missing = () => json({ status: 'not_found', message: MESSAGES.notFound }, 404)
    switch (action) {
      case 'index':
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        return json(await insp.open(token, info))
      case 'documents': {
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        const zone = param('zone'); const site = param('site'); const text = param('q')
        return json(await insp.documents(token, { ...(zone ? { zone } : {}), ...(site ? { site } : {}), ...(text ? { q: text } : {}) }))
      }
      case 'document': {
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        const r = record()
        const doc = await insp.document(token, r.entity, r.id)
        return doc ? json(doc) : missing()
      }
      case 'trail': {
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        const r = record()
        const trail = await insp.trail(token, r.entity, r.id)
        return trail ? json(trail) : missing()
      }
      case 'download': {
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        const r = record()
        const file = await insp.download(token, r.entity, r.id)
        if (!file) return missing()
        if ('refused' in file) return json(file)
        const name = (cleanFileName(file.name) ?? 'document').replace(/["\\]/g, '_')
        return new Response(file.data as unknown as ConstructorParameters<typeof Response>[0], {
          status: 200,
          headers: headersFor({
            'content-type': file.mime || 'application/octet-stream',
            'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          }, true),
        })
      }
      case 'ask': {
        if (req.method !== 'POST') return methodNotAllowed('POST')
        if (!TOKEN_RE.test(token)) return unknownLink() // before any body is read
        const body = await readJson(req)
        const question = typeof body.question === 'string' ? body.question.trim() : ''
        if (!question) return json({ status: 'invalid', message: MESSAGES.noQuestion }, 400)
        if (question.length > MAX_QUESTION) throw new BadRequest(MESSAGES.tooLarge(MAX_JSON_BYTES))
        const entity = typeof body.entity === 'string' && ENTITY_RE.test(body.entity) ? body.entity : undefined
        const recordId = typeof body.recordId === 'string' && RECORD_ID_RE.test(body.recordId) ? body.recordId : undefined
        return json(await insp.ask(token, { question, ...(entity && recordId ? { entity, recordId } : {}) }))
      }
      case 'requests':
        if (req.method !== 'GET') return methodNotAllowed('GET')
        if (!TOKEN_RE.test(token)) return unknownLink()
        return json(await insp.requests(token))
    }
    return notFound()
  }

  async function webhook(req: Request, hookId: string): Promise<Response> {
    if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed('GET, POST')
    if (!HOOK_RE.test(hookId)) return notFound()
    const k = opts.kernel()
    if (!k) return unavailable()
    const url = new URL(req.url)
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) if (!(key in query)) query[key] = value
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
    const body = req.method === 'POST' ? await readBody(req, MAX_WEBHOOK_BYTES) : new Uint8Array(0)
    const r = await k.channels.receiveWebhook(hookId, { method: req.method, query, headers, body })
    const status = Number.isInteger(r.status) && r.status >= 200 && r.status <= 599 ? r.status : 200
    return new Response(r.body ?? '', {
      status, headers: headersFor({ 'content-type': r.contentType ?? 'text/plain; charset=utf-8' }, true),
    })
  }

  return async function handle(req: Request, conn?: PublicConnectionInfo): Promise<Response> {
    let path: string
    try { path = new URL(req.url).pathname } catch { return notFound() }
    // The tunnel hands over the full public URL; in the relay's path mode that starts with
    // `/x/<installId>` (23 §2). Routes are matched below it.
    path = path.replace(PATH_MODE_PREFIX, '')
    const ip = clientIp(req, conn)
    const isPublicRoute = path.startsWith('/f/') || path.startsWith('/i/') || path.startsWith('/v/') || path.startsWith('/h/') || path.startsWith(FORM_ASSETS_PREFIX)
    if (!isPublicRoute) return notFound()
    // Assets are cheap and fetched in bursts by every page load; everything else is counted.
    if (!path.startsWith(FORM_ASSETS_PREFIX) && !limiter.take(ip ?? 'unknown')) {
      return json({ status: 'rate_limited', message: MESSAGES.rateLimited }, 429, { 'retry-after': '60' })
    }
    const info: PublicRequestInfo = {
      ...(ip ? { ip } : {}),
      ...(req.headers.get('user-agent') ? { userAgent: req.headers.get('user-agent')!.slice(0, 512) } : {}),
    }
    let route = 'other'
    try {
      let m: RegExpExecArray | null
      if (path.startsWith(FORM_ASSETS_PREFIX)) {
        route = 'asset'
        const rest = path.slice(FORM_ASSETS_PREFIX.length)
        return rest ? asset(req, rest) : notFound()
      }
      if ((m = /^\/([fiv])\/([^/]+)\/?$/.exec(path))) {
        route = 'shell'
        return shell(req, path)
      }
      if ((m = /^\/f\/([^/]+)\/api\/([a-z]+)$/.exec(path))) {
        route = `form.${m[2]}`
        return await form(req, m[1]!, m[2]!, info)
      }
      if ((m = /^\/i\/([^/]+)\/api\/([a-z]+)$/.exec(path))) {
        route = `inbox.${m[2]}`
        return await inbox(req, m[1]!, m[2]!, info)
      }
      if ((m = /^\/v\/([^/]+)\/api\/([a-z]+)$/.exec(path))) {
        route = `inspector.${m[2]}`
        return await inspector(req, m[1]!, m[2]!, info)
      }
      if ((m = /^\/h\/([^/]+)$/.exec(path))) {
        route = 'webhook'
        return await webhook(req, m[1]!)
      }
      return notFound()
    } catch (e) {
      if (e instanceof BodyTooLarge) return json({ status: 'invalid', message: MESSAGES.tooLarge(e.limit) }, 413)
      if (e instanceof BadRequest) return json({ status: 'invalid', message: e.message }, 400)
      // The route, never the path: the path holds the token.
      log?.error(`[memwise] public ${route} failed: ${e instanceof Error ? e.message : String(e)}`)
      return json({ status: 'error', message: MESSAGES.failed }, 500)
    }
  }
}
