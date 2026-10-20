/**
 * A local SMTP sink for tests: a tiny server on node:net that speaks enough SMTP for the email
 * channel (EHLO, STARTTLS when given a certificate, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET,
 * NOOP, QUIT) and records every message it is given. The Phase 5 exit test reuses it.
 *
 *   const sink = await startSmtpSink({ auth: { user: 'u', password: 'p' } })
 *   … SMTP_HOST=127.0.0.1 SMTP_PORT=${sink.port} …
 *   const mail = await sink.waitFor((m) => m.to.includes('asha@example.com'))
 *   textOf(mail)   // the plain-text body, decoded
 *   await sink.close()
 */
import net from 'node:net'
import tls from 'node:tls'

export interface SinkMessage {
  from: string
  to: string[]
  /** The message as sent after DATA, dot-stuffing undone, CRLF line ends. */
  data: string
  /** The user it signed in as, if it did. */
  user?: string
  /** It was sent over TLS (STARTTLS). */
  secure: boolean
  headers: Record<string, string>
  receivedAt: number
}

export interface SmtpSinkOptions {
  /** Require this sign-in before MAIL. */
  auth?: { user: string; password: string }
  /** The sign-in mechanisms offered; default PLAIN and LOGIN. */
  authMechanisms?: ('PLAIN' | 'LOGIN')[]
  /** Offer STARTTLS with this certificate (PEM). */
  tls?: { key: string; cert: string }
  /** Refuse these recipients with 550. */
  refuse?: string[]
}

export interface SmtpSink {
  port: number
  host: string
  messages: SinkMessage[]
  /** Commands seen, in order (passwords left out), for asserting the conversation. */
  commands: string[]
  waitFor(match: (m: SinkMessage) => boolean, timeoutMs?: number): Promise<SinkMessage>
  close(): Promise<void>
}

/** Header names lower-cased; folded lines joined. */
export function parseHeaders(data: string): Record<string, string> {
  const head = data.split('\r\n\r\n')[0] ?? ''
  const out: Record<string, string> = {}
  let last: string | undefined
  for (const line of head.split('\r\n')) {
    if (/^\s/.test(line) && last) { out[last] += ` ${line.trim()}`; continue }
    const i = line.indexOf(':')
    if (i <= 0) continue
    last = line.slice(0, i).toLowerCase()
    out[last] = line.slice(i + 1).trim()
  }
  return out
}

function decodePart(part: string): { type: string; text: string } {
  const [head, ...rest] = part.split('\r\n\r\n')
  const headers = parseHeaders(`${head}\r\n\r\n`)
  const body = rest.join('\r\n\r\n')
  const enc = (headers['content-transfer-encoding'] ?? '7bit').toLowerCase()
  const text = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : body
  return { type: (headers['content-type'] ?? 'text/plain').split(';')[0]!.trim().toLowerCase(), text }
}

function parts(m: SinkMessage): { type: string; text: string }[] {
  const type = m.headers['content-type'] ?? 'text/plain'
  const boundary = /boundary="?([^";]+)"?/.exec(type)?.[1]
  if (!boundary) return [decodePart(m.data)]
  return m.data.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--')).map((p) => decodePart(p.replace(/^\r\n/, '').replace(/\r\n$/, '')))
}

/** The plain-text body, decoded. */
export function textOf(m: SinkMessage): string {
  return (parts(m).find((p) => p.type === 'text/plain') ?? parts(m)[0])?.text ?? ''
}

/** The HTML body, decoded, if there is one. */
export function htmlOf(m: SinkMessage): string | undefined {
  return parts(m).find((p) => p.type === 'text/html')?.text
}

/** The subject, RFC 2047 words decoded. */
export function subjectOf(m: SinkMessage): string {
  return (m.headers.subject ?? '').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_w, b64: string) => Buffer.from(b64, 'base64').toString('utf8'))
}

