// How a plugin tool's code is reached (06 §6, 22 §2): an MCP server the plugin declares (stdio
// or HTTP, one lazily opened connection per server), or a subprocess per call. Builtins are
// looked up by the caller (tools.ts). Every route runs behind the tool gateway.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { DiscoveredTool, McpServerDef, McpToolAnnotationsDef } from '@memwise/defs';
import { spawn, spawnSync } from 'node:child_process';

/** The folder a Claude plugin's `.mcp.json` names as `${CLAUDE_PLUGIN_ROOT}`. */
const PLUGIN_ROOT_VAR = /\$\{CLAUDE_PLUGIN_ROOT\}/g;

const substitute = (s: string, root: string) => s.replace(PLUGIN_ROOT_VAR, root);

let nodeOnPath: boolean | undefined;
/** Whether `node` runs from PATH here (the desktop app may only have Electron's). */
function hasNode(): boolean {
  if (nodeOnPath === undefined) {
    try { nodeOnPath = spawnSync('node', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0; } catch { nodeOnPath = false; }
  }
  return nodeOnPath;
}

/**
 * A command to spawn: `${CLAUDE_PLUGIN_ROOT}` replaced by the installed folder, and `node`
 * (absent from PATH) replaced by this process's own runtime acting as Node.
 */
export function resolveCommand(command: string, args: string[], env: Record<string, string>, root: string): { command: string; args: string[]; env: Record<string, string> } {
  let cmd = substitute(command, root);
  const outEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, substitute(v, root)]));
  if (cmd === 'node' && !hasNode()) {
    cmd = process.execPath;
    outEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  return { command: cmd, args: args.map((a) => substitute(a, root)), env: outEnv };
}

export type { DiscoveredTool };

type Concrete = Exclude<McpServerDef, { source: string }>;

async function connect(def: Concrete, root: string, name: string): Promise<Client> {
  // Loaded on first use: the CLI and kernels without MCP plugins never pay for the SDK.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client({ name: 'memwise', version: '1.0.0' });
  if ('url' in def) {
    const headers = Object.fromEntries(Object.entries(def.headers ?? {}).map(([k, v]) => [k, substitute(v, root)]));
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    await client.connect(new StreamableHTTPClientTransport(new URL(substitute(def.url, root)), { requestInit: { headers } }));
    return client;
  }
  const r = resolveCommand(def.command, def.args ?? [], def.env ?? {}, root);
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: r.command, args: r.args, env: r.env, cwd: def.cwd ? substitute(def.cwd, root) : root, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw new Error(`could not start the MCP server ${name} (${r.command}): ${(e as Error).message}${stderr.trim() ? `; it said: ${stderr.trim()}` : ''}`);
  }
  return client;
}

