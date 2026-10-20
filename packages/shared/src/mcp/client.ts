/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  GetPromptResult,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * Sensitive environment variables that should NOT be passed to MCP subprocesses.
 * These could contain API keys, tokens, or credentials that MCP servers don't need
 * and shouldn't have access to.
 * NOTE: This list is duplicated in packages/session-tools-core/src/handlers/transform-data.ts (BLOCKED_ENV_VARS).
 * If you add a new entry here, update it there too.
 */
const BLOCKED_ENV_VARS = [
  // MemWise auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

/**
 * Per-request options for PoolClient calls.
 * Forwarded to the MCP SDK's RequestOptions so aborts become protocol-level
 * cancellation notifications instead of orphaned in-flight requests.
 */
export interface PoolRequestOptions {
  /** Cancels the in-flight request when aborted */
  signal?: AbortSignal;
  /** Request timeout in ms (SDK default applies when omitted) */
  timeoutMs?: number;
}

/** Per-call options for PoolClient.callTool. */
export interface PoolCallToolOptions extends PoolRequestOptions {
  /** The agent's stated intent: steers large-result handling; API tools also receive it as `_intent`. */
  intent?: string;
}

function toRequestOptions(options?: PoolRequestOptions): RequestOptions {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  };
}

/**
 * Interface for clients managed by McpClientPool.
 * Both MemWiseMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 *
 * The optional members expose what an MCP server offers beyond tools (resources,
 * prompts, its instructions). Only MemWiseMcpClient implements them; API sources are
 * tools-only, and the pool reports that instead of calling them.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown>;
  close(): Promise<void>;
  /** Capabilities from the initialize handshake (available once connected) */
  getServerCapabilities?(): ServerCapabilities | undefined;
  /** The server's `instructions` from the initialize handshake, if it sent any */
  getInstructions?(): string | undefined;
  listResources?(cursor?: string, options?: PoolRequestOptions): Promise<ListResourcesResult>;
  listResourceTemplates?(cursor?: string, options?: PoolRequestOptions): Promise<ListResourceTemplatesResult>;
  readResource?(uri: string, options?: PoolRequestOptions): Promise<ReadResourceResult>;
  listPrompts?(cursor?: string, options?: PoolRequestOptions): Promise<ListPromptsResult>;
  getPrompt?(name: string, args?: Record<string, string>, options?: PoolRequestOptions): Promise<GetPromptResult>;
}

export class MemWiseMcpClient implements PoolClient {
  private client: Client;
  private transport: Transport;
  private connected = false;

  constructor(config: McpClientConfig) {
    this.client = new Client({
      name: 'memwise',
      version: '1.0.0',
    });

    // Create transport based on config type
    if (config.transport === 'stdio') {
      // Stdio transport for local MCP servers - merge with process env,
      // but filter out sensitive credentials to prevent leaking secrets to subprocesses
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
          processEnv[key] = value;
        }
      }
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...processEnv, ...config.env },
      });
    } else {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);

    // Verify connection works by listing tools
    try {
      await this.client.listTools();
    } catch (error) {
      await this.client.close();
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  async callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.callTool({ name, arguments: args }, undefined, toRequestOptions(options));
    return result;
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  getInstructions(): string | undefined {
    return this.client.getInstructions();
  }

  async listResources(cursor?: string, options?: PoolRequestOptions): Promise<ListResourcesResult> {
    if (!this.connected) await this.connect();
    return this.client.listResources(cursor ? { cursor } : undefined, toRequestOptions(options));
  }

  async listResourceTemplates(cursor?: string, options?: PoolRequestOptions): Promise<ListResourceTemplatesResult> {
    if (!this.connected) await this.connect();
    return this.client.listResourceTemplates(cursor ? { cursor } : undefined, toRequestOptions(options));
  }

  async readResource(uri: string, options?: PoolRequestOptions): Promise<ReadResourceResult> {
    if (!this.connected) await this.connect();
    return this.client.readResource({ uri }, toRequestOptions(options));
  }

  async listPrompts(cursor?: string, options?: PoolRequestOptions): Promise<ListPromptsResult> {
    if (!this.connected) await this.connect();
    return this.client.listPrompts(cursor ? { cursor } : undefined, toRequestOptions(options));
  }

  async getPrompt(name: string, args?: Record<string, string>, options?: PoolRequestOptions): Promise<GetPromptResult> {
    if (!this.connected) await this.connect();
    return this.client.getPrompt({ name, ...(args ? { arguments: args } : {}) }, toRequestOptions(options));
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
