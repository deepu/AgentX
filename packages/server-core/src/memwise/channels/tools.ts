/**
 * The real channel tools (23 §6), as builtins for plugin routes: `examples/plugins/email-smtp`
 * binds `email.send` to `email.smtp.send`, `examples/plugins/whatsapp-cloud` binds
 * `whatsapp.send` to `whatsapp.cloud.send`. They are not bound under their own names: the kernel
 * and the playbooks call the fixed channel names, and the domain's binding says which provider
 * answers to them (one email provider at a time).
 *
 * Settings come from the gateway's secrets when it injects them, else this process's environment
 * (`SMTP_*`, `WHATSAPP_*`). Both are `outbound` and idempotent on the call's key.
 */
import type { EffectPreview } from '@memwise/defs'
import type { ToolContext, ToolDefinition } from '@memwise/gateway'
import { addressOf, messageIdFor, sendMail, type SmtpSecurity, type SmtpSettings } from './smtp'
import { memorySentStore, type SentStore } from './sent'
import { sendWhatsApp, type WhatsAppSettings, type WhatsAppTemplate } from './whatsapp'

/** The plugin ids that route to these builtins. */
export const EMAIL_SMTP_PLUGIN = 'memwise/email-smtp'
export const WHATSAPP_CLOUD_PLUGIN = 'memwise/whatsapp-cloud'
/** Builtin names (`run: { builtin: … }`). */
export const EMAIL_SMTP_BUILTIN = 'email.smtp.send'
export const WHATSAPP_CLOUD_BUILTIN = 'whatsapp.cloud.send'

export const DEFAULT_WHATSAPP_API_BASE = 'https://graph.facebook.com/v21.0'

export interface ChannelToolsOptions {
  /** Where settings come from when the gateway injects none; default `process.env`. */
  env?: Record<string, string | undefined>
  /** What was sent, by key; default in memory (service.ts passes the kernel database's). */
  sent?: SentStore
  /** Tests: the fetch the WhatsApp tool calls. */
  fetch?: typeof fetch
  /** Tests: options passed to node:tls (a self-signed certificate). */
  tlsOptions?: SmtpSettings['tlsOptions']
}

type Setting = (name: string) => string | undefined

function settingsOf(ctx: ToolContext, env: Record<string, string | undefined>): Setting {
  return (name) => {
    const v = ctx.secrets?.[name] ?? env[name]
    return v === undefined || v === '' ? undefined : v
  }
}

/** SMTP settings, or plain words on what is missing. */
export function smtpSettings(get: Setting): SmtpSettings {
  const host = get('SMTP_HOST')
  const from = get('SMTP_FROM')
  const missing = [!host && 'SMTP_HOST', !from && 'SMTP_FROM'].filter(Boolean)
  if (missing.length) throw new Error(`Email is not set up: set ${missing.join(' and ')} (see the email-smtp plugin's README).`)
  const raw = (get('SMTP_SECURE') ?? '').toLowerCase()
  const portText = get('SMTP_PORT')
  const port = portText ? Number(portText) : undefined
  if (portText && (!Number.isInteger(port) || port! <= 0 || port! > 65535)) throw new Error(`SMTP_PORT is not a port number: ${portText}`)
  // The usual pairing: 465 is TLS from the start, 587 (and the rest) upgrade with STARTTLS.
  const secure: SmtpSecurity = raw === 'tls' || raw === 'true' || raw === 'ssl' ? 'tls'
    : raw === 'none' || raw === 'false' || raw === 'plain' ? 'none'
      : raw === 'starttls' ? 'starttls'
        : raw ? (() => { throw new Error(`SMTP_SECURE must be tls, starttls or none (not ${raw}).`) })()
          : port === 465 ? 'tls' : 'starttls'
  const user = get('SMTP_USER')
  const password = get('SMTP_PASSWORD')
  return {
    host: host!, port: port ?? (secure === 'tls' ? 465 : 587), secure, from: from!,
    ...(user ? { user } : {}), ...(password ? { password } : {}),
  }
}

