// The relay's logic, shared by the Cloudflare Worker and the Bun host (23 §2). Runtime-free:
// it sees sockets through `TunnelSocket` and requests as web `Request`/`Response`, and keeps
// nothing but in-memory state (the open tunnel, requests in flight, rate counters).
import {
  CLOSE_REFUSED,
  CLOSE_REPLACED,
  CHUNK_BYTES,
  FORWARDED_PREFIXES,
  LIMITS,
  type CoreToRelay,
  type Headers2,
  type RelayToCore,
} from './protocol.ts';
import {
  BodyTooLargeError,
  chunkStream,
  concatBytes,
  encodeChunks,
  fromBase64,
  fromBase64Url,
  isInstallId,
  parseFrame,
  PONG_FRAME,
  randomBytes,
  toBase64,
  toBase64Url,
  verifyHello,
} from './protocol-impl.ts';
import { htmlResponse, jsonResponse, refusal, RESPONSE_SECURITY_HEADERS } from './http.ts';
import { handleOAuthCallback } from './oauth.ts';
import { RateLimiter } from './rate-limit.ts';
import { handlePagesRequest, type PageStore } from './pages.ts';

export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

export interface RelayConfig {
  /** The relay's own public origin: `https://relay.memwise.ai`, `http://localhost:8788`. */
  publicUrl: string;
  /** Subdomain mode: install `<id>` is reached at `<id>.<baseDomain>`. Without it, path mode (`/x/<id>/…`). */
  baseDomain?: string;
  /** Extra origins an OAuth `returnTo` may name besides loopback and the app's schemes (a web UI's own address). */
  oauthReturnOrigins?: string[];
  limits?: Partial<Limits>;
}

