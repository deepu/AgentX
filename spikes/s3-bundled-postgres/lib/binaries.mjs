// Locate the Postgres binaries shipped by the @embedded-postgres/<platform>
// npm packages (zonky builds: only initdb, pg_ctl and postgres + libs/share).
//
// Three builds are installed for the spike (see package.json):
//   current -> @embedded-postgres/<platform>@18.4   (what the app would ship)
//   18.1    -> pg-18-1-<platform>  (an older minor, to test minor upgrades)
//   17      -> pg-17-<platform>    (the previous major, to test major upgrades)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWin } from './util.mjs';

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLATFORM_PACKAGE = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'windows-x64',
};

export function platformPackage() {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGE[key];
  if (!pkg) throw new Error(`No embedded-postgres build wired up for ${key}`);
  return pkg;
}

export function binaries(flavour = 'current') {
  const plat = platformPackage();
  const name = { current: `@embedded-postgres/${plat}`, '18.1': `pg-18-1-${plat}`, '17': `pg-17-${plat}` }[flavour];
  const root = path.join(SPIKE_DIR, 'node_modules', name);
  if (!fs.existsSync(root)) throw new Error(`${name} is not installed (npm install in ${SPIKE_DIR})`);
  hydrateSymlinks(root);
  const exe = (n) => path.join(root, 'native', 'bin', isWin ? `${n}.exe` : n);
  return { name, root, native: path.join(root, 'native'), initdb: exe('initdb'), pg_ctl: exe('pg_ctl'), postgres: exe('postgres') };
}

// The packages ship shared-library symlinks as a JSON list and recreate them
// in a postinstall script. Bun does not run dependency postinstall scripts
// unless trusted, so recreate them here if missing (idempotent).
function hydrateSymlinks(root) {
  const list = path.join(root, 'native', 'pg-symlinks.json');
  if (!fs.existsSync(list)) return;
  for (const { source, target } of JSON.parse(fs.readFileSync(list, 'utf8'))) {
    const link = path.join(root, target);
    if (fs.existsSync(link)) continue;
    fs.symlinkSync(path.relative(path.dirname(link), path.join(root, source)), link);
  }
}
