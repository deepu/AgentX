/**
 * A stand-in for the core's public handler, for working on the page and taking its pictures:
 * it serves the built app the way the real one must (README.md) and answers the API with
 * made-up data for every state. Nothing here is used in production.
 *
 *   bun run build && bun dev/mock-server.ts [--port 8790]
 *
 * The link's token picks the state (anything after a `-` is free, so each test gets its own):
 *   /f/mwl_empty       a fresh form; files dropped in are "read" (pan…, gst… in the name)
 *   /f/mwl_comments    sent back with a comment, values kept
 *   /f/mwl_draft       a draft saved earlier
 *   /f/mwl_invalid     the core refuses the first submission (a field problem)
 *   /f/mwl_expired  mwl_used  mwl_closed  mwl_revoked  mwl_unknown  mwl_ratelimited  mwl_notyet
 *   /f/mwl_offline     the API answers like the relay with the core away (503, HTML)
 *   /i/mwl_decision    "approve onboarding" with approve / send back
 *   /i/mwl_approval    an email waiting for approval, with its preview
 *   /i/mwl_openinapp   an item that needs typed values
 * The same paths work under `/x/<installId>/…` (the relay's path mode).
 */

import { join, normalize } from 'node:path'
import type {
  ExternalDocument,
  ExternalForm,
  ExternalFormField,
  ExtractSuggestion,
  InboxLinkItem,
  LinkRefusal,
} from '@memwise/defs/external'

const DIST = join(import.meta.dir, '..', 'dist')
const portArg = process.argv.indexOf('--port')
const PORT = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT ?? 8790)

/** The headers the real handler sends with the page (23 §4). */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
}

const BUSINESS = 'Acme & Co.'
const DAY = 24 * 3600_000
const now = () => new Date().toISOString()

// ---------------------------------------------------------------- the client intake form

const PAN_PATTERN = '^[A-Z]{5}[0-9]{4}[A-Z]$'
const GSTIN_PATTERN = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'

function intakeFields(): ExternalFormField[] {
  return [
    { name: 'client_name', label: 'Your name', kind: 'text', required: true, value: 'Asha Rao', source: { kind: 'case' } },
    { name: 'client_email', label: 'Email', kind: 'email', required: true, value: 'asha@raotraders.example', source: { kind: 'case' } },
    { name: 'client_phone', label: 'Phone', kind: 'phone', required: false, placeholder: '+91 98765 43210' },
    { name: 'legal_name', label: 'Registered business name', kind: 'text', required: true, help: 'As it appears on your GST certificate.' },
    { name: 'business_type', label: 'Type of business', kind: 'enum', required: true, options: [
      { value: 'proprietorship', label: 'Sole proprietorship' },
      { value: 'partnership', label: 'Partnership' },
      { value: 'llp', label: 'LLP' },
      { value: 'private_limited', label: 'Private limited company' },
    ] },
    { name: 'pan', label: 'PAN', kind: 'identifier', required: true, upperCase: true, pattern: PAN_PATTERN, placeholder: 'ABCDE1234F' },
    { name: 'gstin', label: 'GSTIN', kind: 'identifier', required: true, upperCase: true, pattern: GSTIN_PATTERN, placeholder: '27ABCDE1234F1Z5' },
    { name: 'annual_turnover', label: 'Annual turnover', kind: 'money', required: false, currency: 'INR', help: 'Last financial year, roughly.' },
    { name: 'documents', label: 'Your documents', kind: 'documents', required: true, help: 'Your PAN card and GST registration certificate.' },
  ]
}

const INSTRUCTIONS = [
  'Hello! To open your account we need a few details about your business.',
  '',
  'Please add:',
  '- your **PAN card**',
  '- your **GST registration certificate**',
  '',
  'Photos are fine, as long as the writing is clear.',
].join('\n')

interface LinkState {
  scenario: string
  form?: ExternalForm
  item?: InboxLinkItem
  files: Map<string, ExternalDocument>
  suggestions: ExtractSuggestion[]
  draft?: Record<string, unknown>
  submits: number
  submitted?: boolean
}

const links = new Map<string, LinkState>()

