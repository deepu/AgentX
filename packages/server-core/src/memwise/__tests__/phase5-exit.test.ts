/**
 * Phase 5 exit test (23 §12): the full intake with a real outside client, through the relay.
 *
 * Against a real Postgres with scripted models, a Bun relay on a local port that the core dials out
 * to (the same tunnel the desktop uses), a local SMTP server behind `email.send` and a fake
 * WhatsApp Cloud API behind `whatsapp.send` (the real channel plugins' tools):
 *
 * 1. Staff say who the client is; the invite is an outbound effect, so staff approve the message,
 *    and the email reaches the SMTP server with a link through the relay.
 * 2. The client opens the link on a phone (Playwright at 390×844 when a browser is installed,
 *    else the same requests the page makes), uploads a PAN card and a GST certificate, sees the
 *    PAN and GSTIN read from them, saves a draft, comes back to it and sends the form.
 * 3. The check runs on what the client typed (tainted); the manager sends it back with a comment;
 *    staff approve a second invite; the old link says it was used; the client sees the comment
 *    and sends the form again.
 * 4. The manager, who asked for their inbox by email, approves from the link in that email, and
 *    onboard writes the Customer, with each value's provenance (typed by the client, or read from
 *    a document and kept).
 * 5. A WhatsApp invite reaches the fake Cloud API; a revoked and an expired link, and the relay
 *    with the core offline, each give their plain answer.
 *
 * Screenshots of the phone screens are written to MEMWISE_WALKTHROUGH_DIR when it is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { ExternalForm, ExtractResult, InboxLinkItem } from '@memwise/defs/external'
import type { ToolDefinition } from '@memwise/gateway'
import { startBunRelay, type BunRelay } from '@memwise/relay/bun'
import type { MwCase, MwInboxItem } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { startFakeWhatsApp, type FakeWhatsApp } from './fixtures/fake-whatsapp'
import { startSmtpSink, subjectOf, textOf, type SmtpSink } from './fixtures/smtp-sink'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { channelTools, EMAIL_SMTP_BUILTIN, WHATSAPP_CLOUD_BUILTIN } from '../channels'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const FORM_APP = join(REPO, 'apps', 'external-form')
const ch = RPC_CHANNELS.memwise
const PAN = 'AAACA1234A'
const GSTIN = '29AAACA1234A1Z5'
const BUSINESS = 'Acme & Co.'
const SHOTS = process.env.MEMWISE_WALKTHROUGH_DIR

/** A small real PDF whose page shows `lines` (uncompressed text operators, as generated documents have). */
export function pdfWith(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const content = `BT /F1 16 Tf 72 760 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -28 Td`).join(' ')} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const PAN_CARD = pdfWith(['INCOME TAX DEPARTMENT', 'Permanent Account Number Card', `PAN: ${PAN}`, 'Name: ACME TRADERS PRIVATE LIMITED'])
const GST_CERT = pdfWith(['Government of India', 'Form GST REG-06', 'Registration Certificate', `GSTIN: ${GSTIN}`, 'Legal Name: Acme Traders Private Limited'])

/** The link in a message: the first `…/f/mwl_…` or `…/i/mwl_…` address. */
function linkIn(text: string, kind: 'f' | 'i'): string {
  const m = text.match(new RegExp(`https?://\\S+/${kind}/mwl_[A-Za-z0-9_-]+`))
  if (!m) throw new Error(`no /${kind}/ link in: ${text}`)
  return m[0]
}

/** Playwright, when this machine has a browser for it (the cloud container does; CI doesn't). */
async function loadBrowser(): Promise<any | undefined> {
  if (process.env.MEMWISE_EXIT_NO_BROWSER) return undefined
  for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright/index.mjs']) {
    try {
      const pw = await import(spec)
      const browser = await pw.chromium.launch()
      return browser
    } catch { /* next */ }
  }
  return undefined
}

