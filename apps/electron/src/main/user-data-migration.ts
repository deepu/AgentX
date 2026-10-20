/**
 * One-time copy of the Electron userData folder from before the rename.
 *
 * Craft Agents kept its Chromium profile in `<appData>/Craft Agents`; renaming
 * the app moves userData to `<appData>/MemWise`. Copying the old profile keeps
 * renderer preferences (theme, sidebar widths, language, the `craft-`
 * localStorage keys) and cookies. Config, workspaces and credentials live in
 * `~/.memwise` and move separately (see `migrateLegacyConfigDir`).
 *
 * Must run after `app.setName` and before `app.whenReady`. Never throws.
 */
import { app } from 'electron'
import { cpSync, existsSync } from 'fs'
import { basename, join } from 'path'

const LEGACY_APP_NAME = 'Craft Agents'

// Rebuilt on demand, or tied to the old running instance: not worth copying.
const SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'Crashpad', 'logs',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'LOCK', 'lockfile',
])

export function migrateLegacyUserData(): 'copied' | 'skipped' {
  try {
    const target = app.getPath('userData')
    const legacy = join(app.getPath('appData'), LEGACY_APP_NAME)
    // Other startup code (e.g. Sentry) may create the folder early, so the
    // marker is the renderer profile itself, not the folder.
    if (target === legacy || !existsSync(legacy) || existsSync(join(target, 'Local Storage'))) return 'skipped'
    cpSync(legacy, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => !SKIP.has(basename(src)),
    })
    return 'copied'
  } catch (error) {
    console.error('[memwise] Could not copy the Craft Agents profile:', error)
    return 'skipped'
  }
}
