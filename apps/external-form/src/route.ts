/**
 * Where the page is: a form link (`/f/<token>`), an inbox link (`/i/<token>`) or an inspector's
 * read-only view (`/v/<token>`, Stage 5), under any base
 * (`https://<id>.relay`, `https://relay/x/<id>`, a server's own address). The API is next to it.
 */

export interface Route {
  kind: 'form' | 'inbox' | 'inspector'
  token: string
  /** The path the API calls start with: `<base>/f/<token>/api` (no trailing slash). */
  api: string
}

const LINK = /^(.*?)\/(f|i|v)\/([A-Za-z0-9_-]+)\/?$/
const KINDS = { f: 'form', i: 'inbox', v: 'inspector' } as const

export function parseRoute(pathname: string): Route | null {
  const m = LINK.exec(pathname)
  if (!m) return null
  const [, base = '', letter, token = ''] = m
  return { kind: KINDS[letter as keyof typeof KINDS], token, api: `${base}/${letter}/${token}/api` }
}
