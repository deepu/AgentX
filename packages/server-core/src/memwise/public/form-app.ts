/**
 * The form app's files (23 §4): the HTML shell for `/f/<token>` and `/i/<token>`, and its built
 * assets at `/assets/form/*`, read from `apps/external-form/dist`. The shell carries no data; its
 * asset URLs are made relative to the page, so they work under a subdomain
 * (`https://<id>.relay/f/…`) and under a path (`https://relay/x/<id>/f/…`) alike.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

/** Where the shell's assets are served from, below the public base. */
export const FORM_ASSETS_PREFIX = '/assets/form/'

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Shown when the form app isn't built: plain words, no scripts, nothing from elsewhere. */
export const FALLBACK_SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Form unavailable</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px 20px; color: #1f2328; background: #fff; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } }
</style>
</head>
<body>
<main>
  <h1>This form isn't available right now</h1>
  <p>The page that shows it is missing from this installation of MemWise. Please let the business that sent you this link know, or try again later.</p>
</main>
</body>
</html>
`

/** Absolute URLs, page anchors and inline data are left as they are. */
const KEEP = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

/**
 * Rewrites the shell's `src` and `href` attributes so each points at `/assets/form/<file>`
 * relative to the page: `up` is `../` once per path segment below the base (`/f/<token>` → `../`).
 * Accepts what a Vite build writes with any base (`./assets/x.js`, `/assets/form/assets/x.js`,
 * `/assets/x.js`, `assets/x.js`).
 */
export function rewriteShell(html: string, up: string): string {
  return html.replace(/\b(src|href)=(["'])([^"']*)\2/gi, (whole, attr: string, q: string, url: string) => {
    if (!url || KEEP.test(url)) return whole
    // `../assets/form/x.js` (what apps/external-form builds) already means `/assets/form/x.js`.
    let path = url.replace(/^(?:\.\.?\/)+/, '/')
    if (!path.startsWith('/')) path = `/${path}`
    if (path.startsWith(FORM_ASSETS_PREFIX)) path = path.slice(FORM_ASSETS_PREFIX.length)
    else path = path.slice(1)
    return `${attr}=${q}${up}${FORM_ASSETS_PREFIX.slice(1)}${path}${q}`
  })
}

export interface FormApp {
  /** The shell for a page `depth` segments below the base, or the fallback when the app isn't built. */
  shell(depth: number): { html: string; built: boolean }
  /** A built file by its path under `/assets/form/`; undefined when it isn't there or isn't allowed. */
  asset(path: string): { data: ArrayBuffer; mime: string } | undefined
}

export function formApp(dir: string | undefined): FormApp {
  let root: string | undefined
  try { root = dir && existsSync(dir) ? realpathSync(dir) : undefined } catch { root = undefined }
  // The shell is read once per start (the dist doesn't change under a running app); assets are read per request.
  let indexHtml: string | undefined
  const readIndex = () => {
    if (indexHtml !== undefined || !root) return indexHtml
    try { indexHtml = readFileSync(join(root, 'index.html'), 'utf8') } catch { indexHtml = undefined }
    return indexHtml
  }
  return {
    shell(depth) {
      const html = readIndex()
      if (!html) return { html: FALLBACK_SHELL, built: false }
      return { html: rewriteShell(html, '../'.repeat(Math.max(1, depth))), built: true }
    },
    asset(path) {
      if (!root) return undefined
      const parts = path.split('/')
      let segments: string[]
      try { segments = parts.map((p) => decodeURIComponent(p)) } catch { return undefined }
      if (!segments.length || segments.some((s) => !s || s === '.' || s === '..' || /[\\\0]/.test(s) || s.includes('/'))) return undefined
      // A build that writes its files under `assets/form/` (apps/external-form) is served from there.
      return readAsset(root, segments) ?? readAsset(root, ['assets', 'form', ...segments])
    },
  }
}

function readAsset(root: string, segments: string[]): { data: ArrayBuffer; mime: string } | undefined {
  const file = resolve(root, ...segments)
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  try {
    const real = realpathSync(file)
    const realRel = relative(root, real)
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) return undefined
    if (!statSync(real).isFile()) return undefined
    const buf = readFileSync(real)
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, mime: mimeOf(real) }
  } catch {
    return undefined
  }
}

/**
 * The built form app, if it is anywhere it is usually found: `MEMWISE_FORM_APP_DIR`, then
 * `apps/external-form/dist` under the given roots (the app's resources, the repo root).
 */
export function findFormAppDir(roots: (string | undefined)[] = []): string | undefined {
  const env = process.env.MEMWISE_FORM_APP_DIR
  if (env && existsSync(join(env, 'index.html'))) return env
  for (const r of roots) {
    if (!r) continue
    for (const candidate of [join(r, 'external-form'), join(r, 'apps', 'external-form', 'dist'), join(r, 'memwise', 'external-form')]) {
      if (existsSync(join(candidate, 'index.html'))) return candidate
    }
  }
  return undefined
}