function baseForm(): ExternalForm {
  return {
    status: 'open',
    business: BUSINESS,
    title: 'Tell us about your business',
    instructions: INSTRUCTIONS,
    participant: { name: 'Asha Rao' },
    fields: intakeFields(),
    comments: [],
    outcomes: [{ id: 'submitted', label: 'Send' }],
    extract: { documentsField: 'documents', fields: ['pan', 'gstin', 'legal_name'], minConfidence: 0.8 },
    suggestions: [],
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
    limits: {
      maxFileBytes: 15 * 1024 * 1024,
      maxFiles: 20,
      accept: ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'text/plain'],
    },
  }
}

const PAN_DOC: ExternalDocument = { id: 'doc_pan', name: 'pan-card.pdf', mime: 'application/pdf', size: 184_320 }
const GST_DOC: ExternalDocument = { id: 'doc_gst', name: 'gst-certificate.pdf', mime: 'application/pdf', size: 402_112 }

function readDocument(doc: ExternalDocument): ExtractSuggestion[] {
  const out: ExtractSuggestion[] = []
  const n = doc.name.toLowerCase()
  if (n.includes('pan')) {
    out.push({ id: `sg_${doc.id}_pan`, field: 'pan', value: 'AAACR1234A', confidence: 0.93, document: doc.name, documentId: doc.id, quote: 'Permanent Account Number AAACR1234A', found: true, prefill: true })
  }
  if (n.includes('gst')) {
    out.push({ id: `sg_${doc.id}_gstin`, field: 'gstin', value: '29AAACR1234A1Z5', confidence: 0.91, document: doc.name, documentId: doc.id, quote: 'GSTIN: 29AAACR1234A1Z5', found: true, prefill: true })
    out.push({ id: `sg_${doc.id}_legal`, field: 'legal_name', value: 'Rao Traders Private Limited', confidence: 0.64, document: doc.name, documentId: doc.id, quote: 'Legal Name of Business: RAO TRADERS PRIVATE LIMITED', found: true, prefill: false })
  }
  return out
}

function newLink(token: string): LinkState {
  const scenario = token.replace(/^mwl_/, '').split('-')[0] ?? ''
  const state: LinkState = { scenario, files: new Map(), suggestions: [], submits: 0 }
  switch (scenario) {
    case 'empty':
    case 'invalid':
      state.form = baseForm()
      break
    case 'draft': {
      const form = baseForm()
      const saved = new Date(Date.now() - 2 * 3600_000)
      saved.setMinutes(42)
      form.draftSavedAt = saved.toISOString()
      form.fields = form.fields.map(f =>
        f.name === 'client_phone' ? { ...f, value: '+91 98450 12345', source: { kind: 'draft' } }
        : f.name === 'business_type' ? { ...f, value: 'private_limited', source: { kind: 'draft' } }
        : f.name === 'annual_turnover' ? { ...f, value: { amount: 42000000, currency: 'INR' }, source: { kind: 'draft' } }
        : f)
      state.form = form
      break
    }
    case 'comments': {
      const form = baseForm()
      const suggestions = [...readDocument(PAN_DOC), ...readDocument(GST_DOC)]
      form.suggestions = suggestions
      form.comments = [{ from: 'Ravi', text: 'Please upload a clearer GST certificate. The one we have is cut off at the bottom, so we can’t read the GSTIN.', at: new Date(Date.now() - 3600_000).toISOString() }]
      form.fields = form.fields.map(f => {
        switch (f.name) {
          case 'legal_name': return { ...f, value: 'Rao Traders Private Limited', source: { kind: 'case' } }
          case 'business_type': return { ...f, value: 'private_limited', source: { kind: 'case' } }
          case 'pan': return { ...f, value: 'AAACR1234A', source: { kind: 'extracted', suggestionId: `sg_${PAN_DOC.id}_pan`, document: PAN_DOC.name, confidence: 0.93 } }
          case 'gstin': return { ...f, value: '29AAACR1234A1Z5', source: { kind: 'case' } }
          case 'annual_turnover': return { ...f, value: { amount: 42000000, currency: 'INR' }, source: { kind: 'case' } }
          case 'documents': return { ...f, value: [PAN_DOC], source: { kind: 'case' } }
          default: return f
        }
      })
      state.form = form
      state.suggestions = suggestions
      break
    }
    case 'decision':
      state.item = {
        status: 'open',
        business: BUSINESS,
        kind: 'decision',
        title: 'Ravi, approve onboarding for Asha Rao',
        person: 'Ravi',
        caseTitle: 'Asha Rao · Rao Traders Private Limited',
        fields: [
          { label: 'Registered business name', value: 'Rao Traders Private Limited' },
          { label: 'PAN', value: 'AAACR1234A (from pan-card.pdf)' },
          { label: 'GSTIN', value: '29AAACR1234A1Z5 · valid' },
          { label: 'Annual turnover', value: '₹4,20,00,000' },
          { label: 'Checks', value: 'GSTIN is registered to this PAN. No problems found.' },
        ],
        outcomes: [
          { id: 'approved', label: 'Approve', comment: 'optional' },
          { id: 'sent_back', label: 'Send back', comment: 'required' },
        ],
        expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      }
      break
    case 'approval':
      state.item = {
        status: 'open',
        business: BUSINESS,
        kind: 'approval',
        title: 'Send the form link to Asha Rao?',
        person: 'Ravi',
        caseTitle: 'Asha Rao',
        fields: [{ label: 'Sent by', value: 'Email' }],
        preview: {
          summary: 'An email to Asha Rao with a link to the form.',
          to: 'Asha Rao <asha@raotraders.example>',
          subject: 'Acme & Co. needs a few details from you',
          body: 'Hello Asha,\n\nAcme & Co. asks you to fill in a short form so we can open your account. It takes about five minutes, and you can add photos of your PAN card and GST certificate.\n\nhttps://k7q2m4x6p3r5s2t6.relay.memwise.app/f/mwl_…\n\nThe link works until 27 October.\n\nThank you,\nAcme & Co.',
        },
        expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      }
      break
    case 'openinapp':
      state.item = {
        status: 'open',
        business: BUSINESS,
        kind: 'input',
        title: 'Fill in the engagement details for Asha Rao',
        person: 'Ravi',
        caseTitle: 'Asha Rao',
        fields: [{ label: 'Registered business name', value: 'Rao Traders Private Limited' }],
        openInApp: 'memwise://inbox/item_123',
        expiresAt: new Date(Date.now() + 3 * DAY).toISOString(),
      }
      break
  }
  return state
}

