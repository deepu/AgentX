/**
 * A small SMTP client on node:net and node:tls (23 §6), enough to hand one message to a mail
 * server: EHLO (HELO as a fallback), STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA with
 * dot-stuffing, QUIT. Messages are plain text, or multipart/alternative when there is HTML.
 */
import { createHash } from 'node:crypto'
import net from 'node:net'
import { hostname } from 'node:os'
import tls from 'node:tls'

export type SmtpSecurity = 'tls' | 'starttls' | 'none'

export interface SmtpSettings {
  host: string
  port: number
  /** `tls`: TLS from the first byte (port 465); `starttls`: upgrade after EHLO (587); `none`: plain (a local relay). */
  secure: SmtpSecurity
  user?: string
  password?: string
  /** The sender, `MemWise <noreply@example.com>` or a bare address. */
  from: string
  /** The name sent in EHLO; default this machine's host name. */
  heloName?: string
  /** Per step of the conversation; default 30 s. */
  timeoutMs?: number
  /** Passed to node:tls (tests trust their own certificate this way). */
  tlsOptions?: tls.ConnectionOptions
}

export interface SmtpMessage {
  to: string[]
  subject: string
  text: string
  html?: string
  /** `<id@domain>`. */
  messageId: string
  /** Extra headers (`X-MemWise-Idempotency-Key`). */
  headers?: Record<string, string>
  date?: Date
}

export interface SmtpResult { messageId: string; accepted: string[]; response: string }

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

const CRLF = '\r\n'

/** `Asha Rao <asha@example.com>` → `asha@example.com`; a bare address as it is. */
export function addressOf(value: string): string {
  const m = /<([^<>]+)>\s*$/.exec(value)
  return (m ? m[1]! : value).trim()
}

/** One address as SMTP takes it: no spaces, brackets or line breaks, one `@`. */
function checkAddress(addr: string, what: string): string {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(addr)) throw new SmtpError(`${what} is not an email address: ${addr}`)
  return addr
}

/** Header values may not carry line breaks (that would let a value add headers of its own). */
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim()
}

const isAscii = (s: string) => /^[\x20-\x7e\t]*$/.test(s)

