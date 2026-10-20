/**
 * The WhatsApp Business Cloud API, the one call the channel needs (23 §6): POST
 * `<api>/<phone-number-id>/messages` with a text or an approved template.
 */

export interface WhatsAppSettings {
  token: string
  phoneNumberId: string
  /** `https://graph.facebook.com/v21.0`, or a local fake in tests. */
  apiBase: string
}

export interface WhatsAppTemplate {
  name: string
  /** `en`, `en_US`, `hi`. */
  language: string
  /** Positional values for {{1}}, {{2}}…, or named ones. */
  params?: string[] | Record<string, string>
}

export interface WhatsAppMessage { to: string; body?: string; template?: WhatsAppTemplate }

export interface WhatsAppResult { messageId: string; to: string }

/** `+91 98765-43210` → `919876543210` (the API takes digits, country code first). */
export function phoneDigits(to: string): string {
  const digits = to.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '')
  if (!/^\d{7,15}$/.test(digits)) throw new Error(`That is not a phone number in international form (like +919876543210): ${to}`)
  return digits
}

/** The request body the API takes. */
export function messagePayload(msg: WhatsAppMessage): Record<string, unknown> {
  const to = phoneDigits(msg.to)
  if (msg.template) {
    const params = msg.template.params
    const parameters = Array.isArray(params)
      ? params.map((text) => ({ type: 'text', text: String(text) }))
      : params ? Object.entries(params).map(([name, text]) => ({ type: 'text', parameter_name: name, text: String(text) })) : []
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: {
        name: msg.template.name, language: { code: msg.template.language },
        ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
      },
    }
  }
  if (!msg.body?.trim()) throw new Error('A WhatsApp message needs a body or a template.')
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: msg.body } }
}

export async function sendWhatsApp(
  settings: WhatsAppSettings, msg: WhatsAppMessage, opts: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WhatsAppResult> {
  const payload = messagePayload(msg)
  const url = `${settings.apiBase.replace(/\/+$/, '')}/${encodeURIComponent(settings.phoneNumberId)}/messages`
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (e) {
    throw new Error(`Could not reach the WhatsApp API: ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  let data: { messages?: { id?: string }[]; contacts?: { wa_id?: string }[]; error?: { message?: string; code?: number } } = {}
  try { data = text ? JSON.parse(text) : {} } catch { /* not JSON: reported below */ }
  if (!res.ok || data.error) {
    const why = data.error?.message ?? (text.slice(0, 200) || `status ${res.status}`)
    throw new Error(`WhatsApp refused the message (${res.status}${data.error?.code ? `, code ${data.error.code}` : ''}): ${why}`)
  }
  const id = data.messages?.[0]?.id
  if (!id) throw new Error('The WhatsApp API accepted the message but returned no message id.')
  return { messageId: id, to: data.contacts?.[0]?.wa_id ?? String(payload.to) }
}
