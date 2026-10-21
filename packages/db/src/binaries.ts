/**
 * Finding Postgres binaries (`initdb`, `pg_ctl`, `postgres`): an explicit folder, else the
 * `@embedded-postgres/<platform>` package (D37), else a system install.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface PgBinaries {
  binDir: string;
  initdb: string;
  pg_ctl: string;
  postgres: string;
  source: 'binDir' | 'embedded' | 'system';
}

const isWin = process.platform === 'win32';

const PLATFORM_PACKAGE: Record<string, string> = {
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'win32-x64': '@embedded-postgres/windows-x64',
};

function fromDir(binDir: string, source: PgBinaries['source']): PgBinaries | undefined {
  const exe = (n: string) => path.join(binDir, isWin ? `${n}.exe` : n);
  if (!fs.existsSync(exe('initdb')) || !fs.existsSync(exe('pg_ctl'))) return undefined;
  return { binDir, initdb: exe('initdb'), pg_ctl: exe('pg_ctl'), postgres: exe('postgres'), source };
}

/** The bundled binaries for this platform, if the optional package is installed. */
export function embeddedBinaries(): PgBinaries | undefined {
  const name = PLATFORM_PACKAGE[`${process.platform}-${process.arch}`];
  if (!name) return undefined;
  let entry: string;
  try { entry = createRequire(import.meta.url).resolve(name); } catch { return undefined; }
  const native = path.join(path.resolve(path.dirname(entry), '..'), 'native');
  hydrateSymlinks(native);
  return fromDir(path.join(native, 'bin'), 'embedded');
}

/**
 * The packages list their shared-library symlinks in `native/pg-symlinks.json` and recreate them
 * in a postinstall script, which Bun skips for untrusted dependencies. Recreate any that are
 * missing (idempotent). `nativeDir` is the package's `native` folder or a copy of it under another
 * name (the desktop app's `memwise/postgres`); the list's paths start with `native/`. A read-only
 * install that already has them is left alone. apps/electron/scripts/afterPack.cjs does the same
 * for the packaged app.
 */
export function hydrateSymlinks(nativeDir: string): void {
  const list = path.join(nativeDir, 'pg-symlinks.json');
  if (!fs.existsSync(list)) return;
  const inNative = (p: string) => path.join(nativeDir, p.replace(/^native[\\/]/, ''));
  for (const { source, target } of JSON.parse(fs.readFileSync(list, 'utf8')) as { source: string; target: string }[]) {
    const link = inNative(target);
    if (fs.existsSync(link)) continue;
    try {
      fs.rmSync(link, { force: true }); // a dangling link from an earlier copy
      fs.symlinkSync(path.relative(path.dirname(link), inNative(source)), link);
    } catch {
      // Not writable or a concurrent hydrate won the race; initdb will say if a library is missing.
    }
  }
}

/** A system install: `pg_config --bindir`, else the highest /usr/lib/postgresql/<n>/bin. */
export function systemBinaries(): PgBinaries | undefined {
  const r = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (r.status === 0) {
    const found = fromDir(r.stdout.trim(), 'system');
    if (found) return found;
  }
  const base = '/usr/lib/postgresql';
  if (!fs.existsSync(base)) return undefined;
  const majors = fs.readdirSync(base).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a));
  for (const major of majors) {
    const found = fromDir(path.join(base, major, 'bin'), 'system');
    if (found) return found;
  }
  return undefined;
}

/** `binDir` when given, else embedded, else system. Throws when none is found. */
export function findBinaries(binDir?: string): PgBinaries {
  if (binDir) {
    hydrateSymlinks(path.dirname(binDir)); // a copy of the embedded package's binaries
    const found = fromDir(binDir, 'binDir');
    if (!found) throw new Error(`No initdb/pg_ctl in ${binDir}`);
    return found;
  }
  const found = embeddedBinaries() ?? systemBinaries();
  if (!found) throw new Error(`No Postgres binaries found: install @embedded-postgres/<platform> or a system Postgres, or pass binDir`);
  return found;
}

/** The major version of the binaries, e.g. 18, from `initdb --version`. */
export function majorVersion(bins: PgBinaries): number {
  const r = spawnSync(bins.initdb, ['--version'], { encoding: 'utf8' });
  const m = /(\d+)(?:\.\d+)?/.exec(r.stdout ?? '');
  if (r.status !== 0 || !m) throw new Error(`Could not run ${bins.initdb} --version: ${r.stderr || r.error?.message}`);
  return Number(m[1]);
}
