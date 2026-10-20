// The core's side of the tunnel (23 §2): dial the relay, answer its challenge, turn each
// forwarded request into a web `Request` for the public handler and stream the answer back.
// Reconnects by itself (1 s doubling to 60 s). Uses the global WebSocket (Bun, Node 22).
import {
  CHUNK_BYTES,
  CLOSE_REPLACED,
  LIMITS,
  type CoreToRelay,
  type Headers2,
  type RelayToCore,
  type RelayTunnel,
  type RelayTunnelOptions,
  type RelayTunnelStatus,
} from './protocol.ts';
import { chunkStream, concatBytes, encodeChunks, fromBase64, parseFrame, PING_FRAME, signHello, toBase64 } from './protocol-impl.ts';

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** A connection that stayed up this long resets the backoff. */
const STABLE_AFTER_MS = 30_000;
/** Bytes queued on the socket before sending waits for it to drain. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Request bodies held at once, across requests. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

export interface RelayTunnelTestOptions {
  /** Shorter waits for tests. */
  backoff?: { minMs?: number; maxMs?: number; stableAfterMs?: number };
  pingEveryMs?: number;
}

/** The URL the tunnel dials: `ws(s)://<relay>/connect/<installId>`. */
export function tunnelUrl(relayUrl: string, installId: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/connect/${installId}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

interface Incoming {
  id: string;
  method: string;
  path: string;
  query: string;
  headers: Headers2;
  parts: Uint8Array[];
  size: number;
  abort: AbortController;
  /** Set once the request has been handed to `handle`. */
  started: boolean;
}

export function startRelayTunnel(opts: RelayTunnelOptions & RelayTunnelTestOptions): RelayTunnel {
  const log = opts.log ?? { info() {}, warn() {}, error() {} };
  const minBackoff = opts.backoff?.minMs ?? MIN_BACKOFF_MS;
  const maxBackoff = opts.backoff?.maxMs ?? MAX_BACKOFF_MS;
  const stableAfter = opts.backoff?.stableAfterMs ?? STABLE_AFTER_MS;
  const pingEvery = opts.pingEveryMs ?? LIMITS.pingEveryMs;
  const maxBody = Math.min(opts.maxRequestBodyBytes ?? LIMITS.requestBodyBytes, LIMITS.requestBodyBytes);
  const maxBuffered = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  /** Bytes of request bodies held in memory now, across requests (they are buffered until complete). */
  let buffered = 0;
  const listeners = new Set<(s: RelayTunnelStatus) => void>();
  const url = tunnelUrl(opts.relayUrl, opts.identity.installId);

  let status: RelayTunnelStatus = {
    state: 'connecting',
    relayUrl: opts.relayUrl,
    installId: opts.identity.installId,
    since: new Date().toISOString(),
  };
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = minBackoff;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let welcomedAt = 0;
  let lastHeard = 0;
  let publicUrl = '';
  const requests = new Map<string, Incoming>();

  function setStatus(next: Omit<RelayTunnelStatus, 'since' | 'relayUrl' | 'installId'>) {
    const same = next.state === status.state && next.publicUrl === status.publicUrl && next.error === status.error;
    if (same) return;
    status = { ...next, relayUrl: opts.relayUrl, installId: opts.identity.installId, since: new Date().toISOString() };
    for (const l of listeners) {
      try {
        l(status);
      } catch (err) {
        log.warn('[relay] status listener failed', err);
      }
    }
  }

  function send(socket: WebSocket, frame: CoreToRelay) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  async function drained(socket: WebSocket) {
    while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > HIGH_WATER_BYTES) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  function abortAll(why: string) {
    for (const r of requests.values()) {
      release(r);
      r.abort.abort(new Error(why));
    }
    requests.clear();
  }

  function scheduleRetry(error?: string) {
    stopPing();
    if (closed) return;
    if (welcomedAt && Date.now() - welcomedAt >= stableAfter) backoff = minBackoff;
    welcomedAt = 0;
    const wait = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    setStatus({ state: error ? 'error' : 'connecting', ...(error ? { error } : {}) });
    log.info(`[relay] reconnecting in ${Math.round(wait / 1000)} s${error ? ` (${error})` : ''}`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, wait);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function connect() {
    if (closed) return;
    if (status.state !== 'error') setStatus({ state: 'connecting' });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      scheduleRetry(err instanceof Error ? err.message : String(err));
      return;
    }
    ws = socket;
    let refused: string | undefined;

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      lastHeard = Date.now();
      const text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      const frame = parseFrame<RelayToCore>(text);
      if (frame) {
        onFrame(socket, frame, (why) => (refused = why)).catch((err) => log.error('[relay] could not handle a frame from the relay', err));
      }
    };
    socket.onerror = () => {
      // The close event that follows says what to do.
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      abortAll('the tunnel closed');
      if (closed) return;
      if (event.code === CLOSE_REPLACED) {
        stopPing();
        // Another process with this install's key took over; fighting it would only flap.
        setStatus({ state: 'error', error: 'Another copy of this install connected to the relay, so this one stopped.' });
        log.warn('[relay] replaced by a newer connection of this install; not reconnecting');
        return;
      }
      scheduleRetry(refused ? `the relay refused the connection: ${refused}` : welcomedAt ? undefined : `could not connect to ${opts.relayUrl}`);
    };
  }

  async function onFrame(socket: WebSocket, frame: RelayToCore, onRefused: (why: string) => void) {
    switch (frame.t) {
      case 'challenge': {
        const hello = await signHello(opts.identity, frame.nonce, opts.client ?? 'memwise');
        send(socket, hello);
        return;
      }
      case 'welcome':
        publicUrl = frame.publicUrl.replace(/\/+$/, '');
        welcomedAt = Date.now();
        lastHeard = welcomedAt;
        setStatus({ state: 'connected', publicUrl });
        log.info(`[relay] connected; public address ${publicUrl}`);
        stopPing();
        pingTimer = setInterval(() => {
          if (ws !== socket) return stopPing();
          if (Date.now() - lastHeard > pingEvery * 2.5) {
            // A dead connection may never finish closing, so stop waiting on it now.
            log.warn('[relay] no answer from the relay; reconnecting');
            ws = null;
            abortAll('the tunnel stopped answering');
            try {
              socket.close(4002, 'no pong');
            } catch {
              // already gone
            }
            scheduleRetry();
            return;
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(PING_FRAME);
        }, pingEvery);
        return;
      case 'refused':
        onRefused(frame.reason);
        log.warn(`[relay] refused: ${frame.reason}`);
        return;
      case 'ping':
        send(socket, { t: 'pong' });
        return;
      case 'pong':
        return;
      case 'req': {
        const r: Incoming = {
          id: frame.id,
          method: frame.method,
          path: frame.path,
          query: frame.query,
          headers: Array.isArray(frame.headers) ? frame.headers : [],
          parts: [],
          size: 0,
          abort: new AbortController(),
          started: false,
        };
        requests.set(r.id, r);
        if (frame.body) addPart(socket, r, frame.body);
        if (!frame.more && requests.get(r.id) === r) void run(socket, r);
        return;
      }
      case 'req.body': {
        const r = requests.get(frame.id);
        if (!r || r.started) return;
        if (frame.chunk) addPart(socket, r, frame.chunk);
        if (frame.end && requests.get(r.id) === r) void run(socket, r);
        return;
      }
      case 'cancel': {
        const r = requests.get(frame.id);
        if (r) {
          requests.delete(r.id);
          release(r);
          r.abort.abort(new Error('cancelled by the relay'));
        }
        return;
      }
    }
  }

  function addPart(socket: WebSocket, r: Incoming, chunk: string) {
    const bytes = fromBase64(chunk);
    r.size += bytes.length;
    const refuse = (status: number, text: string) => {
      requests.delete(r.id);
      release(r);
      send(socket, { t: 'res', id: r.id, status, headers: [['content-type', 'text/plain; charset=utf-8']], body: toBase64(new TextEncoder().encode(text)) });
    };
    if (r.size > maxBody) return refuse(413, 'Request body too large');
    if (buffered + bytes.length > maxBuffered) return refuse(503, 'Too busy right now; please try again in a moment');
    r.parts.push(bytes);
    buffered += bytes.length;
  }

  /** Frees what a request's body held. */
  function release(r: Incoming) {
    for (const p of r.parts) buffered -= p.length;
    r.parts = [];
  }

  async function run(socket: WebSocket, r: Incoming) {
    r.started = true;
    if (!r.path.startsWith('/') || r.path.startsWith('//')) {
      requests.delete(r.id);
      send(socket, { t: 'res', id: r.id, status: 400, headers: [['content-type', 'text/plain; charset=utf-8']] });
      return;
    }
    const target = `${publicUrl}${r.path}${r.query ? '?' + r.query : ''}`;
    const hasBody = r.method !== 'GET' && r.method !== 'HEAD';
    let response: Response;
    try {
      const body = hasBody ? new Uint8Array(concatBytes(r.parts)) : undefined;
      release(r);
      const request = new Request(target, { method: r.method, headers: r.headers, body, signal: r.abort.signal });
      response = await opts.handle(request);
    } catch (err) {
      if (r.abort.signal.aborted) return;
      log.error(`[relay] handler failed for ${r.method} ${r.path}`, err);
      response = new Response('The app could not answer this request.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (requests.get(r.id) !== r) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    await respond(socket, r, response);
  }

  async function respond(socket: WebSocket, r: Incoming, response: Response) {
    const headers: Headers2 = [];
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') headers.push([name, value]);
    });
    const live = () => requests.get(r.id) === r && ws === socket;
    const declared = Number(response.headers.get('content-length') ?? NaN);
    try {
      if (!response.body || (declared <= CHUNK_BYTES && r.method !== 'HEAD')) {
        const bytes = response.body ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(0);
        if (bytes.length <= CHUNK_BYTES) {
          if (live()) send(socket, { t: 'res', id: r.id, status: response.status, headers, ...(bytes.length ? { body: toBase64(bytes) } : {}) });
          return;
        }
        const chunks = encodeChunks(bytes);
        if (live()) send(socket, { t: 'res', id: r.id, status: response.status, headers, body: chunks[0], more: true });
        for (let i = 1; i < chunks.length && live(); i++) {
          await drained(socket);
          send(socket, { t: 'res.body', id: r.id, chunk: chunks[i]!, end: i === chunks.length - 1 });
        }
        return;
      }
      if (!live()) return void (await response.body.cancel().catch(() => {}));
      send(socket, { t: 'res', id: r.id, status: response.status, headers, more: true });
      const stream = response.body;
      for await (const chunk of chunkStream(stream)) {
        if (!live()) return;
        await drained(socket);
        send(socket, { t: 'res.body', id: r.id, chunk: toBase64(chunk) });
      }
      if (live()) send(socket, { t: 'res.body', id: r.id, chunk: '', end: true });
    } catch (err) {
      if (live()) {
        log.warn(`[relay] answer for ${r.method} ${r.path} broke off`, err);
        send(socket, { t: 'cancel', id: r.id });
      }
    } finally {
      if (requests.get(r.id) === r) requests.delete(r.id);
    }
  }

  connect();

  return {
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopPing();
      abortAll('the tunnel was closed');
      const socket = ws;
      ws = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          const done = setTimeout(resolve, 1_000);
          socket.addEventListener('close', () => {
            clearTimeout(done);
            resolve();
          });
          socket.close(1000, 'closed');
        });
      }
      setStatus({ state: 'off' });
    },
  };
}
