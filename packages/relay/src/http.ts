// Small HTTP helpers for the answers the relay gives itself: plain pages, JSON and the
// security headers every answer carries. Runtime-free.
import type { Headers2 } from './protocol.ts';

/** Headers set on everything the relay answers for a core. */
export const RESPONSE_SECURITY_HEADERS: Headers2 = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-robots-tag', 'noindex'],
];

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A small, phone-friendly page in light and dark, with no scripts or outside files. */
export function plainPage(title: string, message: string, extraBody = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg: #f7f7f5; --card: #ffffff; --text: #1f2328; --muted: #57606a; --line: #d8dee4; --accent: #2f6feb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111315; --card: #1b1e22; --text: #e6e8eb; --muted: #9aa4ae; --line: #30363d; --accent: #6ea8fe; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
    background: var(--bg); color: var(--text); font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px 24px; }
  h1 { font-size: 21px; line-height: 1.3; margin: 0 0 10px; }
  p { margin: 0; color: var(--muted); }
  form { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; }
  input { font: inherit; padding: 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  button { font: inherit; padding: 12px; border-radius: 10px; border: 0; background: var(--accent); color: #fff; font-weight: 600; }
  .error { color: #cf222e; margin-top: 12px; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>${extraBody}
</main>
</body>
</html>
`;
}

const PLAIN_PAGE_HEADERS: Headers2 = [
  ['content-type', 'text/html; charset=utf-8'],
  ['cache-control', 'no-store'],
  ['content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"],
  ...RESPONSE_SECURITY_HEADERS,
];

export function htmlResponse(status: number, title: string, message: string, extra?: { body?: string; headers?: Headers2 }): Response {
  return new Response(plainPage(title, message, extra?.body), { status, headers: [...PLAIN_PAGE_HEADERS, ...(extra?.headers ?? [])] });
}

export function jsonResponse(status: number, value: unknown, headers: Headers2 = []): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: [['content-type', 'application/json; charset=utf-8'], ['cache-control', 'no-store'], ...RESPONSE_SECURITY_HEADERS, ...headers],
  });
}

const wantsJson = (path: string, method: string) => path.includes('/api/') || path.startsWith('/h/') || (method !== 'GET' && method !== 'HEAD');

/** A plain refusal: JSON for API calls and webhooks, a page for people. */
export function refusal(path: string, method: string, status: number, code: string, title: string, message: string, headers: Headers2 = []): Response {
  return wantsJson(path, method) ? jsonResponse(status, { error: code, message }, headers) : htmlResponse(status, title, message, { headers });
}