/** Lists a server's tools once (install-time discovery), then closes the connection. */
export async function discoverMcpTools(def: McpServerDef, root: string, name: string, resolveSource?: (slug: string) => Promise<McpServerDef | undefined>): Promise<DiscoveredTool[]> {
  const concrete = await concreteServer(def, resolveSource);
  const client = await connect(concrete, root, name);
  try {
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({
          name: t.name, ...(t.description ? { description: t.description } : {}),
          inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          ...(t.outputSchema ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
          ...(t.annotations ? { annotations: pickAnnotations(t.annotations as Record<string, unknown>) } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function pickAnnotations(a: Record<string, unknown>): McpToolAnnotationsDef & Record<string, unknown> {
  const out: McpToolAnnotationsDef & Record<string, unknown> = {};
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) if (typeof a[k] === 'boolean') out[k] = a[k] as boolean;
  return out;
}

async function concreteServer(def: McpServerDef, resolveSource?: (slug: string) => Promise<McpServerDef | undefined>): Promise<Concrete> {
  if (!('source' in def)) return def;
  if (!resolveSource) throw new Error(`the MCP server is the connector "${def.source}", and this kernel has no way to reach connectors (resolveMcpSource)`);
  const found = await resolveSource(def.source);
  if (!found) throw new Error(`the connector "${def.source}" is not set up in this workspace`);
  if ('source' in found) throw new Error(`the connector "${def.source}" resolved to another connector`);
  return found;
}

/** What an MCP tool call returned, as a plain value: structured content, else JSON text, else the text. */
export function mcpResultValue(result: { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown }, tool: string): unknown {
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const text = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n');
  if (result.isError) throw new Error(`${tool} failed: ${text || 'the server reported an error'}`);
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  if ('toolResult' in result && result.toolResult !== undefined) return result.toolResult;
  if (!text) return content.length ? { content } : null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * MCP connections, one per (plugin, version, server), opened on first use and kept until
 * `closeAll` (the kernel's shutdown). A connection that fails is forgotten, so the next call retries.
 */
export class McpConnections {
  private clients = new Map<string, Promise<Client>>();
  constructor(private readonly resolveSource?: (slug: string) => Promise<McpServerDef | undefined>) {}

  private client(key: string, def: McpServerDef, root: string, name: string): Promise<Client> {
    let c = this.clients.get(key);
    if (!c) {
      c = concreteServer(def, this.resolveSource).then((d) => connect(d, root, name));
      c.then((client) => { client.onclose = () => { if (this.clients.get(key) === c) this.clients.delete(key); }; }, () => { this.clients.delete(key); });
      this.clients.set(key, c);
    }
    return c;
  }

  async call(input: {
    key: string; server: McpServerDef; serverName: string; root: string; tool: string; args: unknown; idempotencyKey: string; signal?: AbortSignal;
  }): Promise<unknown> {
    const client = await this.client(input.key, input.server, input.root, input.serverName);
    const result = await client.callTool(
      { name: input.tool, arguments: (input.args ?? {}) as Record<string, unknown>, _meta: { idempotencyKey: input.idempotencyKey } },
      undefined, input.signal ? { signal: input.signal } : undefined);
    return mcpResultValue(result as Parameters<typeof mcpResultValue>[0], input.tool);
  }

  get open(): number { return this.clients.size; }

  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.then((client) => client.close()).catch(() => undefined)));
  }
}

/** `{ command: [...] }`: one subprocess per call; the arguments as JSON on stdin, the result as JSON on stdout. */
export function runCommandTool(input: {
  command: string[]; args: unknown; root: string; timeoutMs?: number; idempotencyKey: string; signal?: AbortSignal; tool: string;
}): Promise<unknown> {
  const [first, ...rest] = input.command;
  if (!first) return Promise.reject(new Error(`${input.tool}: the command route names no command`));
  const r = resolveCommand(first, rest, { MEMWISE_IDEMPOTENCY_KEY: input.idempotencyKey }, input.root);
  const timeoutMs = input.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(r.command, r.args, { cwd: input.root, env: { ...process.env, ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); input.signal?.removeEventListener('abort', onAbort); fn(); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(() => reject(new Error(`${input.tool} timed out after ${timeoutMs} ms`))); }, timeoutMs);
    const onAbort = () => { child.kill('SIGKILL'); finish(() => reject(new Error(`${input.tool} was cancelled`))); };
    input.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (e) => finish(() => reject(new Error(`${input.tool}: could not run ${r.command}: ${e.message}`))));
    child.on('close', (code) => finish(() => {
      if (code !== 0) return reject(new Error(`${input.tool} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
      const text = stdout.trim();
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch {
        // Anything printed before the result is skipped: the last line that parses.
        const line = text.split('\n').reverse().find((l) => { try { JSON.parse(l); return true; } catch { return false; } });
        if (line === undefined) reject(new Error(`${input.tool} did not print JSON: ${text.slice(0, 200)}`));
        else resolve(JSON.parse(line));
      }
    }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input.args ?? {}));
  });
}
