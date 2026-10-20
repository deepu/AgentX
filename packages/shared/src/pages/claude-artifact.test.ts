/**
 * "Publish as Claude artifact": the injected bridge shim, the scoped Claude
 * Code query (options + structured result parsing), and the page.json pointer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runInNewContext } from 'vm';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPage, getPagePath, loadPageConfig, savePageContent, updatePage } from './storage.ts';
import {
  buildClaudeArtifactHtml,
  publishPageAsClaudeArtifact,
  runClaudeArtifactPublish,
  type ClaudeArtifactQueryFn,
} from './claude-artifact.ts';

const PAGE = { slug: 'weekly-sales', kind: 'live' as const };

/** Run the injected shim in a minimal window and return what the page would receive. */
function runShim(html: string): { received: Array<{ type: string; payload: any }>; postToHost: (msg: unknown) => void; flush: () => void } {
  const script = html.match(/<script data-memwise-artifact-bridge>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('shim not injected');
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const timers: Array<() => void> = [];
  const received: Array<{ type: string; payload: any }> = [];
  const window: any = {
    parent: { postMessage: () => { throw new Error('reached the real parent'); } },
    addEventListener: (type: string, fn: (event: any) => void) => { (listeners[type] ??= []).push(fn); },
    dispatchEvent: (event: any) => { for (const fn of listeners[event.type] ?? []) fn(event); return true; },
    open: () => {},
  };
  class MessageEvent { type: string; data: unknown; constructor(type: string, init: { data: unknown }) { this.type = type; this.data = init.data; } }
  runInNewContext(script, { window, MessageEvent, setTimeout: (fn: () => void) => { timers.push(fn); }, Object });
  window.addEventListener('message', (event: any) => received.push({ type: event.data.type, payload: event.data.payload }));
  const flush = () => { while (timers.length) timers.shift()!(); };
  return { received, postToHost: msg => window.parent.postMessage(msg), flush };
}

describe('buildClaudeArtifactHtml', () => {
  test('injects the bridge shim as the first script inside <head>', () => {
    const html = buildClaudeArtifactHtml('<!doctype html><html><head><title>Sales</title><script>page()</script></head><body></body></html>', PAGE, null);
    expect(html.indexOf('data-memwise-artifact-bridge')).toBeLessThan(html.indexOf('page()'));
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('data-memwise-artifact-bridge'));
  });

  test('adds a head when the page has none', () => {
    expect(buildClaudeArtifactHtml('<html><body>x</body></html>', PAGE, null)).toContain('<html>\n<head><script data-memwise-artifact-bridge>');
    expect(buildClaudeArtifactHtml('<div>x</div>', PAGE, null).startsWith('<script data-memwise-artifact-bridge>')).toBe(true);
  });

  test('cannot be broken out of by snapshot content', () => {
    const html = buildClaudeArtifactHtml('<html><head></head></html>', PAGE, { kv: { note: '</script><script>alert(1)</script>' } });
    const shim = html.match(/<script data-memwise-artifact-bridge>([\s\S]*?)<\/script>/)![1]!;
    expect(shim).not.toContain('</script>');
    expect(shim).toContain('\\u003c/script>');
  });
});

describe('bridge shim', () => {
  const snapshot = { version: 1, generatedAt: 1, kv: { total: 42 }, series: {} };

  test('answers ready with init carrying the snapshot and no grants', () => {
    const { received, postToHost, flush } = runShim(buildClaudeArtifactHtml('<html><head></head></html>', PAGE, snapshot));
    postToHost({ protocol: 'memwise-pages/v1', type: 'ready' });
    flush();
    expect(received).toEqual([{ type: 'init', payload: { page: { slug: 'weekly-sales', kind: 'live' }, nonce: 'claude-artifact', snapshot, grants: [] } }]);
  });

  test('declines source actions and grant requests (view-only copy)', () => {
    const { received, postToHost, flush } = runShim(buildClaudeArtifactHtml('<html><head></head></html>', PAGE, snapshot));
    postToHost({ protocol: 'memwise-pages/v1', type: 'action', requestId: 'r1', nonce: 'claude-artifact' });
    postToHost({ protocol: 'memwise-pages/v1', type: 'grant-request', requests: [] });
    postToHost({ protocol: 'other', type: 'ready' });
    flush();
    expect(received.map(r => r.type)).toEqual(['action-result', 'grants']);
    expect(received[0]!.payload.result).toMatchObject({ requestId: 'r1', ok: false });
    expect(received[1]!.payload).toEqual({ grants: [] });
  });
});

