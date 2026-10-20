/**
 * The page's only connection: the link's own API next to it (`<base>/f/<token>/api/…`,
 * `<base>/i/<token>/api/…`, 23 §4). No cookies, nothing stored in the browser.
 */

import type {
  ExternalDocument,
  ExternalFormAnswer,
  ExternalSubmitInput,
  ExternalSubmitResult,
  ExtractResult,
  InboxLinkAnswer,
  InboxLinkDecision,
  InboxLinkResult,
  LinkRefusal,
} from '@memwise/defs/external'

/** The request didn't get a usable answer: no connection, or the business's system is away. */
export class Unreachable extends Error {
  constructor(readonly reason: 'offline' | 'network' | 'unavailable', message?: string) {
    super(message ?? reason)
  }
}

const REFUSALS = new Set<LinkRefusal['status']>(['unknown', 'expired', 'used', 'closed', 'revoked', 'not_yet', 'rate_limited'])

export function isRefusal(v: unknown): v is LinkRefusal {
  return typeof v === 'object' && v !== null && REFUSALS.has((v as { status?: unknown }).status as LinkRefusal['status'])
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    })
  } catch {
    throw new Unreachable(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'network')
  }
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    // The relay's own pages (the app is offline, 503) and proxies' errors are HTML.
    throw new Unreachable(res.status === 429 ? 'network' : 'unavailable', `HTTP ${res.status}`)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new Unreachable('unavailable', 'bad JSON')
  }
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

export interface FormApi {
  form(): Promise<ExternalFormAnswer>
  saveDraft(values: Record<string, unknown>): Promise<{ savedAt: string } | LinkRefusal>
  upload(file: File, onProgress?: (fraction: number) => void): Promise<{ document: ExternalDocument } | LinkRefusal | { status: 'invalid'; message: string }>
  extract(documents: string[]): Promise<ExtractResult | LinkRefusal>
  submit(input: ExternalSubmitInput): Promise<ExternalSubmitResult>
}

export function formApi(base: string): FormApi {
  return {
    form: () => call(`${base}/form`),
    saveDraft: values => call(`${base}/draft`, { method: 'PUT', ...json({ values }) }),
    upload: (file, onProgress) => uploadFile(`${base}/files?name=${encodeURIComponent(file.name)}`, file, onProgress),
    extract: documents => call(`${base}/extract`, { method: 'POST', ...json({ documents }) }),
    submit: input => call(`${base}/submit`, { method: 'POST', ...json(input) }),
  }
}

export interface InboxApi {
  item(): Promise<InboxLinkAnswer>
  decide(decision: InboxLinkDecision): Promise<InboxLinkResult>
}

export function inboxApi(base: string): InboxApi {
  return {
    item: () => call(`${base}/item`),
    decide: decision => call(`${base}/decide`, { method: 'POST', ...json(decision) }),
  }
}

/** fetch can't report upload progress; XMLHttpRequest can. Raw bytes, the file's own type. */
function uploadFile<T>(url: string, file: File, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = false
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('accept', 'application/json')
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total) }
    xhr.onerror = () => reject(new Unreachable(navigator.onLine === false ? 'offline' : 'network'))
    xhr.ontimeout = () => reject(new Unreachable('network'))
    xhr.onload = () => {
      const type = xhr.getResponseHeader('content-type') ?? ''
      if (!type.includes('json')) { reject(new Unreachable('unavailable', `HTTP ${xhr.status}`)); return }
      try {
        resolve(JSON.parse(xhr.responseText) as T)
      } catch {
        reject(new Unreachable('unavailable', 'bad JSON'))
      }
    }
    xhr.send(file)
  })
}
