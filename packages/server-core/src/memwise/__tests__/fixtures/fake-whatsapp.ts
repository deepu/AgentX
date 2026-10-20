/**
 * A local fake of the WhatsApp Business Cloud API for tests: `POST /<version>/<phone-number-id>/messages`
 * with a bearer token, answering like the Graph API (`{ messaging_product, contacts, messages: [{ id }] }`)
 * and recording what it was sent. Point `WHATSAPP_API_BASE` at `fake.apiBase`.
 *
 *   const wa = await startFakeWhatsApp({ token: 't', phoneNumberId: '1065' })
 *   … WHATSAPP_API_BASE=${wa.apiBase} …
 *   wa.messages[0].body.template.name
 *   await wa.close()
 */

export interface FakeWhatsAppMessage {
  id: string
  phoneNumberId: string
  /** The JSON the client posted. */
  body: { to: string; type: 'text' | 'template'; text?: { body: string }; template?: { name: string; language: { code: string }; components?: unknown[] } } & Record<string, unknown>
  receivedAt: number
}

export interface FakeWhatsApp {
  apiBase: string
  messages: FakeWhatsAppMessage[]
  /** Answer the next request with this Graph API error instead. */
  failNext(error: { status: number; message: string; code?: number }): void
  close(): Promise<void>
}

export async function startFakeWhatsApp(opts: { token: string; phoneNumberId: string; version?: string }): Promise<FakeWhatsApp> {
  const version = opts.version ?? 'v21.0'
  const messages: FakeWhatsAppMessage[] = []
  let failure: { status: number; message: string; code?: number } | undefined
  const error = (status: number, message: string, code = 100) =>
    Response.json({ error: { message, type: 'OAuthException', code, fbtrace_id: 'fake' } }, { status })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const m = new RegExp(`^/${version.replace('.', '\\.')}/([^/]+)/messages$`).exec(url.pathname)
      if (!m || req.method !== 'POST') return error(404, 'Unknown path components')
      if (req.headers.get('authorization') !== `Bearer ${opts.token}`) return error(401, 'Invalid OAuth access token.', 190)
      if (m[1] !== opts.phoneNumberId) return error(400, `Unsupported post request. Object with ID '${m[1]}' does not exist`)
      if (failure) { const f = failure; failure = undefined; return error(f.status, f.message, f.code) }
      let body: FakeWhatsAppMessage['body']
      try { body = await req.json() as FakeWhatsAppMessage['body'] } catch { return error(400, 'Invalid JSON') }
      if (body.messaging_product !== 'whatsapp') return error(400, 'The parameter messaging_product is required.')
      if (!/^\d{7,15}$/.test(String(body.to))) return error(400, 'Invalid parameter: to', 131009)
      if (body.type === 'text' && !body.text?.body) return error(400, 'The parameter text[body] is required.')
      if (body.type === 'template' && !body.template?.name) return error(400, 'The parameter template[name] is required.')
      const id = `wamid.FAKE${String(messages.length + 1).padStart(6, '0')}`
      messages.push({ id, phoneNumberId: m[1]!, body, receivedAt: Date.now() })
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id }] })
    },
  })
  return {
    apiBase: `http://127.0.0.1:${server.port}/${version}`,
    messages,
    failNext(f) { failure = f },
    close: async () => { server.stop(true) },
  }
}