/** Fake SDK stream for one Artifact publish. */
function fakeQuery(steps: (opts: Options, prompt: string) => SDKMessage[], seen?: { options?: Options; prompt?: string }): ClaudeArtifactQueryFn {
  return ({ prompt, options }) => {
    if (seen) { seen.options = options; seen.prompt = prompt; }
    const messages = steps(options, prompt);
    return (async function* () { for (const m of messages) yield m; })();
  };
}

const init = (tools: string[]) => ({ type: 'system', subtype: 'init', tools }) as unknown as SDKMessage;
const toolUse = (id: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input }] } }) as unknown as SDKMessage;
const toolResult = (id: string, output: unknown, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: typeof output === 'string' ? output : JSON.stringify(output) }] },
  tool_use_result: output,
}) as unknown as SDKMessage;
const text = (value: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } }) as unknown as SDKMessage;
const success = { type: 'result', subtype: 'success' } as unknown as SDKMessage;

describe('runClaudeArtifactPublish', () => {
  const request = { filePath: '/tmp/x/weekly-sales.html', title: 'Weekly sales' };
  const base = { model: 'claude-haiku-5-5', cwd: '/tmp/x', authEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'connection-token' } };

  test('runs only the pre-approved Artifact tool, without filesystem settings or MCP servers, and returns the tool output', async () => {
    const seen: { options?: Options; prompt?: string } = {};
    const result = await runClaudeArtifactPublish(request, {
      ...base,
      query: fakeQuery(() => [
        init(['Artifact']),
        toolUse('t1', { file_path: request.filePath }),
        toolResult('t1', { url: 'https://claude.ai/artifact/abc', path: request.filePath, artifact_id: 'abc', title: 'Weekly sales' }),
        text('https://claude.ai/artifact/abc'),
        success,
      ], seen),
    });
    expect(result).toEqual({ url: 'https://claude.ai/artifact/abc', artifactId: 'abc', title: 'Weekly sales' });
    expect(seen.options).toMatchObject({
      tools: ['Artifact', 'Read'], allowedTools: ['Artifact'], permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true,
      persistSession: false, model: 'claude-haiku-5-5', cwd: '/tmp/x',
      thinking: { type: 'adaptive' }, effort: 'low',
    });
    expect(seen.prompt).toContain(JSON.stringify(request.filePath));
    expect(seen.prompt).not.toContain('"action":"read"');
  });

  test('updates an existing artifact: read first, then publish to the same url', async () => {
    const seen: { prompt?: string } = {};
    await runClaudeArtifactPublish({ ...request, existingUrl: 'https://claude.ai/artifact/abc' }, {
      ...base,
      query: fakeQuery(() => [
        init(['Artifact']),
        toolUse('r', { action: 'read', url: 'https://claude.ai/artifact/abc' }),
        toolResult('r', '<html>live</html>'),
        toolUse('p', { file_path: request.filePath, url: 'https://claude.ai/artifact/abc' }),
        toolResult('p', { url: 'https://claude.ai/artifact/abc', path: request.filePath, updated: true }),
        success,
      ], seen),
    });
    expect(seen.prompt).toContain('{"action":"read","url":"https://claude.ai/artifact/abc"}');
  });

  test('authenticates with the connection\'s own auth env and opts in to the Artifact tool', async () => {
    const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE'] as const;
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    // Another connection's credentials and a parent Claude Code session in the host env
    Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: 'other-connection', ANTHROPIC_API_KEY: 'sk-craft', ANTHROPIC_BASE_URL: 'https://proxy.example', CLAUDECODE: '1' });
    try {
      const seen: { options?: Options } = {};
      await runClaudeArtifactPublish(request, {
        ...base,
        query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', { url: 'https://claude.ai/artifact/x', path: request.filePath }), success], seen),
      });
      expect(seen.options?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'connection-token', CLAUDE_CODE_ARTIFACT: '1', PATH: process.env.PATH });
      expect(seen.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seen.options?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(seen.options?.env?.CLAUDECODE).toBeUndefined();
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  test('passes the connection\'s base URL through when it has one', async () => {
    const seen: { options?: Options } = {};
    await runClaudeArtifactPublish(request, {
      ...base,
      authEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'connection-token', ANTHROPIC_BASE_URL: 'https://gateway.example' },
      query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', { url: 'https://claude.ai/artifact/x', path: request.filePath }), success], seen),
    });
    expect(seen.options?.env?.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
  });

  test('asks to reconnect when the connection\'s credential is rejected', async () => {
    const failed = { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.' } as unknown as SDKMessage;
    await expect(runClaudeArtifactPublish(request, { ...base, query: fakeQuery(() => [init([]), failed]) }))
      .rejects.toThrow(/^ARTIFACT_AUTH_REQUIRED:/);
    await expect(runClaudeArtifactPublish(request, {
      ...base,
      query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', '<tool_use_error>Artifacts need a claude.ai login. Run /login and select "Claude account with subscription", then retry.</tool_use_error>', true), success]),
    })).rejects.toThrow(/^ARTIFACT_AUTH_REQUIRED:/);
  });

  test('reports an account without artifacts as unavailable (no tool, or refused by its organization\'s policy)', async () => {
    await expect(runClaudeArtifactPublish(request, { ...base, query: fakeQuery(() => [init(['Read']), text('I cannot publish.'), success]) }))
      .rejects.toThrow(/^ARTIFACT_UNAVAILABLE:/);
    await expect(runClaudeArtifactPublish(request, {
      ...base,
      query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', "<tool_use_error>Artifacts are disabled by your organization's policy. Contact your organization admin to enable them, then retry.</tool_use_error>", true), success]),
    })).rejects.toThrow("ARTIFACT_UNAVAILABLE: Artifacts are disabled by your organization's policy.");
  });

  test('surfaces a conflict and a tool error', async () => {
    await expect(runClaudeArtifactPublish(request, {
      ...base,
      query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', 'Refused: newer version', true), text('CONFLICT'), success]),
    })).rejects.toThrow(/^ARTIFACT_CONFLICT:/);
    await expect(runClaudeArtifactPublish(request, {
      ...base,
      query: fakeQuery(() => [init(['Artifact']), toolUse('p', {}), toolResult('p', 'Publish quota exceeded', true), text('failed'), success]),
    })).rejects.toThrow(/^ARTIFACT_PUBLISH_FAILED: Publish quota exceeded/);
  });
});

describe('publishPageAsClaudeArtifact', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'memwise-claude-artifact-')); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('publishes the page with its snapshot, records the pointer, and republishes to the same artifact', async () => {
    const page = createPage(root, { name: 'Weekly sales', description: 'Sales by week', kind: 'live' });
    savePageContent(root, page.slug, '<!doctype html><html><head><title>Weekly sales</title></head><body></body></html>');
    const dataDir = join(getPagePath(root, page.slug), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'snapshot.json'), JSON.stringify({ version: 1, generatedAt: 1, kv: { total: 42 }, series: {} }));

    let publishedHtml = '';
    const prompts: string[] = [];
    const query: ClaudeArtifactQueryFn = ({ prompt, options }) => {
      prompts.push(prompt);
      const filePath = JSON.parse(prompt.match(/- file_path: (".*")/)![1]!) as string;
      publishedHtml = readFileSync(filePath, 'utf-8');
      expect(filePath.startsWith(options.cwd!)).toBe(true);
      return fakeQuery(() => [
        init(['Artifact']),
        toolUse('p', { file_path: filePath }),
        toolResult('p', { url: 'https://claude.ai/artifact/abc', path: filePath, artifact_id: 'abc' }),
        success,
      ])({ prompt, options });
    };

    const authEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'connection-token' };
    const first = await publishPageAsClaudeArtifact({ workspaceRootPath: root, pageSlug: page.slug, model: 'claude-haiku-5-5', authEnv, query });
    expect(first.claudeArtifact).toMatchObject({ url: 'https://claude.ai/artifact/abc', artifactId: 'abc', publishedContentDigest: first.contentDigest });
    expect(publishedHtml).toContain('data-memwise-artifact-bridge');
    expect(publishedHtml).toContain('"total":42');
    expect(prompts[0]).toContain('"Weekly sales"');
    expect(prompts[0]).toContain('"Sales by week"');

    // The pointer is managed: a regular page update keeps it.
    updatePage(root, page.slug, { name: 'Weekly sales (EU)' });
    expect(loadPageConfig(root, page.slug)?.claudeArtifact?.url).toBe('https://claude.ai/artifact/abc');

    const second = await publishPageAsClaudeArtifact({ workspaceRootPath: root, pageSlug: page.slug, model: 'claude-haiku-5-5', authEnv, query });
    expect(prompts[1]).toContain('- url: "https://claude.ai/artifact/abc"');
    expect(second.claudeArtifact?.publishedAt).toBe(first.claudeArtifact?.publishedAt);
  });

  test('refuses a page without content', async () => {
    const page = createPage(root, { name: 'Empty page' });
    await expect(publishPageAsClaudeArtifact({ workspaceRootPath: root, pageSlug: page.slug, model: 'm', authEnv: {}, query: fakeQuery(() => []) }))
      .rejects.toThrow(/^PAGE_NO_CONTENT:/);
  });
});
