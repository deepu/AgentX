/**
 * Starts the MemWise kernel (playbooks, cases, inbox) inside Electron main, after the window is
 * up and without blocking startup (19 §9). The kernel packages are bundled into main.cjs, where
 * `import.meta.url` is unavailable, so the migrations folder, the example playbooks and the
 * Postgres binaries are located here and handed over explicitly.
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { CONFIG_DIR } from '@memwise/shared/config/paths'

interface Log { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }

const PG_PACKAGE: Record<string, string> = {
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'win32-x64': '@embedded-postgres/windows-x64',
}

/** The repo root in dev (main.cjs lives in apps/electron/dist). */
function repoRoot(): string {
  return join(__dirname, '..', '..', '..')
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  return paths.find((p): p is string => !!p && existsSync(p))
}

function postgresBinDir(): string | undefined {
  if (process.env.MEMWISE_PG_BIN_DIR) return process.env.MEMWISE_PG_BIN_DIR
  const packaged = app.isPackaged ? join(process.resourcesPath, 'memwise', 'postgres', 'bin') : undefined
  if (packaged && existsSync(packaged)) return packaged
  const name = PG_PACKAGE[`${process.platform}-${process.arch}`]
  if (!name) return undefined
  try {
    const entry = require.resolve(name, { paths: [process.cwd(), repoRoot(), __dirname] })
    const bin = join(dirname(entry), '..', 'native', 'bin')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined // falls back to a system Postgres, or the status explains
  }
}

let starting: Promise<unknown> | null = null

export function startMemwiseKernel(log: Log): void {
  if (starting) return
  if (process.env.MEMWISE_KERNEL === '0' || process.env.MEMWISE_KERNEL === 'false') {
    log.info('[memwise] kernel disabled by MEMWISE_KERNEL=0')
    return
  }
  const resources = app.isPackaged ? process.resourcesPath : undefined
  process.env.MEMWISE_MIGRATIONS_DIR ??= firstExisting([
    resources && join(resources, 'memwise', 'migrations'),
    join(repoRoot(), 'packages', 'db', 'migrations'),
    join(process.cwd(), 'packages', 'db', 'migrations'),
  ])
  // Draft example cases run in the memwise CLI, out of process (DBOS is process-wide). Under Bun
  // the kernel runs the CLI from source; Electron runs the bundled one with itself as Node.
  if (!process.versions.bun && !process.env.MEMWISE_CLI_JS) {
    const cli = firstExisting([
      join(__dirname, 'memwise-cli.mjs'),
      resources && join(resources, 'app.asar.unpacked', 'dist', 'memwise-cli.mjs'),
    ])
    if (cli) process.env.MEMWISE_CLI_JS = cli
    else log.warn('[memwise] the bundled memwise CLI was not found: checking a draft will report its example cases as not run')
  }
  const pgBinDir = postgresBinDir()
  starting = import('@memwise/server-core/memwise')
    .then(({ startMemwiseService }) => startMemwiseService({
      configDir: CONFIG_DIR,
      mode: 'desktop',
      logger: log,
      exampleRoots: [resources, app.getAppPath(), repoRoot(), process.cwd()].filter((r): r is string => !!r),
      ...(pgBinDir ? { pgBinDir } : {}),
    }))
    .catch((err: unknown) => {
      log.error('[memwise] kernel failed to load:', err instanceof Error ? err.message : err)
    })
}

export async function stopMemwiseKernel(log: Log): Promise<void> {
  if (!starting) return
  try {
    await starting
    const { stopMemwiseService } = await import('@memwise/server-core/memwise')
    await stopMemwiseService()
  } catch (err) {
    log.error('[memwise] stop failed:', err instanceof Error ? err.message : err)
  }
}
