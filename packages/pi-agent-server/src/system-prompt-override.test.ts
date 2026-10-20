import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager, type ExtensionAPI, type InlineExtension } from '@earendil-works/pi-coding-agent';
import { resolveMemWiseAgentDir } from './agent-dir.ts';
import { createMemWiseSettingsManager } from './session-settings.ts';
import {
  MEMWISE_SYSTEM_PROMPT_EXTENSION_NAME,
  createMemWiseResourceLoader,
  createSystemPromptOverride,
} from './system-prompt-override.ts';

/**
 * Regression contract for craft-agents-oss#648.
 *
 * Pi rebuilds its own system prompt on every `session.prompt()` and whenever the
 * tool loadout changes. The only supported way to replace the whole prompt is a
 * `before_agent_start` handler returning `{ systemPrompt }`, which the SDK applies
 * per run. These tests pin that the override registers exactly that handler,
 * stays silent until MemWise sets a prompt, and always returns the latest prompt.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

function loadInline(extension: InlineExtension): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
  } as unknown as ExtensionAPI;
  const factory = typeof extension === 'function' ? extension : extension.factory;
  void factory(pi);
  return handlers;
}

function invoke(handlers: Map<string, Handler[]>): unknown {
  const [handler, ...rest] = handlers.get('before_agent_start') ?? [];
  expect(handler).toBeDefined();
  expect(rest).toHaveLength(0);
  return handler!({ type: 'before_agent_start', prompt: 'hi', systemPrompt: 'SDK PROMPT' }, {});
}

describe('createSystemPromptOverride', () => {
  it('registers a single hidden before_agent_start handler under a stable inline name', () => {
    const override = createSystemPromptOverride();
    expect(override.extension).toMatchObject({ name: MEMWISE_SYSTEM_PROMPT_EXTENSION_NAME, hidden: true });
    const handlers = loadInline(override.extension);
    expect([...handlers.keys()]).toEqual(['before_agent_start']);
  });

  it('leaves the SDK prompt alone until a prompt is set', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    expect(override.current()).toBeUndefined();
    expect(invoke(handlers)).toBeUndefined();
  });

  it('forces the exact MemWise prompt once set, on every run', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    override.set('MEMWISE_PROMPT');
    expect(invoke(handlers)).toEqual({ systemPrompt: 'MEMWISE_PROMPT' });
    expect(invoke(handlers)).toEqual({ systemPrompt: 'MEMWISE_PROMPT' });
    expect(override.current()).toBe('MEMWISE_PROMPT');
  });

  it('a later set() replaces the forced prompt for the next run', () => {
    const override = createSystemPromptOverride();
    const handlers = loadInline(override.extension);
    override.set('FIRST');
    override.set('SECOND');
    expect(invoke(handlers)).toEqual({ systemPrompt: 'SECOND' });
  });
});

describe('createMemWiseResourceLoader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('loads the override as an inline extension through the SDK loader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memwise-pi-loader-'));
    dirs.push(root);
    const loader = await createMemWiseResourceLoader({
      cwd: root,
      agentDir: join(root, '.pi-agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: createSystemPromptOverride(),
    });
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions.some(ext => ext.path === `<inline:${MEMWISE_SYSTEM_PROMPT_EXTENSION_NAME}>`)).toBe(true);
  });

  /** A working directory whose `.pi/extensions` would leave a marker file when loaded. */
  function repoWithProjectExtension(): { cwd: string; marker: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'memwise-pi-repo-'));
    dirs.push(cwd);
    const marker = join(cwd, 'extension-ran');
    mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(
      join(cwd, '.pi', 'extensions', 'repo-extension.ts'),
      `import { writeFileSync } from 'node:fs';\n` +
        `export default function repoExtension() { writeFileSync(${JSON.stringify(marker)}, 'ran'); }\n`,
    );
    return { cwd, marker };
  }

  it('loads nothing but the override for MemWise sessions (no project, global or built-in extensions)', async () => {
    const { cwd, marker } = repoWithProjectExtension();
    const sessionPath = mkdtempSync(join(tmpdir(), 'memwise-pi-session-'));
    dirs.push(sessionPath);
    for (const purpose of ['main', 'ephemeral'] as const) {
      const loader = await createMemWiseResourceLoader({
        cwd,
        agentDir: resolveMemWiseAgentDir({ sessionPath }),
        settingsManager: createMemWiseSettingsManager(purpose),
        systemPromptOverride: createSystemPromptOverride(),
      });
      const { extensions, errors } = loader.getExtensions();
      expect(errors).toEqual([]);
      expect(extensions.map(ext => ext.path)).toEqual([`<inline:${MEMWISE_SYSTEM_PROMPT_EXTENSION_NAME}>`]);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('control: a trusted project (the SDK default) would run the repository extension', async () => {
    const { cwd, marker } = repoWithProjectExtension();
    const loader = await createMemWiseResourceLoader({
      cwd,
      agentDir: join(cwd, '.pi-agent'),
      settingsManager: SettingsManager.inMemory(),
      systemPromptOverride: createSystemPromptOverride(),
    });
    expect(loader.getExtensions().extensions.some(ext => ext.path.endsWith('repo-extension.ts'))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});