function link(token: string): LinkState {
  let s = links.get(token)
  if (!s) { s = newLink(token); links.set(token, s) }
  return s
}

const MESSAGES: Record<LinkRefusal['status'], string> = {
  expired: 'This link expired on 13 October. Ask Acme & Co. for a new one and they’ll send it to you.',
  used: 'Your answers reached Acme & Co. on 14 October. There’s nothing more to do.',
  closed: 'Acme & Co. no longer needs this form.',
  revoked: 'Acme & Co. turned this link off. If you still need to send something, ask them for a new link.',
  unknown: 'Please check that you opened the whole link from your message.',
  not_yet: 'This form opens a little later. Please try again soon.',
  rate_limited: 'There were a lot of tries in a short time. Please wait a minute and try again.',
}

function refusalFor(scenario: string): LinkRefusal | null {
  const map: Record<string, LinkRefusal['status']> = {
    expired: 'expired', used: 'used', closed: 'closed', revoked: 'revoked', unknown: 'unknown', ratelimited: 'rate_limited', notyet: 'not_yet',
  }
  const status = map[scenario]
  return status ? { status, message: MESSAGES[status] } : null
}

// ---------------------------------------------------------------- HTTP

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const OFFLINE_PAGE = '<!doctype html><title>Not available</title><p>This form isn’t available right now. The business’s MemWise app is offline; please try again later.</p>'