describe.skipIf(!postgresAvailable())('Phase 5 exit: a client fills the intake form through the relay', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  let relay: BunRelay
  let sink: SmtpSink
  let wa: FakeWhatsApp
  let browser: any
  const api = fakeServer()
  const sessions = fakeSessions()
  let staff: RequestContext
  let manager: RequestContext
  let ownerCtx: RequestContext
  const saved: Record<string, string | undefined> = {}
  const env = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  let caseId: string
  let firstLink: string
  let secondLink: string

  async function caseAt(id: string, state: string): Promise<MwCase> {
    return until(`case ${id} at ${state}`, () => api.call<MwCase>(staff, ch.CASES_GET, id), (c) => c.state === state || c.status !== 'active', 30_000)
  }

  async function itemFor<K extends MwInboxItem['kind']>(who: RequestContext, kind: K, match: (i: Extract<MwInboxItem, { kind: K }>) => boolean) {
    type Item = Extract<MwInboxItem, { kind: K }>
    const mine = (i: MwInboxItem): i is Item => i.kind === kind && match(i as Item)
    const items = await until(`a ${kind} item`, () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST), (xs) => xs.some(mine), 20_000)
    return items.find(mine)!
  }

  /** Staff approve the invite the case is waiting on; returns the email or WhatsApp message it sent. */
  async function approveInvite(id: string) {
    const item = await itemFor(staff, 'approval', (i) => i.caseId === id)
    if (item.kind !== 'approval') throw new Error('not an approval')
    expect(item.tool).toBe('external.invite')
    expect(item.effect).toBe('outbound')
    const r = await api.call(staff, ch.INBOX_DECIDE_APPROVAL, { approvalId: item.approvalId, status: 'approved' })
    expect(r).toMatchObject({ applied: true })
    return item
  }

  const call = async <T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> => {
    const res = await fetch(url, init)
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* html */ }
    return { status: res.status, body: body as T, headers: res.headers }
  }
  const json = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })

  beforeAll(async () => {
    // The page the client opens: build it once if this checkout hasn't.
    if (!existsSync(join(FORM_APP, 'dist', 'index.html'))) {
      const b = Bun.spawnSync(['bun', 'run', 'build'], { cwd: FORM_APP, stdout: 'pipe', stderr: 'pipe' })
      if (b.exitCode !== 0) throw new Error(`building the form app failed: ${b.stderr.toString()}`)
    }
    sink = await startSmtpSink()
    wa = await startFakeWhatsApp({ token: 'wa-test-token', phoneNumberId: '1098765' })
    relay = startBunRelay({ port: 0, hostname: '127.0.0.1', log: quiet })
    env('MEMWISE_PUBLIC_URL', undefined)
    env('MEMWISE_RELAY_URL', undefined)
    env('MEMWISE_BUSINESS_NAME', BUSINESS)
    env('SMTP_HOST', '127.0.0.1')
    env('SMTP_PORT', String(sink.port))
    env('SMTP_SECURE', 'none')
    env('SMTP_FROM', `${BUSINESS} <office@acme.example>`)
    env('WHATSAPP_TOKEN', 'wa-test-token')
    env('WHATSAPP_PHONE_NUMBER_ID', '1098765')
    env('WHATSAPP_API_BASE', wa.apiBase)

    db = await createTestDatabase('mw_exit5', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit5-'))
    // Settings → Public address, turned on with the local relay.
    mkdirSync(join(dir, 'relay'), { recursive: true })
    writeFileSync(join(dir, 'relay', 'settings.json'), JSON.stringify({ enabled: true, relayUrl: relay.url }))
    // The real channel plugins' tools under the channel names (what binding email-smtp and
    // whatsapp-cloud gives a domain): email over SMTP, WhatsApp through the Cloud API.
    const real = channelTools()
    const rename = (from: string, to: string): ToolDefinition => ({ ...real.find((t) => t.name === from)!, name: to })
    const started = await startMemwiseService({
      configDir: dir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: (input) => scriptedModels(input, 'full-intake'),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@example.com' },
      tools: [rename(EMAIL_SMTP_BUILTIN, 'email.send'), rename(WHATSAPP_CLOUD_BUILTIN, 'whatsapp.send')],
      formAppDir: join(FORM_APP, 'dist'),
    })
    svc = started!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const priya = await svc.kernel.people.create({ name: 'Priya Nair', email: 'priya@example.com', roles: ['staff'] })
    const ravi = await svc.kernel.people.create({ name: 'Ravi Kumar', email: 'ravi@example.com', roles: ['manager'] })
    staff = ctxFor('staff-client', priya.id)
    manager = ctxFor('manager-client', ravi.id)
    ownerCtx = ctxFor('owner-client', svc.owner.id)
    browser = await loadBrowser()
    if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  }, 180_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await svc?.stop()
    resetMemwiseHost()
    await relay?.stop()
    await sink?.close()
    await wa?.close()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }, 60_000)

  it('has a public address through the relay', async () => {
    const status = await until('the tunnel', () => api.call(ownerCtx, ch.RELAY_STATUS), (s: any) => s.state === 'connected' || s.state === 'error', 20_000)
    expect(status).toMatchObject({ enabled: true, state: 'connected', relayUrl: relay.url, source: 'relay' })
    expect(status.publicUrl).toBe(`${relay.url}/x/${status.installId}`)
    expect(await api.call(staff, ch.CHANNELS_AVAILABLE)).toMatchObject({ email: { tool: 'email.send' }, whatsapp: { tool: 'whatsapp.send' } })
    // The manager wants their inbox by email (23 §6).
    expect(await api.call(manager, ch.NOTIFY_SET, { email: true })).toMatchObject({ email: true })
  })

  it('staff send the client a link, after approving the email', async () => {
    const started = await api.call(staff, ch.CASES_START, { workflowId: 'client-intake', values: {} })
    caseId = started.caseId
    const prepare = await itemFor(staff, 'input', (i) => i.caseId === caseId && i.stepRunId.endsWith('/prepare'))
    if (prepare.kind !== 'input') throw new Error('no prepare form')
    expect(await api.call<unknown>(staff, ch.INBOX_SUBMIT, {
      stepRunId: prepare.stepRunId, outcome: 'send_link',
      values: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', contact_by: 'email' },
    })).toEqual({ applied: true })

    // Outbound needs approval: the card shows the exact message, with the link hidden until it exists.
    const approval = await approveInvite(caseId)
    expect(JSON.stringify(approval.preview)).toContain('asha@acme-traders.example')
    expect(JSON.stringify(approval.preview)).toContain(BUSINESS)

    const mail = await sink.waitFor((m) => m.to.includes('asha@acme-traders.example'), 20_000)
    expect(subjectOf(mail)).toContain(BUSINESS)
    firstLink = linkIn(textOf(mail), 'f')
    expect(firstLink.startsWith(`${svc.publicAddress.publicUrl()}/f/mwl_`)).toBe(true)
    expect(textOf(mail)).toContain('can be used once')
    await caseAt(caseId, 'fill')

    // While the client has an open link, the form is not in the staff inbox; the case shows the link.
    const inbox = await api.call<MwInboxItem[]>(staff, ch.INBOX_LIST)
    expect(inbox.some((i) => i.kind === 'input' && i.caseId === caseId)).toBe(false)
    const view = await api.call<MwCase>(staff, ch.CASES_GET, caseId)
    expect(view.links?.[0]).toMatchObject({ status: 'open', stepId: 'fill', via: 'email', participant: { name: 'Asha Rao' } })
    expect(view.deliveries?.[0]).toMatchObject({ channel: 'email', purpose: 'invite', to: 'asha@acme-traders.example', status: 'sent' })
  }, 60_000)

  it('the client fills the form from their phone: documents read, a draft kept, sent once', async () => {
    // The page itself, through the relay: the shell, with its headers.
    const page = await fetch(firstLink)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(await page.text()).toContain('../assets/form/')

    const form = await call<ExternalForm>(`${firstLink}/api/form`)
    expect(form.body).toMatchObject({ status: 'open', business: BUSINESS, participant: { name: 'Asha Rao' } })
    expect(form.body.fields.map((f) => f.name)).toEqual(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents'])
    expect(form.body.extract).toMatchObject({ documentsField: 'documents', minConfidence: 0.8 })
    // Only this step's fields: nothing else of the case reaches the page.
    expect(JSON.stringify(form.body)).not.toContain(caseId)

    if (browser) await fillInBrowser(firstLink, 'first')
    else await fillByRequests(firstLink)

    // Sent once: the link is used, a second send is refused.
    const again = await call(`${firstLink}/api/submit`, json({ values: { client_name: 'Someone else' } }))
    expect(again.body).toMatchObject({ status: 'used' })
    await caseAt(caseId, 'verify')
  }, 120_000)

  it('the manager sends it back; the client gets a new link, sees why, and sends it again', async () => {
    const verify = await itemFor(manager, 'decision', (i) => i.caseId === caseId)
    if (verify.kind !== 'decision') throw new Error('no decision')
    const comment = 'Please upload a clearer GST certificate.'
    expect(await api.call<unknown>(manager, ch.INBOX_SUBMIT, { stepRunId: verify.stepRunId, outcome: 'sent_back', comment })).toEqual({ applied: true })

    await approveInvite(caseId)
    const second = await sink.waitFor((m) => m.to.includes('asha@acme-traders.example') && linkIn(textOf(m), 'f') !== firstLink, 20_000)
    secondLink = linkIn(textOf(second), 'f')
    await caseAt(caseId, 'fill')

    // The old link is used; the new one shows the manager's comment by first name and what the client sent before.
    expect((await call(`${firstLink}/api/form`)).body).toMatchObject({ status: 'used' })
    const form = await call<ExternalForm>(`${secondLink}/api/form`)
    expect(form.body.status).toBe('open')
    expect(form.body.comments.some((c) => c.from === 'Ravi' && c.text.includes('clearer GST certificate'))).toBe(true)
    expect(form.body.fields.find((f) => f.name === 'pan')?.value).toBe(PAN)

    if (browser) await sendAgainInBrowser(secondLink)
    else {
      const up = await call<{ document: { id: string } }>(`${secondLink}/api/files?name=gst-certificate-clear.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: GST_CERT })
      const docs = [...(form.body.fields.find((f) => f.name === 'documents')?.value as unknown[]), up.body.document]
      expect((await call(`${secondLink}/api/submit`, json({ values: { documents: docs } }))).body).toMatchObject({ status: 'applied' })
    }
    await caseAt(caseId, 'verify')
  }, 120_000)

  it('the manager approves from the email about it, and onboarding writes the customer', async () => {
    // The notification for the second approval: one email per item, with a link that decides it.
    const open = await itemFor(manager, 'decision', (i) => i.caseId === caseId)
    const note = await sink.waitFor((m) => m.to.includes('ravi@example.com') && m.data.includes(open.stepRunId), 20_000)
    expect(subjectOf(note)).toContain('Waiting for you')
    const link = linkIn(textOf(note), 'i')
    const item = await call<InboxLinkItem>(`${link}/api/item`)
    expect(item.body).toMatchObject({ status: 'open', kind: 'decision', person: 'Ravi' })
    expect(item.body.outcomes?.map((o) => o.id)).toEqual(['approved', 'sent_back'])
    if (browser) await decideInBrowser(link)
    else expect((await call(`${link}/api/decide`, json({ outcome: 'approved' }))).body).toMatchObject({ status: 'applied' })
    // Single use.
    expect((await call(`${link}/api/decide`, json({ outcome: 'approved' }))).body).toMatchObject({ status: 'used' })

    const done = await caseAt(caseId, 'end')
    expect(done.status).toBe('done')
    const customers = await api.call(staff, ch.ENTITIES_LIST, 'Customer')
    expect(customers).toEqual([expect.objectContaining({
      values: expect.objectContaining({ name: expect.objectContaining({ value: 'Asha Rao' }), gstin: expect.objectContaining({ value: GSTIN }), pan: expect.objectContaining({ value: PAN }) }),
    })])

    // Provenance: what the client typed is theirs and untrusted; what staff entered and the client
    // left as it was stays the staff's; what was read from a document and kept says so.
    const values = done.values
    expect(values.annual_turnover!.provenance).toMatchObject({ kind: 'external', by: 'Asha Rao' })
    expect(values.annual_turnover!.tainted).toBe(true)
    expect(values.client_email!.provenance).toMatchObject({ kind: 'person', by: staff.personId })
    expect(values.pan!.provenance).toMatchObject({ kind: 'tool', tool: 'intake.extract_fields', document: 'pan-card.pdf' })
    expect((values.pan!.provenance as { confidence?: number }).confidence).toBeGreaterThanOrEqual(0.8)
    // The verify step was decided through the email link, as Ravi.
    const verifyRuns = done.timeline.filter((s) => s.stepId === 'verify')
    expect(verifyRuns.at(-1)).toMatchObject({ outcome: 'approved' })
  }, 120_000)

  it('sends a WhatsApp invite, and refuses revoked and expired links in plain words', async () => {
    const started = await api.call(staff, ch.CASES_START, { workflowId: 'client-intake', values: {} })
    const prepare = await itemFor(staff, 'input', (i) => i.caseId === started.caseId && i.stepRunId.endsWith('/prepare'))
    if (prepare.kind !== 'input') throw new Error('no prepare form')
    await api.call(staff, ch.INBOX_SUBMIT, {
      stepRunId: prepare.stepRunId, outcome: 'send_link',
      values: { client_name: 'Meera Iyer', client_email: 'meera@example.com', client_phone: '+919845012345', contact_by: 'whatsapp' },
    })
    await approveInvite(started.caseId)
    const msg = await until('the WhatsApp message', async () => wa.messages, (ms) => ms.length > 0, 20_000)
    expect(msg[0]!.body.to.replace(/\D/g, '')).toBe('919845012345')
    const waLink = linkIn(JSON.stringify(msg[0]!.body), 'f')
    await caseAt(started.caseId, 'fill')
    expect((await call(`${waLink}/api/form`)).body).toMatchObject({ status: 'open', participant: { name: 'Meera Iyer' } })

    // Staff copy a link to send themselves, then revoke it.
    const run = (await api.call<MwCase>(staff, ch.CASES_GET, started.caseId)).runId
    const copied = await api.call(staff, ch.EXTERNAL_ISSUE, { runId: run, stepId: 'fill', participant: { name: 'Meera Iyer' } })
    expect(copied.url).toMatch(/\/f\/mwl_/)
    expect(await api.call(staff, ch.EXTERNAL_REVOKE, copied.link.id)).toMatchObject({ applied: true })
    const revoked = await call<{ status: string; message: string }>(`${copied.url}/api/form`)
    expect(revoked.body.status).toBe('revoked')
    expect(revoked.body.message.length).toBeGreaterThan(10)

    // A link that has run out.
    const priya = await svc.kernel.people.actorFor(staff.personId!)
    const short = await svc.kernel.external.issueLink({ runId: run, stepId: 'fill', participant: { name: 'Meera Iyer' }, by: priya })
    await svc.kernel.pool.query(`update mw.external_links set expires_at = now() - interval '1 second' where id = $1`, [short.link.id])
    expect((await call(`${short.url}/api/form`)).body).toMatchObject({ status: 'expired' })
    if (browser) await shoot(short.url!, 'link-expired')
  }, 120_000)

  it('shows a plain offline page when the core is not connected to the relay', async () => {
    const link = firstLink
    await api.call(ownerCtx, ch.RELAY_CONFIGURE, { enabled: false, relayUrl: relay.url })
    await until('the tunnel to close', async () => (await fetch(`${link}/api/form`)).status, (s) => s === 503, 10_000)
    const page = await fetch(link)
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('offline')
    if (browser) await shoot(link, 'relay-offline')
    await api.call(ownerCtx, ch.RELAY_CONFIGURE, { enabled: true, relayUrl: relay.url })
  }, 60_000)

  // ---------------------------------------------------------------- the client's two ways in

  /** The same requests the page makes: upload, read, a draft, then send with sources. */
  async function fillByRequests(link: string) {
    const upload = async (name: string, data: Uint8Array) =>
      (await call<{ document: { id: string; name: string } }>(`${link}/api/files?name=${name}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: data })).body.document
    const pan = await upload('pan-card.pdf', PAN_CARD)
    const gst = await upload('gst-certificate.pdf', GST_CERT)
    const read = (await call<ExtractResult>(`${link}/api/extract`, json({ documents: [pan.id, gst.id] }))).body
    const panS = read.suggestions.find((s) => s.field === 'pan')!
    const gstS = read.suggestions.find((s) => s.field === 'gstin')!
    expect(panS).toMatchObject({ value: PAN, document: 'pan-card.pdf', found: true, prefill: true })
    expect(gstS).toMatchObject({ value: GSTIN, document: 'gst-certificate.pdf', found: true, prefill: true })
    const values = {
      client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', pan: PAN, gstin: GSTIN,
      annual_turnover: { amount: 42000000, currency: 'INR' }, documents: [pan, gst],
    }
    expect((await call(`${link}/api/draft`, json({ values: { client_name: 'Asha Rao' } }, 'PUT'))).body).toHaveProperty('savedAt')
    expect((await call<ExternalForm>(`${link}/api/form`)).body.fields.find((f) => f.name === 'client_name')?.source).toEqual({ kind: 'draft' })
    expect((await call(`${link}/api/submit`, json({ values, sources: { pan: panS.id, gstin: gstS.id } }))).body).toMatchObject({ status: 'applied' })
  }

  async function shoot(url: string, name: string, scheme: 'light' | 'dark' = 'light') {
    if (!SHOTS || !browser) return
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme })
    await page.goto(url)
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
    await page.close()
  }

  async function phone(scheme: 'light' | 'dark' = 'light') {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', (e: any) => errors.push(String(e)))
    page.on('requestfailed', (r: any) => errors.push(`failed: ${r.url()} ${r.failure()?.errorText ?? ''}`))
    page.on('response', (r: any) => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`) })
    return { page, context, errors }
  }

  const snap = async (page: any, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }) }

  async function fillInBrowser(link: string, prefix: string) {
    const { page, context, errors } = await phone()
    await page.goto(link)
    await page.getByText(`${BUSINESS} asks you to fill in this form`).waitFor({ timeout: 10_000 }).catch(async (e: unknown) => {
      throw new Error(`${String(e)}\n${errors.join('\n')}\n${(await page.content()).slice(0, 1500)}`)
    })
    await snap(page, `${prefix}-01-form`)
    await page.getByLabel(/name/i).first().fill('Asha Rao')
    await page.getByLabel(/email/i).first().fill('asha@acme-traders.example')
    // Choose both documents in one go: the page reads them straight away.
    const dir = mkdtempSync(join(tmpdir(), 'mw-docs-'))
    writeFileSync(join(dir, 'pan-card.pdf'), PAN_CARD)
    writeFileSync(join(dir, 'gst-certificate.pdf'), GST_CERT)
    await page.locator('input[type=file]').first().setInputFiles([join(dir, 'pan-card.pdf'), join(dir, 'gst-certificate.pdf')])
    await page.getByText('from pan-card.pdf').first().waitFor({ timeout: 20_000 })
    await page.getByText('from gst-certificate.pdf').first().waitFor()
    await snap(page, `${prefix}-02-read-from-documents`)
    await page.getByText(/Saved at/).first().waitFor({ timeout: 10_000 })
    // Come back later: the draft is still there.
    await page.reload()
    await page.getByText(/Saved at|from pan-card.pdf/).first().waitFor()
    expect(await page.getByLabel(/name/i).first().inputValue()).toBe('Asha Rao')
    await snap(page, `${prefix}-03-draft-restored`)
    await page.getByLabel(/turnover/i).first().fill('42000000')
    await page.getByRole('button', { name: `Send to ${BUSINESS}` }).click()
    await page.getByText('Thank you, Asha.').waitFor({ timeout: 20_000 })
    await snap(page, `${prefix}-04-sent`)
    // The same link now says it was used.
    await page.reload()
    await page.getByText('This form has already been sent').waitFor()
    await snap(page, `${prefix}-05-link-used`)
    expect(errors).toEqual([])
    await context.close()
    rmSync(dir, { recursive: true, force: true })
  }

  async function sendAgainInBrowser(link: string) {
    const { page, context, errors } = await phone('dark')
    await page.goto(link)
    await page.getByText('Ravi wrote:').waitFor()
    await snap(page, 'second-01-sent-back-comment-dark')
    const dir = mkdtempSync(join(tmpdir(), 'mw-docs-'))
    writeFileSync(join(dir, 'gst-certificate-clear.pdf'), GST_CERT)
    await page.locator('input[type=file]').first().setInputFiles([join(dir, 'gst-certificate-clear.pdf')])
    await page.getByText('gst-certificate-clear.pdf').first().waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: `Send to ${BUSINESS}` }).click()
    await page.getByText('Thank you, Asha.').waitFor({ timeout: 20_000 })
    await snap(page, 'second-02-sent-dark')
    expect(errors).toEqual([])
    await context.close()
    rmSync(dir, { recursive: true, force: true })
  }

  async function decideInBrowser(link: string) {
    const { page, context, errors } = await phone()
    await page.goto(link)
    await page.getByRole('button', { name: /approve/i }).first().waitFor()
    await snap(page, 'manager-01-email-link')
    await page.getByRole('button', { name: /approve/i }).first().click()
    await page.getByRole('button', { name: /^Yes, /i }).click()
    await page.getByText('Done. Your answer is recorded.').waitFor({ timeout: 20_000 })
    await snap(page, 'manager-02-decided')
    expect(errors).toEqual([])
    await context.close()
  }
})
