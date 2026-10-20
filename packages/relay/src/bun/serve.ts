// The self-hosted relay on Bun (23 §2): `bun packages/relay/src/bun/serve.ts --port 8788
// --public-url http://localhost:8788`. Path mode unless `--base-domain` is given; shared pages
// are kept under `--pages-dir` (off without it). One process holds every install's tunnel.
import type { Server, ServerWebSocket } from 'bun';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  handleRelayRequest,
  installPublicUrl,
  InstallHub,
  readLimited,
  type ForwardRequest,
  type Limits,
  type RelayConfig,
  type RelayLog,
  type SocketMeta,
  type TunnelSocket,
} from '../hub.ts';
import { MemoryPageStore, type PageStore } from '../pages.ts';
import { CHUNK_BYTES } from '../protocol.ts';

/** Pages as files under one folder (keys are `pages/<id>/<name>`). */
export class DirectoryPageStore implements PageStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`page key outside the pages folder: ${key}`);
    return full;
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  async put(key: string, data: Uint8Array) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, file);
  }
  async delete(keys: string[]) {
    for (const key of keys) await rm(this.path(key), { force: true });
  }
}

export interface BunRelayOptions {
  port?: number;
  hostname?: string;
  /** The relay's public origin; defaults to `http://localhost:<port>`. */
  publicUrl?: string;
  baseDomain?: string;
  /** Folder for shared pages, or a store (tests use memory). Without either, `/p/` is off. */
  pagesDir?: string;
  pages?: PageStore;
  oauthReturnOrigins?: string[];
  limits?: Partial<Limits>;
  log?: RelayLog;
  /** Behind a proxy you trust: take the client's address from `x-forwarded-for`. */
  trustForwardedFor?: boolean;
}

export interface BunRelay {
  url: string;
  port: number;
  /** The hub for an install (tests look at its state). */
  hub(installId: string): InstallHub | undefined;
  stop(): Promise<void>;
}

interface SocketData {
  installId: string;
  meta: SocketMeta | null;
  wrapper?: TunnelSocket;
}

export function startBunRelay(opts: BunRelayOptions = {}): BunRelay {
  const log = opts.log ?? console;
  const hubs = new Map<string, InstallHub>();
  let config: RelayConfig;

  const hubFor = (installId: string) => {
    let hub = hubs.get(installId);
    if (!hub) {
      hub = new InstallHub(installId, { publicUrl: installPublicUrl(config, installId), limits: opts.limits, log });
      hubs.set(installId, hub);
    }
    return hub;
  };

  const wrap = (ws: ServerWebSocket<SocketData>): TunnelSocket => {
    ws.data.wrapper ??= {
      send: (text) => void ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      getMeta: () => ws.data.meta,
      setMeta: (meta) => void (ws.data.meta = meta),
    };
    return ws.data.wrapper;
  };

  const pages = opts.pages ?? (opts.pagesDir ? new DirectoryPageStore(opts.pagesDir) : undefined);

  const server: Server<SocketData> = Bun.serve<SocketData>({
    port: opts.port ?? 8788,
    hostname: opts.hostname,
    // Bodies are checked against LIMITS by the hub; leave room for the page-share form too.
    maxRequestBodySize: 64 * 1024 * 1024,
    async fetch(req, srv) {
      const forwardedFor = opts.trustForwardedFor ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
      const clientIp = forwardedFor || srv.requestIP(req)?.address || 'unknown';
      return handleRelayRequest(req, {
        config,
        pages,
        log,
        forward: async (installId, fwd) => {
          // Small bodies go over in one frame; larger ones stream.
          const declared = Number(fwd.headers.find(([n]) => n === 'content-length')?.[1] ?? NaN);
          if (fwd.body instanceof ReadableStream && declared <= CHUNK_BYTES) {
            const bytes = await readLimited(fwd.body, CHUNK_BYTES);
            if (bytes) fwd = { ...fwd, body: bytes } satisfies ForwardRequest;
          }
          return hubFor(installId).forward(fwd);
        },
        upgrade: (installId, r) => {
          if (srv.upgrade(r, { data: { installId, meta: null } })) return undefined; // Bun answers the upgrade
          return new Response('WebSocket upgrade failed', { status: 400 });
        },
      }, clientIp);
    },
    websocket: {
      // Cloudflare's limit, so both hosts behave alike.
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 120,
      open(ws) {
        hubFor(ws.data.installId).open(wrap(ws));
      },
      message(ws, message) {
        const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
        void hubFor(ws.data.installId).message(wrap(ws), text);
      },
      close(ws) {
        hubFor(ws.data.installId).closed(wrap(ws));
      },
    },
  });

  const port = server.port ?? opts.port ?? 8788;
  const publicUrl = (opts.publicUrl ?? `http://localhost:${port}`).replace(/\/+$/, '');
  config = {
    publicUrl,
    ...(opts.baseDomain ? { baseDomain: opts.baseDomain } : {}),
    ...(opts.oauthReturnOrigins ? { oauthReturnOrigins: opts.oauthReturnOrigins } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  };

  return {
    url: publicUrl,
    port,
    hub: (installId) => hubs.get(installId),
    async stop() {
      await server.stop(true);
    },
  };
}

export { MemoryPageStore };

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(name + '='));
  return eq?.slice(name.length + 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`MemWise relay (self-hosted)

  bun packages/relay/src/bun/serve.ts [options]

  --port <n>            port to listen on (default 8788)
  --public-url <url>    the relay's public address (default http://localhost:<port>)
  --base-domain <name>  subdomain mode: installs at <id>.<name> (default: path mode, /x/<id>/)
  --pages-dir <dir>     keep shared pages here (default: shared pages off)
  --oauth-return <url>  also send OAuth codes back to this https origin (repeatable)
  --trust-forwarded-for take the client address from x-forwarded-for (behind a proxy)`);
    process.exit(0);
  }
  const oauthReturnOrigins = args.flatMap((a, i) => (a === '--oauth-return' && args[i + 1] ? [args[i + 1]!] : []));
  const relay = startBunRelay({
    port: Number(argValue(args, '--port') ?? 8788),
    publicUrl: argValue(args, '--public-url'),
    baseDomain: argValue(args, '--base-domain'),
    pagesDir: argValue(args, '--pages-dir'),
    oauthReturnOrigins,
    trustForwardedFor: args.includes('--trust-forwarded-for'),
  });
  console.log(`[relay] listening on port ${relay.port}; public address ${relay.url}`);
}
