// The relay on Cloudflare (23 §2, option 1b of the Cloudflare review): the Worker answers
// what the relay answers itself (health, OAuth callback, shared pages on R2) and hands the
// tunnel and forwarded requests to the `InstallTunnel` Durable Object of that install
// (`idFromName(installId)`). The object holds the core's WebSocket with the hibernation API,
// so an idle tunnel costs nothing and pings are answered without waking it; requests in
// flight live in its memory while it is awake. The logic is the shared hub; this is glue.
import {
  decodeForwardRequest,
  encodeForwardRequest,
  handleRelayRequest,
  installPublicUrl,
  InstallHub,
  type RelayConfig,
  type SocketMeta,
  type TunnelSocket,
} from '../hub.ts';
import type { PageStore } from '../pages.ts';
import { isInstallId, PING_FRAME, PONG_FRAME } from '../protocol-impl.ts';

// ---- the few Workers types used here (kept local so the package needs no Workers typings) ----

interface CfWebSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface DurableObjectState {
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

declare const WebSocketPair: { new (): { 0: CfWebSocket; 1: CfWebSocket } };
declare const WebSocketRequestResponsePair: { new (request: string, response: string): unknown };

export interface Env {
  INSTALL_TUNNEL: DurableObjectNamespace;
  /** Shared pages; without the binding `/p/` is off. */
  PAGES?: R2Bucket;
  /** The relay's public origin, `https://relay.memwise.ai`. */
  PUBLIC_URL: string;
  /** Subdomain mode: installs at `<id>.<BASE_DOMAIN>`. Empty for path mode. */
  BASE_DOMAIN?: string;
  /** Comma-separated https origins an OAuth `returnTo` may also name. */
  OAUTH_RETURN_ORIGINS?: string;
  /** Test hook: a JSON object of LIMITS overrides. */
  LIMITS_JSON?: string;
}

function configOf(env: Env): RelayConfig {
  const origins = (env.OAUTH_RETURN_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    ...(env.BASE_DOMAIN ? { baseDomain: env.BASE_DOMAIN } : {}),
    ...(origins.length ? { oauthReturnOrigins: origins } : {}),
    ...(env.LIMITS_JSON ? { limits: JSON.parse(env.LIMITS_JSON) as RelayConfig['limits'] } : {}),
  };
}

export class R2PageStore implements PageStore {
  constructor(private readonly bucket: R2Bucket) {}
  async get(key: string) {
    const object = await this.bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  async put(key: string, data: Uint8Array) {
    await this.bucket.put(key, data);
  }
  async delete(keys: string[]) {
    await this.bucket.delete(keys);
  }
}

const stubFor = (env: Env, installId: string) => env.INSTALL_TUNNEL.get(env.INSTALL_TUNNEL.idFromName(installId));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const config = configOf(env);
    const clientIp = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const res = await handleRelayRequest(
      req,
      {
        config,
        pages: env.PAGES ? new R2PageStore(env.PAGES) : undefined,
        forward: (installId, fwd) => stubFor(env, installId).fetch(encodeForwardRequest(installId, fwd)),
        upgrade: (installId, r) => stubFor(env, installId).fetch(r),
      },
      clientIp,
    );
    return res ?? new Response('Not found', { status: 404 });
  },
};

/** One install's tunnel: a thin adapter from the hibernation API to the shared InstallHub. */
export class InstallTunnel {
  private hub: InstallHub | null = null;
  private readonly sockets = new WeakMap<CfWebSocket, TunnelSocket>();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    // Answered by the runtime itself, so a hibernated object doesn't wake for pings.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  private wrap(ws: CfWebSocket): TunnelSocket {
    let socket = this.sockets.get(ws);
    if (!socket) {
      socket = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        getMeta: () => (ws.deserializeAttachment() as SocketMeta | null) ?? null,
        setMeta: (meta) => ws.serializeAttachment(meta),
      };
      this.sockets.set(ws, socket);
    }
    return socket;
  }

  /** The hub, rebuilt after hibernation from the sockets the runtime kept. */
  private hubFor(installId: string): InstallHub {
    if (!this.hub) {
      const config = configOf(this.env);
      this.hub = new InstallHub(installId, { publicUrl: installPublicUrl(config, installId), limits: config.limits });
      this.hub.restore(this.state.getWebSockets().map((ws) => this.wrap(ws)));
    }
    return this.hub;
  }

  async fetch(req: Request): Promise<Response> {
    const connect = /^\/connect\/([^/]+)$/.exec(new URL(req.url).pathname);
    if (connect && isInstallId(connect[1]!) && (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      this.hubFor(connect[1]!).open(this.wrap(server));
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    const decoded = decodeForwardRequest(req);
    if (decoded) return this.hubFor(decoded.installId).forward(decoded.forward);
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    await this.hubFor(meta.installId).message(this.wrap(ws), text);
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    this.socketGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    this.socketGone(ws);
  }

  private socketGone(ws: CfWebSocket) {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (meta) this.hubFor(meta.installId).closed(this.wrap(ws));
  }
}