/** RFC 2047 for a header with non-ASCII text (a subject, a sender's name). */
function encodeWord(s: string): string {
  return isAscii(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

/** `Name <addr>` with the name encoded when it needs to be. */
function encodeMailbox(value: string): string {
  const v = headerValue(value)
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(v)
  if (!m || !m[1]) return v
  const name = m[1].replace(/^"(.*)"$/, '$1')
  return `${isAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(name)} <${m[2]}>`
}

/** A body part: 7bit when it is short-lined ASCII (readable as it is), else base64. */
function bodyPart(contentType: string, text: string): string {
  const normalized = text.replace(/\r?\n/g, CRLF)
  const plain = isAscii(normalized.replace(/\r\n/g, '')) && normalized.split(CRLF).every((l) => l.length <= 998)
  const encoded = plain ? normalized : Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, (l) => `${l}${CRLF}`).trimEnd()
  return [`Content-Type: ${contentType}; charset=utf-8`, `Content-Transfer-Encoding: ${plain ? '7bit' : 'base64'}`, '', encoded].join(CRLF)
}

/** The message as it goes after DATA (before dot-stuffing). */
export function buildMessage(from: string, msg: SmtpMessage): string {
  const headers: string[] = [
    `From: ${encodeMailbox(from)}`,
    `To: ${msg.to.map(encodeMailbox).join(', ')}`,
    `Subject: ${encodeWord(headerValue(msg.subject))}`,
    `Date: ${(msg.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${headerValue(msg.messageId)}`,
    'MIME-Version: 1.0',
  ]
  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) throw new SmtpError(`not a header name: ${k}`)
    headers.push(`${k}: ${headerValue(v)}`)
  }
  if (!msg.html) return [...headers, bodyPart('text/plain', msg.text)].join(CRLF)
  const boundary = `mw-${createHash('sha256').update(msg.messageId).digest('hex').slice(0, 24)}`
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`, bodyPart('text/plain', msg.text),
    `--${boundary}`, bodyPart('text/html', msg.html),
    `--${boundary}--`,
  ].join(CRLF)
}

/** A line that starts with `.` gets one more (RFC 5321 §4.5.2); the end is `CRLF.CRLF`. */
export function dotStuff(data: string): string {
  const body = data.replace(/\r?\n/g, CRLF).split(CRLF).map((l) => (l.startsWith('.') ? `.${l}` : l)).join(CRLF)
  return `${body}${CRLF}.${CRLF}`
}

/** A stable Message-ID for an idempotency key: a retried send has the same id, so mail clients dedupe it. */
export function messageIdFor(key: string, from: string): string {
  const domain = addressOf(from).split('@')[1] || 'memwise.local'
  return `<${createHash('sha256').update(key).digest('hex').slice(0, 32)}.memwise@${domain}>`
}

interface Reply { code: number; lines: string[] }

/** One conversation with a server: replies are read line by line, across a STARTTLS upgrade. */
class Conversation {
  private buffer = ''
  private lines: string[] = []
  private pending: Reply[] = []
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | undefined
  private failed: Error | undefined
  private socket!: net.Socket

  constructor(private readonly timeoutMs: number) {}

  attach(socket: net.Socket): void {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.setTimeout(this.timeoutMs)
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('timeout', () => this.fail(new SmtpError('the mail server did not answer in time')))
    socket.on('error', (e: Error) => this.fail(new SmtpError(`the mail server connection failed: ${e.message}`)))
    socket.on('close', () => this.fail(new SmtpError('the mail server closed the connection')))
  }

  /** Stop listening to the plain socket before handing it to TLS. */
  detach(): void {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('timeout')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    this.socket.setTimeout(0)
  }

  get raw(): net.Socket { return this.socket }

  private onData(chunk: string): void {
    this.buffer += chunk
    let i: number
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '')
      this.buffer = this.buffer.slice(i + 1)
      this.lines.push(line)
      const m = /^(\d{3})([ -])?/.exec(line)
      if (m && m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.lines.map((l) => l.slice(4)) }
        this.lines = []
        if (this.waiter) { const w = this.waiter; this.waiter = undefined; w.resolve(reply) } else this.pending.push(reply)
      }
    }
  }

  private fail(e: Error): void {
    if (this.failed) return
    this.failed = e
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w.reject(e) }
  }

  read(): Promise<Reply> {
    const next = this.pending.shift()
    if (next) return Promise.resolve(next)
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
  }

  async send(line: string, expect: number[], what: string): Promise<Reply> {
    this.socket.write(`${line}${CRLF}`)
    return this.expect(expect, what)
  }

  async expect(codes: number[], what: string): Promise<Reply> {
    const r = await this.read()
    if (!codes.includes(r.code)) throw new SmtpError(`the mail server refused ${what}: ${r.code} ${r.lines.join(' ').slice(0, 300)}`, r.code)
    return r
  }

  write(data: string): void { this.socket.write(data) }

  close(): void {
    this.failed ??= new SmtpError('closed')
    try { this.socket.end() } catch { /* already gone */ }
    try { this.socket.destroy() } catch { /* already gone */ }
  }
}

function connect(settings: SmtpSettings): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(new SmtpError(`could not reach the mail server ${settings.host}:${settings.port}: ${e.message}`))
    const socket = settings.secure === 'tls'
      ? tls.connect({ host: settings.host, port: settings.port, servername: net.isIP(settings.host) ? undefined : settings.host, ...settings.tlsOptions }, () => resolve(socket))
      : net.connect({ host: settings.host, port: settings.port }, () => resolve(socket))
    socket.once('error', onError)
    socket.setTimeout(settings.timeoutMs ?? 30_000, () => { socket.destroy(); onError(new Error('timed out')) })
  })
}

function upgrade(socket: net.Socket, settings: SmtpSettings): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: net.isIP(settings.host) ? undefined : settings.host, ...settings.tlsOptions }, () => resolve(secured))
    secured.once('error', (e) => reject(new SmtpError(`the secure connection to the mail server failed: ${e.message}`)))
  })
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\./.test(host)

function capabilities(r: Reply): Set<string> {
  return new Set(r.lines.slice(1).map((l) => l.toUpperCase()))
}

function authMechanisms(caps: Set<string>): string[] {
  for (const c of caps) if (c.startsWith('AUTH ') || c.startsWith('AUTH=')) return c.slice(5).split(/\s+/)
  return []
}

/** Hands one message to the server. Throws SmtpError with the server's answer when it refuses. */
export async function sendMail(settings: SmtpSettings, msg: SmtpMessage): Promise<SmtpResult> {
  const from = checkAddress(addressOf(settings.from), 'The sender')
  const rcpts = msg.to.map((t) => checkAddress(addressOf(t), 'The recipient'))
  if (!rcpts.length) throw new SmtpError('The message has no recipient.')
  if (settings.user && settings.secure === 'none' && !isLoopback(settings.host)) {
    throw new SmtpError('Refusing to send the mail password over a plain connection: set SMTP_SECURE to tls or starttls.')
  }
  const helo = settings.heloName ?? (hostname() || 'localhost')
  const conv = new Conversation(settings.timeoutMs ?? 30_000)
  const socket = await connect(settings)
  socket.removeAllListeners('error')
  socket.removeAllListeners('timeout')
  conv.attach(socket)
  try {
    await conv.expect([220], 'the connection')
    let ehlo = await conv.send(`EHLO ${helo}`, [250, 500, 502], 'EHLO')
    if (ehlo.code !== 250) ehlo = await conv.send(`HELO ${helo}`, [250], 'HELO')
    let caps = capabilities(ehlo)
    if (settings.secure === 'starttls') {
      if (!caps.has('STARTTLS')) throw new SmtpError('The mail server does not offer STARTTLS; set SMTP_SECURE to tls or none.')
      await conv.send('STARTTLS', [220], 'STARTTLS')
      conv.detach()
      const secured = await upgrade(conv.raw, settings)
      conv.attach(secured)
      caps = capabilities(await conv.send(`EHLO ${helo}`, [250], 'EHLO'))
    }
    if (settings.user) {
      const mechs = authMechanisms(caps)
      const password = settings.password ?? ''
      if (mechs.includes('PLAIN') || !mechs.includes('LOGIN')) {
        const token = Buffer.from(`\0${settings.user}\0${password}`, 'utf8').toString('base64')
        await conv.send(`AUTH PLAIN ${token}`, [235], 'the sign-in (check SMTP_USER and SMTP_PASSWORD)')
      } else {
        await conv.send('AUTH LOGIN', [334], 'the sign-in')
        await conv.send(Buffer.from(settings.user, 'utf8').toString('base64'), [334], 'the sign-in')
        await conv.send(Buffer.from(password, 'utf8').toString('base64'), [235], 'the sign-in (check SMTP_USER and SMTP_PASSWORD)')
      }
    }
    await conv.send(`MAIL FROM:<${from}>`, [250], `the sender ${from}`)
    const accepted: string[] = []
    for (const r of rcpts) {
      await conv.send(`RCPT TO:<${r}>`, [250, 251], `the recipient ${r}`)
      accepted.push(r)
    }
    await conv.send('DATA', [354], 'the message')
    conv.write(dotStuff(buildMessage(settings.from, msg)))
    const done = await conv.expect([250], 'the message')
    await conv.send('QUIT', [221], 'QUIT').catch(() => undefined)
    return { messageId: msg.messageId, accepted, response: done.lines.join(' ').slice(0, 300) }
  } finally {
    conv.close()
  }
}
