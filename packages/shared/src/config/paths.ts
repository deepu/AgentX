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

import { existsSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'fs';
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
 * Runs only for the default location (no MEMWISE_CONFIG_DIR), only when the
 * new folder does not exist yet and the old one is a real folder. After the
 * move it leaves a link at the old path, so absolute paths stored inside
 * sessions and workspace files keep resolving, and rewrites the old folder's
 * paths in `config.json` (workspace roots). Never throws: on any failure the
 * app starts with whatever folder exists.
 */
export function migrateLegacyConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): LegacyConfigMigration {
  try {
    if (env.MEMWISE_CONFIG_DIR?.trim()) return 'skipped';
    const target = join(home, DEFAULT_CONFIG_DIR_NAME);
    const legacy = join(home, LEGACY_CONFIG_DIR_NAME);
    if (existsSync(target) || !existsSync(legacy) || !lstatSync(legacy).isDirectory()) return 'skipped';

    renameSync(legacy, target);
    try {
      symlinkSync(target, legacy, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // A missing link only affects absolute paths stored before the move.
    }

    const configFile = join(target, 'config.json');
    if (existsSync(configFile)) {
      const raw = readFileSync(configFile, 'utf-8');
      const rewritten = raw
        .split(legacy).join(target)
        .split(`~/${LEGACY_CONFIG_DIR_NAME}`).join(`~/${DEFAULT_CONFIG_DIR_NAME}`);
      if (rewritten !== raw) writeFileSync(configFile, rewritten, 'utf-8');
    }
    return 'moved';
  } catch {
    return 'skipped';
  }
}

migrateLegacyConfigDir();

export const CONFIG_DIR = resolveConfigDir();
