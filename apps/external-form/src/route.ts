/**
 * Where the page is: a form link (`/f/<token>`) or an inbox link (`/i/<token>`), under any base
 * (`https://<id>.relay`, `https://relay/x/<id>`, a server's own address). The API is next to it.
 */

export interface Route {
  kind: 'form' | 'inbox'
  token: string
  /** The path the API calls start with: `<base>/f/<token>/api` (no trailing slash). */
  api: string
}

const LINK = /^(.*?)\/(f|i)\/([A-Za-z0-9_-]+)\/?$/

export function parseRoute(pathname: string): Route | null {
  const m = LINK.exec(pathname)
  if (!m) return null
  const [, base = '', letter, token = ''] = m
  return { kind: letter === 'f' ? 'form' : 'inbox', token, api: `${base}/${letter}/${token}/api` }
}