async function api(kind: 'f' | 'i', token: string, what: string, req: Request, url: URL): Promise<Response> {
  const s = link(token)
  if (s.scenario === 'offline') return new Response(OFFLINE_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const refusal = refusalFor(s.scenario)
  if (refusal) return json(refusal)
  if (s.submitted) return json({ status: 'used', message: MESSAGES.used } satisfies LinkRefusal)

  if (kind === 'i') {
    if (!s.item) return json({ status: 'unknown', message: MESSAGES.unknown } satisfies LinkRefusal)
    if (what === 'item' && req.method === 'GET') return json(s.item)
    if (what === 'decide' && req.method === 'POST') {
      const d = (await req.json()) as { outcome: string; comment?: string }
      const outcome = s.item.outcomes?.find(o => o.id === d.outcome)
      if (outcome?.comment === 'required' && !d.comment?.trim()) return json({ status: 'invalid', message: 'Please say what needs to change.' })
      await sleep(400)
      s.submitted = true
      const text = d.outcome === 'sent_back' ? 'Sent back to Asha Rao with your comment.'
        : d.outcome === 'rejected' ? 'The email was not sent.'
        : s.item.kind === 'approval' ? 'Approved. The email is on its way to Asha Rao.'
        : 'Approved. Onboarding for Asha Rao goes ahead.'
      return json({ status: 'applied', message: text })
    }
    return json({ error: 'not found' }, 404)
  }

  if (!s.form) return json({ status: 'unknown', message: MESSAGES.unknown } satisfies LinkRefusal)
  switch (`${req.method} ${what}`) {
    case 'GET form': {
      const form = structuredClone(s.form)
      form.suggestions = s.suggestions
      if (s.draft) {
        form.fields = form.fields.map(f => (f.name in s.draft! ? { ...f, value: s.draft![f.name], source: { kind: 'draft' } } : f))
      }
      return json(form)
    }
    case 'PUT draft': {
      const body = (await req.json()) as { values: Record<string, unknown> }
      s.draft = body.values
      const savedAt = now()
      s.form.draftSavedAt = savedAt
      return json({ savedAt })
    }
    case 'POST files': {
      const name = url.searchParams.get('name') ?? 'file'
      const data = new Uint8Array(await req.arrayBuffer())
      if (data.byteLength > s.form.limits.maxFileBytes) return json({ status: 'invalid', message: `${name} is too big. Files can be up to 15 MB.` })
      await sleep(250)
      const doc: ExternalDocument = { id: `doc_${crypto.randomUUID().slice(0, 8)}`, name, mime: req.headers.get('content-type') ?? 'application/octet-stream', size: data.byteLength }
      s.files.set(doc.id, doc)
      return json({ document: doc })
    }
    case 'POST extract': {
      const body = (await req.json()) as { documents: string[] }
      await sleep(900)
      const found = body.documents.flatMap(id => {
        const doc = s.files.get(id) ?? [PAN_DOC, GST_DOC].find(d => d.id === id)
        return doc ? readDocument(doc) : []
      })
      s.suggestions = [...s.suggestions.filter(x => !found.some(f => f.id === x.id)), ...found]
      return json({ suggestions: found })
    }
    case 'POST submit': {
      const body = (await req.json()) as { values: Record<string, unknown>; sources?: Record<string, string> }
      s.submits++
      console.log(`[mock] submit ${token}`, JSON.stringify(body))
      await sleep(500)
      if (s.scenario === 'invalid' && s.submits === 1) {
        return json({ status: 'invalid', message: 'Please check your answers.', errors: { gstin: ['This GSTIN belongs to a different PAN. Please check both against your GST certificate.'] } })
      }
      s.submitted = true
      return json({ status: 'applied', message: 'Thank you. Acme & Co. has your details.' })
    }
  }
  return json({ error: 'not found' }, 404)
}

async function serveFile(path: string): Promise<Response> {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  const file = Bun.file(join(DIST, safe))
  if (!(await file.exists())) return new Response('Not found', { status: 404 })
  return new Response(file, { headers: { 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } })
}

const ROUTE = /^(?:\/x\/[a-z2-7]{16})?(?:\/(f|i)\/([A-Za-z0-9_-]+)(?:\/api\/([a-z]+))?\/?|\/(assets\/form\/.+))$/

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const m = ROUTE.exec(url.pathname)
    if (!m) return new Response('Not found', { status: 404 })
    const [, kind, token, what, asset] = m
    if (asset) return serveFile(asset)
    if (what) return api(kind as 'f' | 'i', token!, what, req, url)
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    return new Response(Bun.file(join(DIST, 'index.html')), { headers: PAGE_HEADERS })
  },
})

console.log(`[mock] form app at http://localhost:${server.port}/f/mwl_empty  (dist: ${DIST})`)