export function whatsAppSettings(get: Setting): WhatsAppSettings {
  const token = get('WHATSAPP_TOKEN')
  const phoneNumberId = get('WHATSAPP_PHONE_NUMBER_ID')
  const missing = [!token && 'WHATSAPP_TOKEN', !phoneNumberId && 'WHATSAPP_PHONE_NUMBER_ID'].filter(Boolean)
  if (missing.length) throw new Error(`WhatsApp is not set up: set ${missing.join(' and ')} (see the whatsapp-cloud plugin's README).`)
  return { token: token!, phoneNumberId: phoneNumberId!, apiBase: get('WHATSAPP_API_BASE') ?? DEFAULT_WHATSAPP_API_BASE }
}

type Email = { to: string; subject: string; body: string; html?: string }
type WhatsApp = { to: string; body?: string; template?: WhatsAppTemplate }

export const EMAIL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'The recipient, `name@example.com` or `Asha Rao <asha@example.com>`; several separated by commas.' },
    subject: { type: 'string' },
    body: { type: 'string', description: 'The message as plain text.' },
    html: { type: 'string', description: 'The same message as HTML (sent as an alternative to the text).' },
  },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
} as const

export const WHATSAPP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: 'string', description: 'The phone number in international form, +919876543210.' },
    body: { type: 'string', description: 'A text message (only inside the 24 hours after the person last wrote).' },
    template: {
      type: 'object',
      description: 'An approved message template: its name, language code and the values for its placeholders.',
      properties: {
        name: { type: 'string' },
        language: { type: 'string' },
        params: {
          description: 'Values for {{1}}, {{2}}… in order, or by name for templates with named placeholders.',
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', additionalProperties: { type: 'string' } }],
        },
      },
      required: ['name', 'language'],
      additionalProperties: false,
    },
  },
  required: ['to'],
  additionalProperties: false,
} as const

function recipients(to: string): string[] {
  // Commas inside a quoted display name are not separators.
  return (to.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

export function channelTools(opts: ChannelToolsOptions = {}): ToolDefinition[] {
  const env = opts.env ?? process.env
  const sent = opts.sent ?? memorySentStore()

  const email: ToolDefinition<Email> = {
    name: EMAIL_SMTP_BUILTIN,
    description: 'Send an email through the SMTP server set up for this install.',
    inputSchema: EMAIL_INPUT_SCHEMA as unknown as Record<string, unknown>,
    effect: 'outbound',
    idempotent: true,
    source: { plugin: EMAIL_SMTP_PLUGIN },
    preview: ({ to, subject, body }): EffectPreview => ({ summary: `Email to ${to}: ${subject}`, detail: { to, subject, body } }),
    async execute({ to, subject, body, html }, ctx) {
      const key = ctx.idempotencyKey
      const before = await sent.get(key)
      if (before) return { ...before, replayed: true }
      const settings = { ...smtpSettings(settingsOf(ctx, env)), ...(opts.tlsOptions ? { tlsOptions: opts.tlsOptions } : {}) }
      const list = recipients(to)
      const r = await sendMail(settings, {
        to: list, subject, text: body, ...(html ? { html } : {}),
        messageId: messageIdFor(key, settings.from),
        headers: { 'X-MemWise-Idempotency-Key': key },
      })
      const result = { message_id: r.messageId, accepted: r.accepted, from: addressOf(settings.from) }
      await sent.put(key, EMAIL_SMTP_BUILTIN, result)
      return result
    },
  }

  const whatsapp: ToolDefinition<WhatsApp> = {
    name: WHATSAPP_CLOUD_BUILTIN,
    description: 'Send a WhatsApp message through the WhatsApp Business Cloud API: an approved template, or text inside the 24-hour window.',
    inputSchema: WHATSAPP_INPUT_SCHEMA as unknown as Record<string, unknown>,
    effect: 'outbound',
    idempotent: true,
    source: { plugin: WHATSAPP_CLOUD_PLUGIN },
    preview: ({ to, body, template }): EffectPreview => ({
      summary: template ? `WhatsApp to ${to}: template ${template.name}` : `WhatsApp to ${to}`,
      detail: { to, ...(body !== undefined ? { body } : {}), ...(template ? { template } : {}) },
    }),
    async execute(args, ctx) {
      const key = ctx.idempotencyKey
      const before = await sent.get(key)
      if (before) return { ...before, replayed: true }
      const settings = whatsAppSettings(settingsOf(ctx, env))
      const r = await sendWhatsApp(settings, args, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) })
      const result = { message_id: r.messageId, to: r.to }
      await sent.put(key, WHATSAPP_CLOUD_BUILTIN, result)
      return result
    },
  }

  return [email, whatsapp]
}
