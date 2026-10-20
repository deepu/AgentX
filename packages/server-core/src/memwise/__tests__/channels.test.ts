/**
 * The channel plugins' builtins (23 §6): the SMTP client against a local sink (plain, sign-in
 * with PLAIN and LOGIN, STARTTLS when openssl can make a certificate, HTML, dot-stuffing,
 * refusals) and the WhatsApp client against a local fake of the Graph API, both idempotent on
 * the call's key.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, ToolDefinition } from '@memwise/gateway'
import {
  buildMessage, channelTools, dotStuff, EMAIL_SMTP_BUILTIN, memorySentStore, messageIdFor, messagePayload, phoneDigits, sendMail,
  smtpSettings, WHATSAPP_CLOUD_BUILTIN,
} from '../channels'
import { htmlOf, startSmtpSink, subjectOf, textOf, type SmtpSink } from './fixtures/smtp-sink'
import { startFakeWhatsApp, type FakeWhatsApp } from './fixtures/fake-whatsapp'

const teardown: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
})

const ctx = (key: string, secrets: Record<string, string> = {}): ToolContext => ({
  idempotencyKey: key, secrets, token: { stepRunId: 'sr_1' } as ToolContext['token'],
})

async function sink(opts: Parameters<typeof startSmtpSink>[0] = {}): Promise<SmtpSink> {
  const s = await startSmtpSink(opts)
  teardown.push(() => s.close())
  return s
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no ${name}`)
  return t
}

/** A self-signed certificate for 127.0.0.1, if openssl is here. */
function selfSigned(): { key: string; cert: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'mw-smtp-cert-'))
  try {
    const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stderr: 'pipe', stdout: 'pipe' })
    if (r.exitCode !== 0) return undefined
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the SMTP message', () => {
  it('stuffs dots and ends with CRLF.CRLF', () => {
    expect(dotStuff('a\n.b\r\n..c')).toBe('a\r\n..b\r\n...c\r\n.\r\n')
  })

  it('derives a stable Message-ID from the key', () => {
    const a = messageIdFor('wf:1:step', 'MemWise <noreply@acme.example>')
    expect(a).toBe(messageIdFor('wf:1:step', 'noreply@acme.example'))
    expect(a).not.toBe(messageIdFor('wf:2:step', 'noreply@acme.example'))
    expect(a).toMatch(/^<[0-9a-f]{32}\.memwise@acme\.example>$/)
  })

  it('keeps header values on one line', () => {
    const m = buildMessage('a@b.c', { to: ['x@y.z'], subject: 'Hi\r\nBcc: evil@x.y', text: 'body', messageId: '<1@b.c>' })
    expect(m).not.toContain('\r\nBcc:')
    expect(m).toContain('Subject: Hi Bcc: evil@x.y')
  })
})