export interface RelayLog {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export const silentLog: RelayLog = { info() {}, warn() {}, error() {} };

export const limitsOf = (config: { limits?: Partial<Limits> }): Limits => ({ ...LIMITS, ...config.limits });

// ---- routes ----

export type RelayRoute =
  | { kind: 'health' }
  | { kind: 'connect'; installId: string }
  | { kind: 'forward'; installId: string; path: string; query: string }
  | { kind: 'oauth-callback' }
  | { kind: 'pages'; path: string }
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed'; allow: string };

/** Methods each forwarded prefix takes (§4: forms and inbox links also `PUT` their draft). */
const FORWARDED_METHODS: Record<(typeof FORWARDED_PREFIXES)[number], string[]> = {
  '/f/': ['GET', 'HEAD', 'POST', 'PUT'],
  '/i/': ['GET', 'HEAD', 'POST', 'PUT'],
  '/h/': ['GET', 'POST'],
  '/assets/': ['GET', 'HEAD'],
};

const hostnameOf = (host: string) => host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/** The install a `Host` names in subdomain mode, `null` for the relay's own host, `undefined` for neither. */
function installOfHost(host: string, baseDomain: string): string | null | undefined {
  const name = hostnameOf(host);
  const base = baseDomain.toLowerCase();
  if (name === base) return null;
  if (!name.endsWith('.' + base)) return null; // another name for the relay (an IP, a second domain)
  const label = name.slice(0, -(base.length + 1));
  return isInstallId(label) ? label : undefined;
}

function forwardRoute(method: string, installId: string, path: string, query: string): RelayRoute {
  const prefix = FORWARDED_PREFIXES.find((p) => path.startsWith(p) && path.length > p.length);
  if (!prefix) return { kind: 'not-found' };
  const methods = FORWARDED_METHODS[prefix];
  if (!methods.includes(method)) return { kind: 'method-not-allowed', allow: methods.join(', ') };
  return { kind: 'forward', installId, path, query };
}

/**
 * What a request is for. Only paths under FORWARDED_PREFIXES ever reach a core; on an
 * install's own host (subdomain mode) nothing but those, `/connect` and `/health` answer.
 */
export function classifyRoute(method: string, url: URL, host: string, config: RelayConfig): RelayRoute {
  const path = url.pathname;
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (path === '/health') return { kind: 'health' };
  const connect = /^\/connect\/([^/]+)$/.exec(path);
  if (connect) return isInstallId(connect[1]!) ? { kind: 'connect', installId: connect[1]! } : { kind: 'not-found' };

  if (config.baseDomain) {
    const installId = installOfHost(host, config.baseDomain);
    if (installId === undefined) return { kind: 'not-found' };
    if (installId) return forwardRoute(method, installId, path, query);
  } else {
    const x = /^\/x\/([^/]+)(\/.*)$/.exec(path);
    if (x) return isInstallId(x[1]!) ? forwardRoute(method, x[1]!, x[2]!, query) : { kind: 'not-found' };
  }

  if (path === '/auth/callback') return method === 'GET' ? { kind: 'oauth-callback' } : { kind: 'method-not-allowed', allow: 'GET' };
  if (path === '/p' || path.startsWith('/p/')) return { kind: 'pages', path };
  return { kind: 'not-found' };
}

/** An install's public base URL, told to its core in `welcome`. */
export function installPublicUrl(config: RelayConfig, installId: string): string {
  const base = new URL(config.publicUrl);
  if (config.baseDomain) {
    return `${base.protocol}//${installId}.${config.baseDomain}${base.port ? ':' + base.port : ''}`;
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/x/${installId}`;
}

// ---- headers ----

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function connectionListed(headers: Headers): Set<string> {
  const listed = new Set<string>();
  for (const name of (headers.get('connection') ?? '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n) listed.add(n);
  }
  return listed;
}

/**
 * Headers forwarded to a core: no hop-by-hop headers, cookies, `cf-*` or forwarding headers
 * the client sent (the relay sets its own), and no `accept-encoding` (bodies cross the tunnel
 * as they are; the host compresses if it wants).
 */
export function filterRequestHeaders(
  headers: Headers,
  set: { clientIp: string; forwardedHost: string; forwardedProto: string },
): Headers2 {
  const listed = connectionListed(headers);
  const out: Headers2 = [];
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name)) return;
    if (name === 'cookie' || name === 'accept-encoding' || name === 'forwarded' || name === 'x-real-ip') return;
    if (name.startsWith('cf-') || name.startsWith('x-forwarded-') || name.startsWith('x-memwise-')) return;
    if (name.startsWith('sec-websocket-')) return;
    out.push([name, value]);
  });
  out.push(['x-memwise-client-ip', set.clientIp]);
  out.push(['x-forwarded-host', set.forwardedHost]);
  out.push(['x-forwarded-proto', set.forwardedProto]);
  return out;
}

/** A core's response headers as the client gets them: no hop-by-hop headers, no `set-cookie`. */
export function filterResponseHeaders(headers: Headers2): Headers {
  const out = new Headers();
  const listed = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'connection') for (const n of value.split(',')) listed.add(n.trim().toLowerCase());
  }
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name) || listed.has(name) || name === 'set-cookie' || name === 'content-length') continue;
    try {
      out.append(name, value);
    } catch {
      // A header the runtime refuses (bad characters) is dropped, not fatal.
    }
  }
  for (const [name, value] of RESPONSE_SECURITY_HEADERS) out.set(name, value);
  return out;
}

export const OFFLINE_MESSAGE = "The business's MemWise app is offline; please try again later.";

/** What the relay answers when no core is connected for the install (503). */
export function offlineResponse(path = '/f/', method = 'GET'): Response {
  const title = path.startsWith('/f/') ? "This form isn't available right now." : "This page isn't available right now.";
  return refusal(path, method, 503, 'offline', title, OFFLINE_MESSAGE, [['retry-after', '60']]);
}

export const notFoundResponse = () => htmlResponse(404, 'Not found', 'There is nothing at this address.');

// ---- the tunnel for one install ----

/** One WebSocket from a core, as a host sees it. `meta` survives hibernation on Cloudflare. */
export interface TunnelSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  getMeta(): SocketMeta | null;
  setMeta(meta: SocketMeta): void;
}

export interface SocketMeta {
  installId: string;
  nonce: string;
  state: 'challenged' | 'open' | 'closed';
  openedAt: number;
  client?: string;
}

/** A request on its way to a core: the route, filtered headers and the body. */
export interface ForwardRequest {
  method: string;
  path: string;
  query: string;
  headers: Headers2;
  body: ReadableStream<Uint8Array> | Uint8Array | null;
  clientIp: string;
  signal?: AbortSignal;
}

interface InFlight {
  id: string;
  socket: TunnelSocket;
  path: string;
  method: string;
  /** Set until the core's `res` arrives. */
  head?: (res: Response) => void;
  body?: ReadableStreamDefaultController<Uint8Array>;
  received: number;
  timer: ReturnType<typeof setTimeout>;
  finish: () => void;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export interface InstallHubOptions {
  /** The install's public base URL (`installPublicUrl`). */
  publicUrl: string;
  limits?: Partial<Limits>;
  now?: () => number;
  log?: RelayLog;
  /** Seconds a new socket has to answer the challenge. */
  helloTimeoutMs?: number;
}

/**
 * The relay side of one install's tunnel: the challenge and `hello`, the current connection
 * (a newer one replaces it), and the requests forwarded over it.
 */
export class InstallHub {
  private current: TunnelSocket | null = null;
  private inflight = new Map<string, InFlight>();
  /** Requests still reading their small body before they are sent on (they count toward the cap). */
  private reading = 0;
  private seq = 0;
  private readonly limits: Limits;
  private readonly log: RelayLog;
  private readonly now: () => number;
  private readonly perIp: RateLimiter;

  constructor(readonly installId: string, private readonly opts: InstallHubOptions) {
    this.limits = limitsOf(opts);
    this.log = opts.log ?? silentLog;
    this.now = opts.now ?? Date.now;
    this.perIp = new RateLimiter(this.limits.requestsPerMinutePerIp, 60_000, this.now);
  }

  get connected(): boolean {
    return this.current !== null;
  }

  get inFlightCount(): number {
    return this.inflight.size;
  }

  /** A new socket on `/connect/<installId>`: challenge it. */
  open(socket: TunnelSocket): void {
    const nonce = toBase64Url(randomBytes(32));
    socket.setMeta({ installId: this.installId, nonce, state: 'challenged', openedAt: this.now() });
    this.send(socket, { t: 'challenge', nonce });
    const wait = this.opts.helloTimeoutMs ?? 15_000;
    if (wait > 0) {
      setTimeout(() => {
        if (socket.getMeta()?.state === 'challenged') this.refuse(socket, 'no hello in time');
      }, wait);
    }
  }

  /** Sockets that were open before the host forgot its state (Cloudflare hibernation). */
  restore(sockets: TunnelSocket[]): void {
    let newest: { socket: TunnelSocket; at: number } | null = null;
    for (const socket of sockets) {
      const meta = socket.getMeta();
      if (meta?.state === 'open' && (!newest || meta.openedAt >= newest.at)) newest = { socket, at: meta.openedAt };
    }
    if (newest) this.current = newest.socket;
  }

  async message(socket: TunnelSocket, text: string): Promise<void> {
    const frame = parseFrame<CoreToRelay>(text);
    const meta = socket.getMeta();
    if (!frame || !meta || meta.state === 'closed') return;
    if (meta.state === 'challenged') {
      if (frame.t !== 'hello') return this.refuse(socket, 'expected hello');
      const why = await verifyHello(frame, meta.nonce, this.installId);
      if (why) return this.refuse(socket, why);
      if (socket.getMeta()?.state !== 'challenged') return; // closed while checking
      const openedAt = this.now();
      socket.setMeta({ ...meta, state: 'open', openedAt, client: String(frame.client ?? '').slice(0, 100) });
      const previous = this.current;
      this.current = socket;
      if (previous && previous !== socket) {
        this.dropSocket(previous, 'replaced by a newer connection');
        try {
          previous.close(CLOSE_REPLACED, 'replaced by a newer connection');
        } catch {
          // already closed
        }
      }
      this.send(socket, { t: 'welcome', installId: this.installId, publicUrl: this.opts.publicUrl });
      this.log.info(`[relay] ${this.installId} connected (${frame.client ?? 'unknown client'})`);
      return;
    }
    try {
      switch (frame.t) {
        case 'ping':
          socket.send(PONG_FRAME);
          return;
        case 'pong':
        case 'hello':
          return;
        case 'res':
          return this.onRes(socket, frame);
        case 'res.body':
          return this.onResBody(socket, frame);
        case 'cancel': {
          const f = this.inflight.get(frame.id);
          if (f && f.socket === socket) this.fail(f, 502, 'The app could not answer this request.');
          return;
        }
      }
    } catch (err) {
      // A frame the relay can't use (bad base64, odd shapes) ends that request, not the relay.
      const id = (frame as { id?: unknown }).id;
      const f = typeof id === 'string' ? this.inflight.get(id) : undefined;
      if (f && f.socket === socket) this.fail(f, 502, 'The app sent an answer the relay cannot pass on.');
      this.log.warn(`[relay] bad frame from ${this.installId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The host saw the socket close. */
  closed(socket: TunnelSocket): void {
    this.markClosed(socket);
    if (this.current === socket) {
      this.current = null;
      this.log.info(`[relay] ${this.installId} disconnected`);
    }
    this.dropSocket(socket, 'the app disconnected');
  }

  /** Forwards a request over the current tunnel and resolves with the core's answer. */
  async forward(req: ForwardRequest): Promise<Response> {
    if (!this.current) return offlineResponse(req.path, req.method);

    const wait = this.perIp.take(req.clientIp);
    if (wait) {
      return refusal(req.path, req.method, 429, 'rate_limited', 'Too many requests', 'Please wait a minute and try again.', [['retry-after', String(wait)]]);
    }
    // Requests whose small body is still being read count too, so slow senders can't pile up past the cap.
    if (this.inflight.size + this.reading >= this.limits.concurrentPerInstall) {
      return refusal(req.path, req.method, 429, 'busy', 'Too many requests', 'The app is busy; please try again in a moment.', [['retry-after', '1']]);
    }
    const declared = Number(req.headers.find(([n]) => n === 'content-length')?.[1] ?? NaN);
    const tooLarge = () => refusal(req.path, req.method, 413, 'too_large', 'Too large', 'What you sent is too large.');
    if (declared > this.limits.requestBodyBytes) return tooLarge();
    // A small body goes over in the `req` frame itself; a larger one streams.
    let inlineBody = req.body instanceof Uint8Array ? req.body : null;
    if (req.body instanceof ReadableStream && declared <= CHUNK_BYTES) {
      this.reading++;
      try {
        inlineBody = await readLimited(req.body, CHUNK_BYTES);
      } finally {
        this.reading--;
      }
      if (!inlineBody) return tooLarge();
      req = { ...req, body: inlineBody };
    }
    if (inlineBody && inlineBody.length > this.limits.requestBodyBytes) return tooLarge();
    const socket = this.current; // again: reading the body took time
    if (!socket) return offlineResponse(req.path, req.method);

    const id = `${(++this.seq).toString(36)}.${toBase64Url(randomBytes(6))}`;
    return new Promise<Response>((resolve) => {
      const onAbort = () => {
        const f = this.inflight.get(id);
        if (!f) return;
        this.send(f.socket, { t: 'cancel', id });
        this.fail(f, 499, 'The request was cancelled.');
      };
      const flight: InFlight = {
        id,
        socket,
        path: req.path,
        method: req.method,
        head: resolve,
        received: 0,
        timer: setTimeout(() => {
          const f = this.inflight.get(id);
          if (!f) return;
          this.send(f.socket, { t: 'cancel', id });
          this.fail(f, 504, 'The app took too long to answer.');
        }, this.limits.requestTimeoutMs),
        finish: () => req.signal?.removeEventListener('abort', onAbort),
      };
      this.inflight.set(id, flight);
      if (req.signal?.aborted) return onAbort();
      req.signal?.addEventListener('abort', onAbort);

      const base = { t: 'req' as const, id, method: req.method, path: req.path, query: req.query, headers: req.headers };
      if (!req.body || (inlineBody && inlineBody.length === 0)) {
        this.send(socket, base);
      } else if (inlineBody) {
        const chunks = encodeChunks(inlineBody);
        this.send(socket, { ...base, body: chunks[0], more: chunks.length > 1 });
        chunks.slice(1).forEach((chunk, i) => this.send(socket, { t: 'req.body', id, chunk, end: i === chunks.length - 2 }));
      } else {
        this.send(socket, { ...base, more: true });
        void this.pumpRequestBody(flight, req.body as ReadableStream<Uint8Array>);
      }
    });
  }

  private async pumpRequestBody(flight: InFlight, body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of chunkStream(body, { limit: this.limits.requestBodyBytes })) {
        if (this.inflight.get(flight.id) !== flight) return;
        this.send(flight.socket, { t: 'req.body', id: flight.id, chunk: toBase64(chunk) });
      }
      if (this.inflight.get(flight.id) === flight) this.send(flight.socket, { t: 'req.body', id: flight.id, chunk: '', end: true });
    } catch (err) {
      if (this.inflight.get(flight.id) !== flight) return;
      this.send(flight.socket, { t: 'cancel', id: flight.id });
      if (err instanceof BodyTooLargeError) this.fail(flight, 413, 'What you sent is too large.', 'too_large');
      else this.fail(flight, 400, 'The request could not be read.', 'bad_request');
    }
  }

  private onRes(socket: TunnelSocket, frame: Extract<CoreToRelay, { t: 'res' }>): void {
    const f = this.inflight.get(frame.id);
    if (!f || f.socket !== socket || !f.head) return;
    const status = Number(frame.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) return this.fail(f, 502, 'The app sent an answer the relay cannot pass on.');
    const pairs = (Array.isArray(frame.headers) ? frame.headers : []).filter(
      (h): h is [string, string] => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'string',
    );
    const headers = filterResponseHeaders(pairs);
    const declared = Number(pairs.find(([n]) => n.toLowerCase() === 'content-length')?.[1] ?? NaN);
    if (declared > this.limits.responseBodyBytes) {
      this.send(socket, { t: 'cancel', id: f.id });
      return this.fail(f, 502, 'The answer from the app is too large.');
    }
    const head = f.head;
    f.head = undefined;

    const first = frame.body ? fromBase64(frame.body) : new Uint8Array(0);
    if (!frame.more) {
      this.finish(f);
      head(new Response(NULL_BODY_STATUS.has(status) || f.method === 'HEAD' ? null : (first as never), { status, headers }));
      return;
    }
    f.received = first.length;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        f.body = controller;
        if (first.length) controller.enqueue(first);
      },
      cancel: () => {
        // The client went away while the body was streaming.
        if (this.inflight.get(f.id) !== f) return;
        this.send(f.socket, { t: 'cancel', id: f.id });
        this.finish(f);
      },
    });
    head(new Response(NULL_BODY_STATUS.has(status) ? null : stream, { status, headers }));
  }

  private onResBody(socket: TunnelSocket, frame: Extract<CoreToRelay, { t: 'res.body' }>): void {
    const f = this.inflight.get(frame.id);
    if (!f || f.socket !== socket || !f.body) return;
    const bytes = frame.chunk ? fromBase64(frame.chunk) : new Uint8Array(0);
    f.received += bytes.length;
    if (f.received > this.limits.responseBodyBytes) {
      this.send(socket, { t: 'cancel', id: f.id });
      return this.fail(f, 502, 'The answer from the app is too large.');
    }
    try {
      if (bytes.length) f.body.enqueue(bytes);
      if (frame.end) {
        f.body.close();
        this.finish(f);
      }
    } catch {
      this.finish(f);
    }
  }

  /** Ends a request with a refusal, or breaks its body if the answer had started. */
  private fail(f: InFlight, status: number, message: string, code = status === 504 ? 'timeout' : 'upstream'): void {
    this.finish(f);
    if (f.head) {
      const title = status === 504 ? 'This is taking too long' : "This isn't available right now";
      f.head(refusal(f.path, f.method, status, code, title, message));
      f.head = undefined;
    } else if (f.body) {
      try {
        f.body.error(new Error(message));
      } catch {
        // already closed
      }
    }
  }

  private finish(f: InFlight): void {
    clearTimeout(f.timer);
    f.finish();
    if (this.inflight.get(f.id) === f) this.inflight.delete(f.id);
  }

  private dropSocket(socket: TunnelSocket, why: string): void {
    for (const f of [...this.inflight.values()]) if (f.socket === socket) this.fail(f, 502, `The request did not finish: ${why}.`);
  }

  private refuse(socket: TunnelSocket, reason: string): void {
    this.log.warn(`[relay] refused a connection for ${this.installId}: ${reason}`);
    this.send(socket, { t: 'refused', reason });
    this.markClosed(socket);
    try {
      socket.close(CLOSE_REFUSED, reason.slice(0, 120));
    } catch {
      // already closed
    }
  }

  private markClosed(socket: TunnelSocket): void {
    const meta = socket.getMeta();
    if (!meta || meta.state === 'closed') return;
    try {
      socket.setMeta({ ...meta, state: 'closed', nonce: '' });
    } catch {
      // a socket that is gone already keeps no state
    }
  }

  private send(socket: TunnelSocket, frame: RelayToCore): void {
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      this.log.warn(`[relay] send to ${this.installId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---- the request entry point ----

/** What a host gives the shared request handler. */
export interface RelayHost {
  config: RelayConfig;
  pages?: PageStore;
  log?: RelayLog;
  /** Forwards to the install's tunnel (the Bun host's hub, the Worker's Durable Object). */
  forward(installId: string, req: ForwardRequest): Promise<Response>;
  /** Accepts the tunnel's WebSocket upgrade (`undefined` when the host answers it itself, as Bun does). */
  upgrade(installId: string, req: Request): Response | undefined | Promise<Response | undefined>;
}

/** Turns a public request for a core into what the tunnel carries. */
export function toForwardRequest(
  req: Request,
  route: Extract<RelayRoute, { kind: 'forward' }>,
  config: RelayConfig,
  clientIp: string,
): ForwardRequest {
  const publicUrl = new URL(installPublicUrl(config, route.installId));
  return {
    method: req.method,
    path: route.path,
    query: route.query,
    headers: filterRequestHeaders(req.headers, {
      clientIp,
      forwardedHost: publicUrl.host,
      forwardedProto: publicUrl.protocol.replace(':', ''),
    }),
    body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
    clientIp,
    signal: req.signal,
  };
}

/** Answers one HTTP request to the relay. */
export async function handleRelayRequest(req: Request, host: RelayHost, clientIp: string): Promise<Response | undefined> {
  const url = new URL(req.url);
  const hostHeader = req.headers.get('host') ?? url.host;
  const route = classifyRoute(req.method, url, hostHeader, host.config);
  switch (route.kind) {
    case 'health':
      return jsonResponse(200, { ok: true, service: 'memwise-relay' });
    case 'connect':
      if ((req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
        return jsonResponse(426, { error: 'upgrade_required', message: 'The tunnel is a WebSocket.' }, [['upgrade', 'websocket']]);
      }
      return host.upgrade(route.installId, req);
    case 'forward':
      return host.forward(route.installId, toForwardRequest(req, route, host.config, clientIp));
    case 'oauth-callback':
      return handleOAuthCallback(url, host.config);
    case 'pages':
      if (!host.pages) return notFoundResponse();
      return handlePagesRequest(req, route.path, { store: host.pages, config: host.config, clientIp, log: host.log });
    case 'method-not-allowed':
      return new Response('Method not allowed', { status: 405, headers: [['allow', route.allow], ...RESPONSE_SECURITY_HEADERS] });
    case 'not-found':
      return notFoundResponse();
  }
}

// ---- forwarding a request between the Worker and its Durable Object ----

const FORWARD_HEADER = 'x-memwise-relay-forward';

/** Packs a ForwardRequest for an install into a Request for its Durable Object. */
export function encodeForwardRequest(installId: string, req: ForwardRequest, origin = 'https://install.internal'): Request {
  const head = { installId, method: req.method, path: req.path, query: req.query, headers: req.headers, clientIp: req.clientIp };
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'POST',
    headers: { [FORWARD_HEADER]: toBase64Url(new TextEncoder().encode(JSON.stringify(head))) },
    body: req.body as never,
    signal: req.signal,
  };
  // Streaming request bodies need `duplex` in Node and Bun; Workers ignore it.
  if (req.body instanceof ReadableStream) init.duplex = 'half';
  return new Request(`${origin}/__forward`, init);
}

/** The install and ForwardRequest a Durable Object received, or null when the request is not one. */
export function decodeForwardRequest(req: Request): { installId: string; forward: ForwardRequest } | null {
  const packed = req.headers.get(FORWARD_HEADER);
  if (!packed) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(fromBase64Url(packed))) as Omit<ForwardRequest, 'body' | 'signal'> & { installId: string };
    if (!isInstallId(head.installId) || typeof head.path !== 'string' || !Array.isArray(head.headers)) return null;
    const { installId, ...rest } = head;
    return {
      installId,
      forward: { ...rest, body: head.method === 'GET' || head.method === 'HEAD' ? null : req.body, signal: req.signal },
    };
  } catch {
    return null;
  }
}

/** Reads a whole body up to `limit` bytes (null when over). */
export async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  try {
    for await (const chunk of chunkStream(body, { limit, size: CHUNK_BYTES })) parts.push(chunk);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return null;
    throw err;
  }
  return concatBytes(parts);
}
