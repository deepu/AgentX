/**
 * The public handler (23 §4, §7) against a fake kernel: every route, the headers each answer
 * carries, and every refusal (method, size, JSON, rate, no kernel, bad paths), with no token or
 * stack trace in what it answers or logs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelService, ExternalService } from '@memwise/runtime'
import { createPublicHandler, PUBLIC_CSP, rewriteShell, type PublicKernel } from '../public'

const TOKEN = 'mwl_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd'
const BASE = 'https://abcdefghijklmnop.relay.test'

type Call = { method: string; args: unknown[] }

function fakeKernel(over: Partial<ExternalService> = {}, channels: Partial<ChannelService> = {}) {
  const calls: Call[] = []
  const rec = (method: string, answer: unknown) => async (...args: unknown[]) => { calls.push({ method, args }); return answer }
  const external = {
    form: rec('form', { status: 'open', business: 'Acme', title: 'Your details', fields: [] }),
    saveDraft: rec('saveDraft', { savedAt: '2026-10-20T10:42:00.000Z' }),
    upload: rec('upload', { document: { id: 'file_1', name: 'pan-card.pdf', mime: 'application/pdf', size: 4 } }),
    extract: rec('extract', { suggestions: [] }),
    submit: rec('submit', { status: 'applied', message: 'Thank you.' }),
    inboxItem: rec('inboxItem', { status: 'open', title: 'Approve' }),
    decideInboxItem: rec('decideInboxItem', { status: 'applied', message: 'Done.' }),
    ...over,
  } as unknown as ExternalService
  const ch = {
    receiveWebhook: async (...args: unknown[]) => {
      calls.push({ method: 'receiveWebhook', args })
      const req = args[1] as { method: string; query: Record<string, string> }
      return req.method === 'GET' ? { status: 200, body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' } : { status: 200, body: 'ok' }
    },
    ...channels,
  } as unknown as ChannelService
  const kernel: PublicKernel = { external, channels: ch }
  return { kernel, calls }
}

let dist: string
beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'mw-form-dist-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="./assets/index-abc.js"></script><link rel="stylesheet" href="/assets/form/assets/index-abc.css"><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>')
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(dist, 'assets', 'index-abc.css'), 'body{}')
  writeFileSync(join(dist, 'assets', 'logo.svg'), '<svg/>')
})
afterAll(() => { rmSync(dist, { recursive: true, force: true }) })

function setup(over: Partial<ExternalService> = {}, opts: { kernel?: 'none'; ipLimit?: { count: number; perMs: number }; formAppDir?: string | null } = {}) {
  const { kernel, calls } = fakeKernel(over)
  const logged: string[] = []
  const log = { info: () => {}, warn: (...a: unknown[]) => logged.push(a.join(' ')), error: (...a: unknown[]) => logged.push(a.join(' ')) }
  const handle = createPublicHandler({
    kernel: () => (opts.kernel === 'none' ? null : kernel),
    ...(opts.formAppDir === null ? {} : { formAppDir: opts.formAppDir ?? dist }),
    log,
    ...(opts.ipLimit ? { ipLimit: opts.ipLimit } : {}),
  })
  const req = (method: string, path: string, init: { body?: string | Uint8Array | ReadableStream<Uint8Array>; headers?: Record<string, string> } = {}) =>
    handle(new Request(`${BASE}${path}`, { method, ...(init.body !== undefined ? { body: init.body } : {}), headers: { 'x-memwise-client-ip': '203.0.113.7', 'user-agent': 'phone', ...init.headers } }))
  const jsonReq = (method: string, path: string, body: unknown) =>
    req(method, path, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { handle, req, jsonReq, calls, logged }
}

function expectSecurityHeaders(r: Response) {
  expect(r.headers.get('content-security-policy')).toBe(PUBLIC_CSP)
  expect(r.headers.get('x-frame-options')).toBe('DENY')
  expect(r.headers.get('referrer-policy')).toBe('no-referrer')
  expect(r.headers.get('x-robots-tag')).toBe('noindex')
  expect(r.headers.get('x-content-type-options')).toBe('nosniff')
}

describe('the form page', () => {
  it('serves the shell with no data, relative asset URLs and strict headers', async () => {
    const { req, calls } = setup()
    const r = await req('GET', `/f/${TOKEN}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expectSecurityHeaders(r)
    const html = await r.text()
    expect(html).toContain('src="../assets/form/assets/index-abc.js"')
    expect(html).toContain('href="../assets/form/assets/index-abc.css"')
    expect(html).toContain('href="data:,"')
    expect(html).not.toContain(TOKEN)
    expect(calls).toEqual([]) // opening the page never touches the link
  })

  it('resolves the relative asset URLs under a subdomain and under a path alike', () => {
    const html = rewriteShell('<script src="./assets/a.js"></script>', '../')
    const src = /src="([^"]+)"/.exec(html)![1]!
    expect(new URL(src, `https://abcdefghijklmnop.relay.test/f/${TOKEN}`).pathname).toBe('/assets/form/assets/a.js')
    expect(new URL(src, `https://relay.test/x/abcdefghijklmnop/f/${TOKEN}`).pathname).toBe('/x/abcdefghijklmnop/assets/form/assets/a.js')
  })

  it('serves the same shell for inbox links', async () => {
    const { req } = setup()
    const r = await req('GET', `/i/${TOKEN}`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('../assets/form/assets/index-abc.js')
  })

  it('says the form is unavailable when the app is not built', async () => {
    const { req } = setup({}, { formAppDir: null })
    const r = await req('GET', `/f/${TOKEN}`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain("This form isn't available right now")
    expect(html).not.toContain('<script')
    expectSecurityHeaders(r)
  })

  it('serves built assets with their type and a long cache, and nothing outside the folder', async () => {
    const { req } = setup()
    const js = await req('GET', '/assets/form/assets/index-abc.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(await js.text()).toBe('console.log(1)')
    expect((await req('GET', '/assets/form/assets/index-abc.css')).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await req('GET', '/assets/form/assets/logo.svg')).headers.get('content-type')).toBe('image/svg+xml')
    expect((await req('GET', '/assets/form/index.html')).headers.get('cache-control')).toBe('no-store')
    expect((await req('GET', '/assets/form/assets/missing.js')).status).toBe(404)
    expect((await req('GET', '/assets/form/..%2f..%2fetc%2fpasswd')).status).toBe(404)
    expect((await req('GET', '/assets/form/assets/%2e%2e/%2e%2e/secret')).status).toBe(404)
    expect((await req('GET', '/assets/form/')).status).toBe(404)
    expect((await req('POST', '/assets/form/assets/index-abc.js')).status).toBe(405)
  })
})

describe('the form API', () => {
  it('GET api/form passes the token from the path and the client address', async () => {
    const { req, calls } = setup()
    const r = await req('GET', `/f/${TOKEN}/api/form`)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-type')).toContain('application/json')
    expectSecurityHeaders(r)
    expect((await r.json() as any).status).toBe('open')
    expect(calls).toEqual([{ method: 'form', args: [TOKEN, { ip: '203.0.113.7', userAgent: 'phone' }] }])
  })

  it('routes below the relay\'s path-mode prefix (the tunnel passes the full public URL)', async () => {
    const { kernel, calls } = fakeKernel()
    const handle = createPublicHandler({ kernel: () => kernel, formAppDir: dist })
    const r = await handle(new Request(`http://localhost:8788/x/abcdefghijklmnop/f/${TOKEN}/api/form`))
    expect(r.status).toBe(200)
    expect(calls[0]!.args[0]).toBe(TOKEN)
    const page = await handle(new Request(`http://localhost:8788/x/abcdefghijklmnop/f/${TOKEN}`))
    expect(await page.text()).toContain('../assets/form/assets/index-abc.js')
    expect((await handle(new Request('http://localhost:8788/x/abcdefghijklmnop/assets/form/assets/index-abc.js'))).status).toBe(200)
    expect((await handle(new Request(`http://localhost:8788/x/not-an-install/f/${TOKEN}/api/form`))).status).toBe(404)
  })

  it('answers a refusal from the kernel as it is', async () => {
    const { req } = setup({ form: async () => ({ status: 'expired', message: 'This link has expired.' }) } as Partial<ExternalService>)
    const r = await req('GET', `/f/${TOKEN}/api/form`)
    expect(r.status).toBe(200)
    expect(await r.json() as any).toEqual({ status: 'expired', message: 'This link has expired.' })
  })

  it('answers a token that cannot be one as unknown, without asking the kernel', async () => {
    const { req, calls } = setup()
    const r = await req('GET', '/f/bad!token/api/form')
    expect((await r.json() as any).status).toBe('unknown')
    expect(calls).toEqual([])
  })

  it('PUT api/draft saves the values', async () => {
    const { jsonReq, calls } = setup()
    const r = await jsonReq('PUT', `/f/${TOKEN}/api/draft`, { values: { pan: 'AAACM1234M' } })
    expect(await r.json() as any).toEqual({ savedAt: '2026-10-20T10:42:00.000Z' })
    expect(calls[0]).toEqual({ method: 'saveDraft', args: [TOKEN, { pan: 'AAACM1234M' }, { ip: '203.0.113.7', userAgent: 'phone' }] })
  })

  it('POST api/files passes the raw bytes, the name and the type', async () => {
    const { req, calls } = setup()
    const r = await req('POST', `/f/${TOKEN}/api/files?name=${encodeURIComponent('C:\\Users\\asha\\pan-card.pdf')}`, {
      body: new Uint8Array([37, 80, 68, 70]), headers: { 'content-type': 'application/pdf; charset=binary' },
    })
    expect((await r.json() as any).document.id).toBe('file_1')
    const [token, file] = calls[0]!.args as [string, { name: string; mime: string; data: Uint8Array }]
    expect(token).toBe(TOKEN)
    expect(file.name).toBe('pan-card.pdf')
    expect(file.mime).toBe('application/pdf')
    expect([...file.data]).toEqual([37, 80, 68, 70])
  })

  it('refuses an upload without a name, and one over 15 MiB while it streams in', async () => {
    const { req, calls } = setup()
    expect((await req('POST', `/f/${TOKEN}/api/files`, { body: 'x' })).status).toBe(400)
    const big = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 16; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close() },
    })
    const r = await req('POST', `/f/${TOKEN}/api/files?name=big.pdf`, { body: big })
    expect(r.status).toBe(413)
    expect((await r.json() as any).message).toContain('15 MB')
    const declared = await req('POST', `/f/${TOKEN}/api/files?name=big.pdf`, { body: 'x', headers: { 'content-length': String(20 * 1024 * 1024) } })
    expect(declared.status).toBe(413)
    expect(calls).toEqual([])
  })

  it('POST api/extract and api/submit pass their bodies', async () => {
    const { jsonReq, calls } = setup()
    expect((await (await jsonReq('POST', `/f/${TOKEN}/api/extract`, { documents: ['file_1'] })).json() as any)).toEqual({ suggestions: [] })
    const s = await jsonReq('POST', `/f/${TOKEN}/api/submit`, { outcome: 'submitted', values: { pan: 'X' }, sources: { pan: 'sug_1' } })
    expect((await s.json() as any).status).toBe('applied')
    expect(calls.map((c) => c.method)).toEqual(['extract', 'submit'])
    expect(calls[0]!.args[1]).toEqual({ documents: ['file_1'] })
    expect(calls[1]!.args[1]).toEqual({ outcome: 'submitted', values: { pan: 'X' }, sources: { pan: 'sug_1' } })
  })

  it('refuses bodies that are not the expected JSON', async () => {
    const { req, jsonReq, calls } = setup()
    expect((await req('PUT', `/f/${TOKEN}/api/draft`, { body: '{not json' })).status).toBe(400)
    expect((await jsonReq('PUT', `/f/${TOKEN}/api/draft`, { values: 'x' })).status).toBe(400)
    expect((await jsonReq('PUT', `/f/${TOKEN}/api/draft`, [1, 2])).status).toBe(400)
    expect((await jsonReq('POST', `/f/${TOKEN}/api/extract`, { documents: [1] })).status).toBe(400)
    expect((await jsonReq('POST', `/f/${TOKEN}/api/submit`, { values: {}, sources: { a: 1 } })).status).toBe(400)
    expect((await jsonReq('POST', `/f/${TOKEN}/api/submit`, { values: {}, outcome: 3 })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('refuses a JSON body over 256 KiB', async () => {
    const { jsonReq } = setup()
    const r = await jsonReq('PUT', `/f/${TOKEN}/api/draft`, { values: { note: 'x'.repeat(300 * 1024) } })
    expect(r.status).toBe(413)
  })

  it('checks methods', async () => {
    const { req } = setup()
    const wrong: [string, string][] = [
      ['POST', `/f/${TOKEN}/api/form`], ['GET', `/f/${TOKEN}/api/draft`], ['GET', `/f/${TOKEN}/api/files`],
      ['GET', `/f/${TOKEN}/api/extract`], ['PUT', `/f/${TOKEN}/api/submit`], ['POST', `/f/${TOKEN}`], ['DELETE', `/i/${TOKEN}`],
      ['POST', `/i/${TOKEN}/api/item`], ['GET', `/i/${TOKEN}/api/decide`], ['PUT', '/h/hk_abcdef'],
    ]
    for (const [method, path] of wrong) {
      const r = await req(method, path)
      expect([method, path, r.status]).toEqual([method, path, 405])
      expect(r.headers.get('allow')).toBeTruthy()
    }
  })

  it('answers 404 for anything else', async () => {
    const { req } = setup()
    for (const path of ['/', '/api/form', `/f/${TOKEN}/api/other`, `/f/${TOKEN}/api/form/x`, '/x/abc/f/t', '/health', '/f/', '/h/', '/h/a/b']) {
      expect([path, (await req('GET', path)).status]).toEqual([path, 404])
    }
  })

  it('answers 503 while the kernel is not running', async () => {
    const { req, jsonReq } = setup({}, { kernel: 'none' })
    expect((await req('GET', `/f/${TOKEN}/api/form`)).status).toBe(503)
    expect((await jsonReq('POST', `/i/${TOKEN}/api/decide`, { outcome: 'approved' })).status).toBe(503)
    expect((await req('POST', '/h/hk_abcdef', { body: '{}' })).status).toBe(503)
    // The page itself still loads, and says what it can.
    expect((await req('GET', `/f/${TOKEN}`)).status).toBe(200)
  })

  it('never leaks a stack trace or the token when the kernel throws', async () => {
    const { req, logged } = setup({ form: async () => { throw new Error('database is down') } } as Partial<ExternalService>)
    const r = await req('GET', `/f/${TOKEN}/api/form`)
    expect(r.status).toBe(500)
    const text = await r.text()
    expect(text).not.toContain('database')
    expect(text).not.toContain('at ')
    expect(JSON.parse(text).message).toBe('Something went wrong. Please try again.')
    expect(logged.join('\n')).toContain('database is down')
    expect(logged.join('\n')).not.toContain(TOKEN)
  })
})

describe('inbox links', () => {
  it('GET api/item and POST api/decide', async () => {
    const { req, jsonReq, calls } = setup()
    expect((await (await req('GET', `/i/${TOKEN}/api/item`)).json() as any).status).toBe('open')
    const d = await jsonReq('POST', `/i/${TOKEN}/api/decide`, { outcome: 'sent_back', comment: 'Fix the PAN' })
    expect((await d.json() as any).status).toBe('applied')
    expect(calls[1]).toEqual({ method: 'decideInboxItem', args: [TOKEN, { outcome: 'sent_back', comment: 'Fix the PAN' }, { ip: '203.0.113.7', userAgent: 'phone' }] })
    expect((await jsonReq('POST', `/i/${TOKEN}/api/decide`, { comment: 'no outcome' })).status).toBe(400)
  })
})

describe('webhooks', () => {
  it('passes method, query, lower-cased headers and the raw body', async () => {
    const { req, calls } = setup()
    const r = await req('POST', '/h/hk_abcdef?x=1', { body: '{"entry":[]}', headers: { 'X-Hub-Signature-256': 'sha256=abc', 'content-type': 'application/json' } })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('ok')
    const [hookId, got] = calls[0]!.args as [string, { method: string; query: Record<string, string>; headers: Record<string, string>; body: Uint8Array }]
    expect(hookId).toBe('hk_abcdef')
    expect(got.method).toBe('POST')
    expect(got.query).toEqual({ x: '1' })
    expect(got.headers['x-hub-signature-256']).toBe('sha256=abc')
    expect(new TextDecoder().decode(got.body)).toBe('{"entry":[]}')
  })

  it('answers the verification handshake on GET', async () => {
    const { req } = setup()
    const r = await req('GET', '/h/hk_abcdef?hub.mode=subscribe&hub.verify_token=t&hub.challenge=12345')
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('12345')
  })
})

describe('client addresses and the per-address limit', () => {
  it('counts per client address and refuses with 429 past the limit', async () => {
    const { req } = setup({}, { ipLimit: { count: 3, perMs: 60_000 } })
    for (let i = 0; i < 3; i++) expect((await req('GET', `/f/${TOKEN}/api/form`)).status).toBe(200)
    const over = await req('GET', `/f/${TOKEN}/api/form`)
    expect(over.status).toBe(429)
    expect((await over.json() as any).status).toBe('rate_limited')
    // Another address is not affected; assets are not counted.
    expect((await req('GET', `/f/${TOKEN}/api/form`, { headers: { 'x-memwise-client-ip': '198.51.100.1' } })).status).toBe(200)
    expect((await req('GET', '/assets/form/assets/index-abc.js')).status).toBe(200)
  })

  it('prefers the socket address the direct listener passes over the header', async () => {
    const { kernel, calls } = fakeKernel()
    const handle = createPublicHandler({ kernel: () => kernel })
    await handle(new Request(`${BASE}/f/${TOKEN}/api/form`, { headers: { 'x-memwise-client-ip': '1.2.3.4' } }), { ip: '10.0.0.9' })
    expect((calls[0]!.args[1] as { ip: string }).ip).toBe('10.0.0.9')
  })
})
