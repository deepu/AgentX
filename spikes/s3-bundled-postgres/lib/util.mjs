// Small helpers shared by the spike scripts. No dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const runtime = typeof globalThis.Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.versions.node}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Time an async function. Returns [ms, result]. */
export async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return [Math.round(performance.now() - t0), value];
}

/**
 * Run a command and resolve on process *exit* (not 'close'): on Windows the
 * postmaster started by `pg_ctl start` can inherit our pipes and keep them open.
 */
export function run(cmd, args, { env, stdio = 'pipe', shell = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio, windowsHide: true, shell });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(cmd)} timed out`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); setTimeout(() => resolve({ code, stdout, stderr }), 20); });
  });
}

/** Size on disk of a directory tree (symlinks counted as links, not followed). */
export function dirStats(dir) {
  let bytes = 0, files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const s = dirStats(p); bytes += s.bytes; files += s.files; }
    else if (entry.isFile()) { bytes += fs.statSync(p).size; files++; }
  }
  return { bytes, files };
}

export const mb = (bytes) => (bytes == null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Print rows of [label, value, note] as an aligned text table. */
export function printTable(title, rows) {
  const w0 = Math.max(...rows.map((r) => String(r[0]).length), 6);
  const w1 = Math.max(...rows.map((r) => String(r[1]).length), 6);
  const line = `+${'-'.repeat(w0 + 2)}+${'-'.repeat(w1 + 2)}+`;
  console.log(`\n${title}\n${line}`);
  for (const [k, v, note] of rows) console.log(`| ${String(k).padEnd(w0)} | ${String(v).padEnd(w1)} |${note ? ' ' + note : ''}`);
  console.log(line);
}