describe('SMTP settings', () => {
  it('needs a host and a sender, and pairs the port with the security', () => {
    const get = (env: Record<string, string>) => (n: string) => env[n]
    expect(() => smtpSettings(get({}))).toThrow('set SMTP_HOST and SMTP_FROM')
    expect(smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y' }))).toMatchObject({ port: 587, secure: 'starttls' })
    expect(smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y', SMTP_PORT: '465' }))).toMatchObject({ port: 465, secure: 'tls' })
    expect(smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y', SMTP_SECURE: 'tls' }))).toMatchObject({ port: 465, secure: 'tls' })
    expect(smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y', SMTP_SECURE: 'none', SMTP_PORT: '25' }))).toMatchObject({ port: 25, secure: 'none' })
    expect(() => smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y', SMTP_SECURE: 'maybe' }))).toThrow('SMTP_SECURE')
    expect(() => smtpSettings(get({ SMTP_HOST: 'h', SMTP_FROM: 'f@x.y', SMTP_PORT: 'x' }))).toThrow('SMTP_PORT')
  })
})

describe('the SMTP client against a local sink', () => {
  it('sends a plain message', async () => {
    const s = await sink()
    const r = await sendMail({ host: s.host, port: s.port, secure: 'none', from: 'MemWise <noreply@acme.example>' }, {
      to: ['Asha Rao <asha@example.com>'], subject: 'Your details for Acme', text: 'Hello Asha,\n.\nOpen https://x.relay/f/mwl_abc\n', messageId: '<m1@acme.example>',
      headers: { 'X-MemWise-Idempotency-Key': 'k1' },
    })
    expect(r.accepted).toEqual(['asha@example.com'])
    const m = await s.waitFor(() => true)
    expect(m.from).toBe('noreply@acme.example')
    expect(m.to).toEqual(['asha@example.com'])
    expect(m.headers['message-id']).toBe('<m1@acme.example>')
    expect(m.headers['x-memwise-idempotency-key']).toBe('k1')
    expect(m.headers.to).toBe('"Asha Rao" <asha@example.com>')
    expect(m.headers.from).toBe('"MemWise" <noreply@acme.example>')
    expect(textOf(m)).toBe('Hello Asha,\r\n.\r\nOpen https://x.relay/f/mwl_abc\r\n')
    expect(s.commands.at(-1)).toBe('QUIT')
  })

  it('signs in with PLAIN, or LOGIN when that is all the server takes', async () => {
    const s = await sink({ auth: { user: 'mailer', password: 's3cret' } })
    await sendMail({ host: s.host, port: s.port, secure: 'none', from: 'a@acme.example', user: 'mailer', password: 's3cret' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m2@acme.example>',
    })
    expect((await s.waitFor(() => true)).user).toBe('mailer')
    expect(s.commands).toContain('AUTH PLAIN')
    await expect(sendMail({ host: s.host, port: s.port, secure: 'none', from: 'a@acme.example', user: 'mailer', password: 'wrong' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m3@acme.example>',
    })).rejects.toThrow('check SMTP_USER and SMTP_PASSWORD')
    const login = await sink({ auth: { user: 'mailer', password: 's3cret' }, authMechanisms: ['LOGIN'] })
    await sendMail({ host: login.host, port: login.port, secure: 'none', from: 'a@acme.example', user: 'mailer', password: 's3cret' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m2b@acme.example>',
    })
    expect((await login.waitFor(() => true)).user).toBe('mailer')
    expect(login.commands).toEqual(expect.arrayContaining(['AUTH LOGIN', '(user)', '(password)']))
  })

  it('refuses to send a password over a plain connection to another machine', async () => {
    await expect(sendMail({ host: 'mail.example.com', port: 25, secure: 'none', from: 'a@acme.example', user: 'u', password: 'p' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m@a>',
    })).rejects.toThrow('plain connection')
  })

  it('sends multipart/alternative with HTML and non-ASCII text', async () => {
    const s = await sink()
    await sendMail({ host: s.host, port: s.port, secure: 'none', from: 'a@acme.example' }, {
      to: ['b@example.com'], subject: 'Détails ✓', text: 'Namasté\n', html: '<p>Namasté</p>', messageId: '<m4@acme.example>',
    })
    const m = await s.waitFor(() => true)
    expect(m.headers['content-type']).toContain('multipart/alternative')
    expect(subjectOf(m)).toBe('Détails ✓')
    expect(textOf(m)).toBe('Namasté\n')
    expect(htmlOf(m)).toBe('<p>Namasté</p>')
  })

  it('reports a refused recipient in the server\'s words', async () => {
    const s = await sink({ refuse: ['nobody@example.com'] })
    await expect(sendMail({ host: s.host, port: s.port, secure: 'none', from: 'a@acme.example' }, {
      to: ['nobody@example.com'], subject: 'x', text: 'y', messageId: '<m5@a>',
    })).rejects.toThrow('the recipient nobody@example.com: 550')
    expect(s.messages).toEqual([])
  })

  it('reports a server that is not there', async () => {
    const s = await sink()
    const port = s.port
    await s.close()
    await expect(sendMail({ host: '127.0.0.1', port, secure: 'none', from: 'a@acme.example' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m6@a>',
    })).rejects.toThrow('could not reach the mail server')
  })

  const cert = selfSigned()
  it.skipIf(!cert)('upgrades with STARTTLS, then signs in', async () => {
    const s = await sink({ tls: cert!, auth: { user: 'mailer', password: 'pw' } })
    await sendMail({
      host: s.host, port: s.port, secure: 'starttls', from: 'a@acme.example', user: 'mailer', password: 'pw', tlsOptions: { ca: cert!.cert },
    }, { to: ['b@example.com'], subject: 'secure', text: 'y', messageId: '<m7@a>' })
    const m = await s.waitFor(() => true)
    expect(m.secure).toBe(true)
    expect(m.user).toBe('mailer')
    expect(s.commands.indexOf('STARTTLS')).toBeLessThan(s.commands.indexOf('AUTH PLAIN'))
  })

  it('refuses STARTTLS when the server does not offer it', async () => {
    const s = await sink()
    await expect(sendMail({ host: s.host, port: s.port, secure: 'starttls', from: 'a@acme.example' }, {
      to: ['b@example.com'], subject: 'x', text: 'y', messageId: '<m8@a>',
    })).rejects.toThrow('does not offer STARTTLS')
  })
})

describe('email.smtp.send', () => {
  it('sends with the settings from the environment, keyed by the idempotency key, once', async () => {
    const s = await sink({ auth: { user: 'u', password: 'p' } })
    const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'none', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'Acme <noreply@acme.example>' }
    const t = tool(channelTools({ env, sent: memorySentStore() }), EMAIL_SMTP_BUILTIN)
    expect(t.effect).toBe('outbound')
    expect(t.idempotent).toBe(true)
    expect(t.preview!({ to: 'asha@example.com', subject: 'S', body: 'B' })).toEqual({ summary: 'Email to asha@example.com: S', detail: { to: 'asha@example.com', subject: 'S', body: 'B' } })
    const first = await t.execute({ to: 'asha@example.com', subject: 'Your details', body: 'Open the link' }, ctx('run_1:invite:1'))
    expect(first.message_id).toBe(messageIdFor('run_1:invite:1', 'noreply@acme.example'))
    const again = await t.execute({ to: 'asha@example.com', subject: 'Your details', body: 'Open the link' }, ctx('run_1:invite:1'))
    expect(again.replayed).toBe(true)
    expect(s.messages.length).toBe(1)
    expect(s.messages[0]!.headers['x-memwise-idempotency-key']).toBe('run_1:invite:1')
  })

  it('takes injected secrets over the environment, and says plainly what is missing', async () => {
    const s = await sink()
    const t = tool(channelTools({ env: {} }), EMAIL_SMTP_BUILTIN)
    await expect(t.execute({ to: 'a@b.c', subject: 's', body: 'b' }, ctx('k0'))).rejects.toThrow('Email is not set up: set SMTP_HOST and SMTP_FROM')
    await t.execute({ to: 'a@b.c, "Rao, Asha" <asha@example.com>', subject: 's', body: 'b' },
      ctx('k1', { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(s.port), SMTP_SECURE: 'none', SMTP_FROM: 'n@acme.example' }))
    expect((await s.waitFor(() => true)).to).toEqual(['a@b.c', 'asha@example.com'])
  })
})

describe('the WhatsApp client against a fake Graph API', () => {
  async function fake(): Promise<FakeWhatsApp> {
    const wa = await startFakeWhatsApp({ token: 'tok', phoneNumberId: '1065' })
    teardown.push(() => wa.close())
    return wa
  }
  const envOf = (wa: FakeWhatsApp) => ({ WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '1065', WHATSAPP_API_BASE: wa.apiBase })

  it('normalises phone numbers and builds text and template payloads', () => {
    expect(phoneDigits('+91 98765-43210')).toBe('919876543210')
    expect(() => phoneDigits('call me')).toThrow('international form')
    expect(messagePayload({ to: '+919876543210', body: 'Hi' })).toMatchObject({ type: 'text', text: { body: 'Hi' }, to: '919876543210' })
    expect(messagePayload({ to: '+919876543210', template: { name: 'memwise_form_link', language: 'en', params: ['Asha', 'Acme', 'https://x'] } })).toMatchObject({
      type: 'template',
      template: { name: 'memwise_form_link', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'Acme' }, { type: 'text', text: 'https://x' }] }] },
    })
    expect((messagePayload({ to: '919876543210', template: { name: 't', language: 'en', params: { name: 'Asha' } } }) as any).template.components[0].parameters[0])
      .toEqual({ type: 'text', parameter_name: 'name', text: 'Asha' })
    expect(() => messagePayload({ to: '919876543210' })).toThrow('needs a body or a template')
  })

  it('sends a template and returns the provider message id, once per key', async () => {
    const wa = await fake()
    const t = tool(channelTools({ env: envOf(wa) }), WHATSAPP_CLOUD_BUILTIN)
    expect(t.effect).toBe('outbound')
    expect(t.idempotent).toBe(true)
    const args = { to: '+919876543210', template: { name: 'memwise_form_link', language: 'en', params: ['Asha', 'Acme', 'https://x.relay/f/mwl_a'] } }
    const r = await t.execute(args, ctx('run_1:invite:wa'))
    expect(r.message_id).toBe('wamid.FAKE000001')
    expect(r.to).toBe('919876543210')
    expect((await t.execute(args, ctx('run_1:invite:wa'))).replayed).toBe(true)
    expect(wa.messages.length).toBe(1)
    expect(wa.messages[0]!.body.template!.name).toBe('memwise_form_link')
    expect(t.preview!(args)).toMatchObject({ summary: 'WhatsApp to +919876543210: template memwise_form_link' })
  })

  it('sends text', async () => {
    const wa = await fake()
    const t = tool(channelTools({ env: envOf(wa) }), WHATSAPP_CLOUD_BUILTIN)
    await t.execute({ to: '919876543210', body: 'Your form: https://x' }, ctx('k-text'))
    expect(wa.messages[0]!.body.text!.body).toBe('Your form: https://x')
  })

  it('reports the API\'s refusal and missing settings in plain words', async () => {
    const wa = await fake()
    const t = tool(channelTools({ env: envOf(wa) }), WHATSAPP_CLOUD_BUILTIN)
    wa.failNext({ status: 400, message: 'Template name does not exist in the translation', code: 132001 })
    await expect(t.execute({ to: '919876543210', template: { name: 'nope', language: 'en' } }, ctx('k-bad'))).rejects.toThrow('WhatsApp refused the message (400, code 132001): Template name does not exist')
    const wrongToken = tool(channelTools({ env: { ...envOf(wa), WHATSAPP_TOKEN: 'other' } }), WHATSAPP_CLOUD_BUILTIN)
    await expect(wrongToken.execute({ to: '919876543210', body: 'x' }, ctx('k-tok'))).rejects.toThrow('Invalid OAuth access token')
    const unset = tool(channelTools({ env: {} }), WHATSAPP_CLOUD_BUILTIN)
    await expect(unset.execute({ to: '919876543210', body: 'x' }, ctx('k-unset'))).rejects.toThrow('WhatsApp is not set up: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID')
    // A failed send is not remembered: the same key may try again.
    await t.execute({ to: '919876543210', template: { name: 'memwise_form_link', language: 'en' } }, ctx('k-bad'))
    expect(wa.messages.length).toBe(1)
  })
})
