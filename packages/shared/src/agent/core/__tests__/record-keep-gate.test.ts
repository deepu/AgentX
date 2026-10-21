/**
 * The Keep gate of a MemWise record chat (docs/memwise/25-literature-poc.md §6), end to end
 * through the real permission pipeline: `runPreToolUseChecks` with the real mode manager,
 * permissions config and PermissionManager, then the Guarded-mode check the Claude backend runs
 * after it. Both backends call the tool `mcp__session__record_keep` (the Pi SDK registers session
 * tools with the same prefix) and run this same pipeline.
 *
 * Explore blocks it; Ask, Execute and Guarded always ask, and nothing auto-allows it: not an
 * "Always Allow" answer, not a session whitelist entry, not an allowed MCP pattern naming it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupModeState, initializeModeState, setGuardedModeActiveResolver } from '../../mode-manager.ts';
import { permissionsConfigCache } from '../../permissions-config.ts';
import type { PermissionMode } from '../../mode-types.ts';
import { applyGuardedModeCheck, type GuardedModeCheck } from '../guarded-mode.ts';
import { PermissionManager } from '../permission-manager.ts';
import { runPreToolUseChecks, type PreToolUseCheckResult, type PreToolUseInput } from '../pre-tool-use.ts';

const SESSION = 'record-keep-gate-test';
const KEEP = 'mcp__session__record_keep';
const ROWS = { entity: 'literature.evidence', rows: [{ topic: 'topic_1', article: 'art_1', outcome: 'Body weight', effect: -10.5, quote: 'were randomly assigned' }] };
const originalConfigDir = process.env.MEMWISE_CONFIG_DIR;
let configDir: string;
let workspaceRootPath: string;

/** An active Guarded-mode check that finds no risk in anything (the most permissive answer). */
const noRisk: GuardedModeCheck = { isActive: () => true, check: async () => ({ risks: [] }) };

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'keep-gate-config-'));
  workspaceRootPath = mkdtempSync(join(tmpdir(), 'keep-gate-workspace-'));
  mkdirSync(join(configDir, 'permissions'), { recursive: true });
  // The broadest allow-list a workspace could write for it.
  writeFileSync(join(configDir, 'permissions', 'default.json'), JSON.stringify({
    version: '2026-09-27',
    allowedBashPatterns: [],
    allowedMcpPatterns: ['get', 'list', 'keep', 'record_keep', '.*'],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
  }));
  process.env.MEMWISE_CONFIG_DIR = configDir;
  permissionsConfigCache.clear();
  setGuardedModeActiveResolver(() => true);
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MEMWISE_CONFIG_DIR;
  else process.env.MEMWISE_CONFIG_DIR = originalConfigDir;
  permissionsConfigCache.clear();
  cleanupModeState(SESSION);
  setGuardedModeActiveResolver(null);
  rmSync(configDir, { recursive: true, force: true });
  rmSync(workspaceRootPath, { recursive: true, force: true });
});

/** The session in `mode`, with "Always Allow" already answered for the keep tool. */
function sessionIn(mode: PermissionMode): { input: PreToolUseInput; permissionManager: PermissionManager } {
  cleanupModeState(SESSION);
  initializeModeState(SESSION, mode);
  const permissionManager = new PermissionManager({ workspaceId: 'ws', sessionId: SESSION, workingDirectory: workspaceRootPath });
  permissionManager.remember({ kind: 'command', key: KEEP });
  permissionManager.whitelistCommand(KEEP);
  const input = {
    toolName: KEEP,
    input: ROWS,
    sessionId: SESSION,
    permissionMode: mode,
    workspaceRootPath,
    workspaceId: 'ws',
    workingDirectory: workspaceRootPath,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    prerequisiteManager: { checkPrerequisites: () => ({ allowed: true }), checkBashPrerequisites: () => ({ allowed: true }) },
  } as PreToolUseInput;
  return { input, permissionManager };
}

/** What the backend decides: the pipeline, then the Guarded-mode check (as ClaudeAgent runs them). */
async function decide(mode: PermissionMode): Promise<PreToolUseCheckResult> {
  const { input, permissionManager } = sessionIn(mode);
  expect(permissionManager.isCommandWhitelisted(KEEP)).toBe(true);
  return applyGuardedModeCheck(runPreToolUseChecks(input), input, noRisk);
}

describe('record_keep through the permission pipeline', () => {
  it('Explore blocks it, saying how to keep', async () => {
    const result = await decide('safe');
    expect(result.type).toBe('block');
    if (result.type === 'block') expect(result.reason).toContain("Rows can't be kept in Explore mode");
  });

  for (const mode of ['ask', 'allow-all', 'guarded'] as const) {
    it(`${mode} asks, showing the rows, with nothing to remember, despite the whitelist and allow-list`, async () => {
      const result = await decide(mode);
      expect(result.type).toBe('prompt');
      if (result.type !== 'prompt') return;
      expect(result.promptType).toBe('mcp_mutation');
      expect(result.description).toBe('Keep 1 row as evidence (literature.evidence)');
      expect(result.command).toContain('outcome: Body weight');
      expect(result.command).toContain('quote: "were randomly assigned"');
      // No "Always Allow": the next keep is asked again.
      expect(result.remember).toBeUndefined();
    });
  }

  it('the record reads run without asking in every mode (the gate is the keep alone)', async () => {
    for (const mode of ['safe', 'ask', 'allow-all', 'guarded'] as const) {
      const { input } = sessionIn(mode);
      for (const toolName of ['mcp__session__record_get', 'mcp__session__record_query']) {
        const read = { ...input, toolName, input: { entity: 'literature.topic', id: 'topic_1' } };
        expect((await applyGuardedModeCheck(runPreToolUseChecks(read), read, noRisk)).type).toBe('allow');
      }
    }
  });
});
