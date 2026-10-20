/**
 * Centralized path configuration for MemWise.
 *
 * `CONFIG_DIR` is the one place that decides where the app keeps its state
 * (`~/.memwise` by default). Every other module joins onto it; never join
 * `homedir()` with `.memwise` directly (OSS #1062).
 *
 * Supports multi-instance development via the MEMWISE_CONFIG_DIR environment
 * variable. When running from a numbered folder (e.g., craft-tui-agent-1), the
 * detect-instance.sh script sets MEMWISE_CONFIG_DIR to ~/.memwise-1, allowing
 * multiple instances to run simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.memwise/
 * Instance 1 (-1 suffix): ~/.memwise-1/
 * Instance 2 (-2 suffix): ~/.memwise-2/
 *
 * Two modules re-derive this from the environment on purpose because they must
 * stay import-free: `interceptor-common.ts` (preloaded into the Pi subprocess)
 * and session-tools-core `handlers/config-validate.ts` (no dependency on shared).
 *
 * MemWise was renamed from Craft Agents, whose state lived in `~/.craft-agent`.
 * The first load moves that folder here once (see `migrateLegacyConfigDir`).
 */

import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_CONFIG_DIR_NAME = '.memwise';

/**
 * Resolve the config directory: a non-empty MEMWISE_CONFIG_DIR wins, otherwise
 * `<home>/.memwise`. Pure; `CONFIG_DIR` is this evaluated once at load.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.MEMWISE_CONFIG_DIR?.trim();
  return override ? override : join(home, DEFAULT_CONFIG_DIR_NAME);
}

/** Config folder name used before the rename to MemWise. */
export const LEGACY_CONFIG_DIR_NAME = '.craft-agent';

export type LegacyConfigMigration = 'moved' | 'skipped';

/**
 * One-time move of the pre-rename `~/.craft-agent` folder to `~/.memwise`.
 *
 * Runs only for the default location (no MEMWISE_CONFIG_DIR) and only when the
 * old folder exists (a symlinked one counts; the link itself is moved). If
 * `~/.memwise` already exists it wins, unless it holds no `config.json` while
 * the old folder does: that is the empty folder an earlier launch created after
 * the move failed (e.g. Windows refused the rename while Craft Agents was
 * open), so it is set aside and the move is retried.
 *
 * After the move it leaves a link at the old path, so absolute paths stored
 * inside sessions and workspace files keep resolving, and rewrites paths under
 * the old folder in `config.json` (workspace roots). Never throws: on any
 * failure the app starts with whatever folder exists.
 */
export function migrateLegacyConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): LegacyConfigMigration {
  const target = join(home, DEFAULT_CONFIG_DIR_NAME);
  const legacy = join(home, LEGACY_CONFIG_DIR_NAME);
  try {
    if (env.MEMWISE_CONFIG_DIR?.trim()) return 'skipped';
    if (!existsSync(legacy) || !statSync(legacy).isDirectory()) return 'skipped';
    if (existsSync(target)) {
      if (realpathSync(legacy) === realpathSync(target)) return 'skipped'; // already moved
      if (existsSync(join(target, 'config.json')) || !existsSync(join(legacy, 'config.json'))) return 'skipped';
      renameSync(target, `${target}.empty-${Date.now()}`);
    }

    renameSync(legacy, target);
    try {
      symlinkSync(target, legacy, platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // A missing link only affects absolute paths stored before the move.
    }

    const configFile = join(target, 'config.json');
    if (existsSync(configFile)) {
      const raw = readFileSync(configFile, 'utf-8');
      const rewritten = JSON.stringify(rewriteLegacyPaths(JSON.parse(raw), [
        [legacy, target],
        [`~/${LEGACY_CONFIG_DIR_NAME}`, `~/${DEFAULT_CONFIG_DIR_NAME}`],
      ], platform), null, 2);
      if (rewritten !== JSON.stringify(JSON.parse(raw), null, 2)) writeFileSync(configFile, rewritten, 'utf-8');
    }
    return 'moved';
  } catch (error) {
    console.error(`[memwise] Could not move ${legacy} to ${target}; will retry on next launch:`, error);
    return 'skipped';
  }
}

/**
 * Replace a leading `from` path with `to` in every string of a parsed JSON
 * value. Separators are compared as `/`, and case-insensitively on Windows, so
 * `C:\Users\me\.craft-agent\x` and `c:/users/me/.craft-agent/x` both match.
 */
function rewriteLegacyPaths(value: unknown, pairs: [string, string][], platform: NodeJS.Platform): unknown {
  const key = (p: string) => {
    const slashed = p.replace(/\\/g, '/');
    return platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  if (typeof value === 'string') {
    for (const [from, to] of pairs) {
      const v = key(value);
      const f = key(from);
      if (v === f || v.startsWith(`${f}/`)) return to + value.slice(from.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteLegacyPaths(item, pairs, platform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteLegacyPaths(v, pairs, platform)]));
  }
  return value;
}

migrateLegacyConfigDir();

export const CONFIG_DIR = resolveConfigDir();