export async function startSmtpSink(opts: SmtpSinkOptions = {}): Promise<SmtpSink> {
  const messages: SinkMessage[] = []
  const commands: string[] = []
  const waiters: { match: (m: SinkMessage) => boolean; resolve: (m: SinkMessage) => void }[] = []
  const sockets = new Set<net.Socket>()

  const record = (m: SinkMessage) => {
    messages.push(m)
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
  }

  const server = net.createServer((raw) => {
    sockets.add(raw)
    raw.on('close', () => sockets.delete(raw))
    let socket: net.Socket = raw
    let secure = false
    let buffer = ''
    let user: string | undefined
    let from: string | undefined
    let to: string[] = []
    let inData = false
    let dataLines: string[] = []
    let authStep: { kind: 'login-user' } | { kind: 'login-pass'; user: string } | undefined

    const reply = (line: string) => { try { socket.write(`${line}\r\n`) } catch { /* gone */ } }
    const ehlo = () => {
      const caps = ['250-memwise-sink', '250-8BITMIME', '250-SIZE 52428800']
      if (opts.tls && !secure) caps.push('250-STARTTLS')
      if (opts.auth) caps.push(`250-AUTH ${(opts.authMechanisms ?? ['PLAIN', 'LOGIN']).join(' ')}`)
      caps.push('250 HELP')
      reply(caps.join('\r\n'))
    }
    const signIn = (u: string, p: string) => {
      if (opts.auth && u === opts.auth.user && p === opts.auth.password) { user = u; reply('235 2.7.0 Authentication successful') } else reply('535 5.7.8 Authentication failed')
    }

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false
          const data = dataLines.join('\r\n')
          record({ from: from!, to, data, ...(user ? { user } : {}), secure, headers: parseHeaders(`${data}\r\n\r\n`), receivedAt: Date.now() })
          from = undefined; to = []; dataLines = []
          reply('250 2.0.0 Ok: queued')
        } else dataLines.push(line.startsWith('..') ? line.slice(1) : line)
        return
      }
      if (authStep?.kind === 'login-user') {
        commands.push('(user)')
        authStep = { kind: 'login-pass', user: Buffer.from(line, 'base64').toString('utf8') }
        reply('334 UGFzc3dvcmQ6')
        return
      }
      if (authStep?.kind === 'login-pass') {
        commands.push('(password)')
        const u = authStep.user
        authStep = undefined
        signIn(u, Buffer.from(line, 'base64').toString('utf8'))
        return
      }
      const [verb = '', ...args] = line.split(' ')
      const cmd = verb.toUpperCase()
      commands.push(cmd === 'AUTH' ? `AUTH ${args[0] ?? ''}`.trim() : line)
      switch (cmd) {
        case 'EHLO': ehlo(); break
        case 'HELO': reply('250 memwise-sink'); break
        case 'STARTTLS': {
          if (!opts.tls || secure) { reply('454 TLS not available'); break }
          reply('220 2.0.0 Ready to start TLS')
          raw.removeAllListeners('data')
          const secured = new tls.TLSSocket(raw, { isServer: true, key: opts.tls.key, cert: opts.tls.cert })
          secured.setEncoding('utf8')
          secured.on('data', onData)
          secured.on('error', () => raw.destroy())
          socket = secured
          secure = true
          buffer = ''
          break
        }
        case 'AUTH': {
          const mech = (args[0] ?? '').toUpperCase()
          if (!(opts.authMechanisms ?? ['PLAIN', 'LOGIN']).includes(mech as 'PLAIN')) reply('504 5.5.4 Unrecognized authentication type')
          else if (mech === 'PLAIN') {
            const decoded = Buffer.from(args[1] ?? '', 'base64').toString('utf8').split('\0')
            signIn(decoded[1] ?? '', decoded[2] ?? '')
          } else if (mech === 'LOGIN') {
            authStep = { kind: 'login-user' }
            reply('334 VXNlcm5hbWU6')
          } else reply('504 5.5.4 Unrecognized authentication type')
          break
        }
        case 'MAIL': {
          if (opts.auth && !user) { reply('530 5.7.0 Authentication required'); break }
          const m = /^FROM:\s*<([^>]*)>/i.exec(args.join(' '))
          if (!m) { reply('501 5.5.4 Syntax: MAIL FROM:<address>'); break }
          from = m[1]!; to = []
          reply('250 2.1.0 Ok')
          break
        }
        case 'RCPT': {
          const m = /^TO:\s*<([^>]*)>/i.exec(args.join(' '))
          if (!from || !m) { reply('503 5.5.1 Bad sequence of commands'); break }
          if (opts.refuse?.includes(m[1]!)) { reply('550 5.1.1 Recipient address rejected'); break }
          to.push(m[1]!)
          reply('250 2.1.5 Ok')
          break
        }
        case 'DATA':
          if (!from || !to.length) { reply('503 5.5.1 Bad sequence of commands'); break }
          inData = true
          reply('354 End data with <CR><LF>.<CR><LF>')
          break
        case 'RSET': from = undefined; to = []; reply('250 2.0.0 Ok'); break
        case 'NOOP': reply('250 2.0.0 Ok'); break
        case 'QUIT': reply('221 2.0.0 Bye'); socket.end(); break
        default: reply('502 5.5.2 Command not recognized')
      }
    }
    function onData(chunk: string) {
      buffer += chunk
      let i: number
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        onLine(line)
      }
    }
    raw.setEncoding('utf8')
    raw.on('data', onData)
    raw.on('error', () => {})
    reply('220 memwise-sink ESMTP ready')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    host: '127.0.0.1',
    messages,
    commands,
    waitFor(match, timeoutMs = 10_000) {
      const found = messages.find(match)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const w = { match, resolve: (m: SinkMessage) => { clearTimeout(t); resolve(m) } }
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no matching email arrived at the SMTP sink')) }, timeoutMs)
        waiters.push(w)
      })
    },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
