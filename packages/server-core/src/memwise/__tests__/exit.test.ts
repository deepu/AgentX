/**
 * Phase 2 exit test (19 §11): the app API driven as two people (staff, manager) against a real
 * Postgres with scripted models. Staff start an intake and fill the form on the client's behalf
 * (with documents), the check step runs, the manager approves from the inbox and onboard writes
 * a Customer; a second case is sent back with a comment; live counts show where cases are; and
 * "why was this flagged?" is answered from the step record with citations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { MwCase, MwChange, MwInboxItem } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext, RpcServer } from '../../transport/types'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const WS = 'ws-test'
const quiet = { info() {}, warn() {}, error: (...a: unknown[]) => console.error(...a) }

type Handler = (ctx: RequestContext, ...args: any[]) => Promise<any>

/** A server that records handlers and pushes, so tests call channels the way clients do. */
function fakeServer() {
  const handlers = new Map<string, Handler>()
  const pushes: { channel: string; args: unknown[] }[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler as Handler) },
    push(channel, _target, ...args) { pushes.push({ channel, args }) },
    async invokeClient() {},
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const call = async <T = any>(ctx: RequestContext, channel: string, ...args: unknown[]): Promise<T> => {
    const h = handlers.get(channel)
    if (!h) throw new Error(`no handler for ${channel}`)
    return h(ctx, WS, ...args)
  }
  return { server, handlers, pushes, call }
}

function fakeSessions() {
  const created: { workspaceId: string; name?: string; id: string }[] = []
  const sent: { sessionId: string; message: string; hidden?: boolean }[] = []
  return {
    created,
    sent,
    manager: {
      async createSession(workspaceId: string, options?: { name?: string }) {
        const id = `session-${created.length + 1}`
        created.push({ workspaceId, name: options?.name, id })
        return { id, workspaceId, name: options?.name } as any
      },
      async sendMessage(sessionId: string, message: string, _a?: unknown, _b?: unknown, options?: { hidden?: boolean }) {
        sent.push({ sessionId, message, hidden: options?.hidden })
      },
    },
  }
}

const ctxFor = (clientId: string, personId?: string): RequestContext => ({ clientId, workspaceId: WS, webContentsId: null, ...(personId ? { personId } : {}) })

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 500)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe.skipIf(!postgresAvailable())('Phase 2 exit: intake through the app API', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  let staff: RequestContext
  let manager: RequestContext
  const admin = ctxFor('admin-client')

  const filled = (docs: unknown[]) => ({
    client_name: 'Asha Rao',
    client_email: 'asha@acme-traders.example',
    pan: 'AAACA1234A',
    gstin: '29AAACA1234A1Z5',
    annual_turnover: { amount: 42000000, currency: 'INR' },
    documents: docs,
  })

  async function caseAt(caseId: string, state: string): Promise<MwCase> {
    return until(`case ${caseId} at ${state}`, () => api.call<MwCase>(staff, ch.CASES_GET, caseId), (c) => c.state === state || c.status === 'stopped')
  }

  async function startAndFill(): Promise<MwCase> {
    const started = await api.call(staff, ch.CASES_START, { workflowId: 'client-intake', values: {} })
    expect(started.state).toBe('fill')
    expect(started.waitingOn).toEqual({ kind: 'role', role: 'staff' })

    // The driver opens the fill step just after the run starts.
    const inbox = await until('the fill form', () => api.call<MwInboxItem[]>(staff, ch.INBOX_LIST),
      (items) => items.some((i) => i.kind === 'input' && i.caseId === started.caseId), 15_000)
    const form = inbox.find((i) => i.kind === 'input' && i.caseId === started.caseId)
    if (form?.kind !== 'input') throw new Error(`no fill form in the staff inbox: ${JSON.stringify(inbox)}`)
    expect(form.fields.map((f) => f.name)).toEqual(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents'])
    expect(form.fields.find((f) => f.name === 'pan')?.schema).toMatchObject({ type: 'string' })
    expect(form.outcomes).toEqual(['submitted'])

    const pan = await api.call(staff, ch.FILES_UPLOAD, { name: 'pan-card.pdf', mime: 'application/pdf', data: b64('PAN AAACA1234A') })
    const gst = await api.call(staff, ch.FILES_UPLOAD, { name: 'gst-certificate.pdf', mime: 'application/pdf', data: b64('GSTIN 29AAACA1234A1Z5') })
    expect(pan).toMatchObject({ name: 'pan-card.pdf', mime: 'application/pdf' })
    expect(pan.sha256).toMatch(/^[0-9a-f]{64}$/)

    const submitted = await api.call(staff, ch.INBOX_SUBMIT, { stepRunId: form.stepRunId, outcome: 'submitted', values: filled([pan, gst]) })
    expect(submitted).toEqual({ applied: true })
    return caseAt(started.caseId, 'verify')
  }

  async function verifyItem(who: RequestContext, caseId: string) {
    const inbox = await until('the approval in the inbox', () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST),
      (items) => items.some((i) => i.kind === 'decision' && i.caseId === caseId), 10_000).catch(() => null)
    return inbox?.find((i) => i.kind === 'decision' && i.caseId === caseId)
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_exit', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit-'))
    const started = await startMemwiseService({
      configDir: dir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: (input) => scriptedModels(input, 'clean-application'),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@example.com' },
    })
    svc = started!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const priya = await svc.kernel.people.create({ name: 'Priya', email: 'priya@example.com', roles: ['staff'] })
    const ravi = await svc.kernel.people.create({ name: 'Ravi', email: 'ravi@example.com', roles: ['manager'] })
    staff = ctxFor('staff-client', priya.id)
    manager = ctxFor('manager-client', ravi.id)
  }, 120_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('reports status, people and the playbook', async () => {
    const status = await api.call(staff, ch.STATUS)
    expect(status).toMatchObject({ ready: true, canActAs: false, modelConfigured: true, me: { name: 'Priya', roles: ['staff'] } })
    expect(svc.seeded).toBe(true)

    const asAdmin = await api.call(admin, ch.STATUS)
    expect(asAdmin).toMatchObject({ canActAs: true, me: { email: 'owner@example.com' } })

    const roles = await api.call(staff, ch.ROLES_LIST)
    expect(roles.map((r: { id: string }) => r.id).sort()).toEqual(['finance', 'manager', 'staff'])
    const people = await api.call(staff, ch.PEOPLE_LIST)
    expect(people.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['Owner', 'Priya', 'Ravi']))
    await expect(api.call(staff, ch.PEOPLE_ACT_AS, people[0].id)).rejects.toThrow()

    const list = await api.call(staff, ch.PLAYBOOKS_LIST)
    expect(list).toEqual([expect.objectContaining({ id: 'client-intake', title: 'Client intake', stepCount: 4 })])
    const pb = await api.call(staff, ch.PLAYBOOKS_GET, 'client-intake')
    expect(pb.states[0].id).toBe('fill')
    expect(pb.steps.verify).toMatchObject({ performer: 'person', assignee: 'manager', outcomes: ['approved', 'sent_back'] })
    expect(pb.steps.check.policy).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'outbound', value: 'needs approval', layer: 'domain', layerName: 'Domain policy' }),
    ]))
    expect(pb.caseFields.find((f: { name: string }) => f.name === 'gstin').schema).toMatchObject({ type: 'string' })

    const types = await api.call(staff, ch.ENTITIES_TYPES)
    expect(types.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['Customer', 'Engagement']))
  })

  let firstCase: MwCase

  it('staff fill the form with documents; the check runs; the manager sees the approval', async () => {
    firstCase = await startAndFill()
    expect(firstCase.state).toBe('verify')
    expect(firstCase.title).toBe('Asha Rao')
    expect(firstCase.waitingOn).toEqual({ kind: 'role', role: 'manager' })
    expect(firstCase.values.client_name).toMatchObject({ value: 'Asha Rao', provenance: { kind: 'person' } })
    expect(firstCase.values.gstin_ok?.value).toBe(true)
    expect(firstCase.timeline.map((t) => [t.stepId, t.status])).toEqual([['fill', 'completed'], ['check', 'completed'], ['verify', 'waiting']])
    expect(firstCase.path.slice(0, 3)).toEqual(['fill', 'check', 'verify'])

    const item = await verifyItem(manager, firstCase.caseId)
    expect(item).toMatchObject({ kind: 'decision', caseTitle: 'Asha Rao', stepTitle: 'Manager approves onboarding', outcomes: ['approved', 'sent_back'] })
  }, 120_000)

  it('a staff person cannot approve the manager\'s step', async () => {
    expect(await verifyItem(staff, firstCase.caseId)).toBeUndefined()
    const verifyRun = (await api.call<MwInboxItem[]>(manager, ch.INBOX_LIST)).find((i) => i.kind === 'decision' && i.caseId === firstCase.caseId)!
    const r = await api.call(staff, ch.INBOX_SUBMIT, { stepRunId: (verifyRun as { stepRunId: string }).stepRunId, outcome: 'approved' })
    expect(r.applied).toBe(false)
    expect(r.message).toBeTruthy()
    expect((await api.call<MwCase>(staff, ch.CASES_GET, firstCase.caseId)).state).toBe('verify')
  }, 60_000)

  it('the manager approves; onboard writes the Customer', async () => {
    const item = await verifyItem(manager, firstCase.caseId)
    const r = await api.call(manager, ch.INBOX_SUBMIT, { stepRunId: (item as { stepRunId: string }).stepRunId, outcome: 'approved' })
    expect(r).toEqual({ applied: true })
    const done = await until('case 1 done', () => api.call<MwCase>(manager, ch.CASES_GET, firstCase.caseId), (c) => c.status !== 'active')
    expect(done.status).toBe('done')
    expect(done.timeline.find((t) => t.stepId === 'verify')).toMatchObject({ outcome: 'approved', decidedBy: expect.any(String) })

    const customers = await api.call(manager, ch.ENTITIES_LIST, 'Customer')
    expect(customers).toHaveLength(1)
    expect(customers[0].values.name.value).toBe('Asha Rao')
    expect(customers[0].values.gstin.value).toBe('29AAACA1234A1Z5')
    expect(done.values.customer?.value).toBe(customers[0].id)
  }, 120_000)

  it('a second case is sent back with a comment and is back at fill with the comment visible', async () => {
    const second = await startAndFill()
    const item = await verifyItem(manager, second.caseId)
    const comment = 'Please attach a clearer scan of the PAN card.'
    const r = await api.call(manager, ch.INBOX_SUBMIT, { stepRunId: (item as { stepRunId: string }).stepRunId, outcome: 'sent_back', comment })
    expect(r.applied).toBe(true)
    const back = await caseAt(second.caseId, 'fill')
    expect(back.state).toBe('fill')
    expect(back.timeline.find((t) => t.stepId === 'verify')).toMatchObject({ outcome: 'sent_back', comment })
    const form = (await api.call<MwInboxItem[]>(staff, ch.INBOX_LIST)).find((i) => i.kind === 'input' && i.caseId === second.caseId)
    expect(form?.kind).toBe('input')
    if (form?.kind === 'input') {
      expect(form.prefill.client_name?.value).toBe('Asha Rao')
      // The form says who sent it back and why.
      expect(form.returned).toMatchObject({ stepTitle: 'Manager approves onboarding', outcome: 'sent_back', text: comment })
    }

    const summaries = await api.call(staff, ch.CASES_LIST, { workflowId: 'client-intake' })
    expect(summaries).toHaveLength(2)
    const live = await api.call(staff, ch.PLAYBOOKS_LIVE, 'client-intake')
    expect(live.byState.fill).toBe(1)
    expect(live.edges['check>verify']).toBe(2)
    expect(live.edges['verify>fill']).toBe(1)
    const pbs = await api.call(staff, ch.PLAYBOOKS_LIST)
    expect(pbs[0]).toMatchObject({ open: 1, done: 1, waitingOnMe: 1 })
  }, 180_000)

  it('"why was this flagged?" is answered from the step record with citations', async () => {
    const check = firstCase.timeline.find((t) => t.stepId === 'check')!
    const record = await api.call(manager, ch.STEPS_GET, check.stepRunId)
    expect(record).toMatchObject({ stepId: 'check', title: "Check the client's answers", outcome: 'checked' })
    expect(record.journal.some((j: { kind: string; name: string }) => j.kind === 'tool' && j.name === 'gst.validate_gstin')).toBe(true)

    const e = await api.call(manager, ch.STEPS_EXPLAIN, { stepRunId: check.stepRunId, question: 'Why was this flagged?' })
    expect(e.grounded).toBe(true)
    expect(e.answer.length).toBeGreaterThan(10)
    expect(e.cites.length).toBeGreaterThan(0)
    expect(e.cites.some((c: { kind: string }) => c.kind === 'journal')).toBe(true)
  }, 60_000)

  it('opens a chat anchored to a step with the record as hidden context', async () => {
    const check = firstCase.timeline.find((t) => t.stepId === 'check')!
    const { sessionId } = await api.call(manager, ch.CHAT_OPEN, { anchor: { kind: 'step', id: check.stepRunId } })
    expect(sessionId).toBe(sessions.created.at(-1)!.id)
    expect(sessions.created.at(-1)).toMatchObject({ workspaceId: WS, name: 'About Asha Rao' })
    const first = sessions.sent.find((m) => m.sessionId === sessionId)!
    expect(first.hidden).toBe(true)
    expect(first.message).toContain('Asha Rao')
    expect(first.message).toContain('gst.validate_gstin')
    const { rows } = await svc.kernel.pool.query('select anchor_kind, anchor_id from mw.chat_anchors where chat_id = $1', [sessionId])
    expect(rows[0]).toEqual({ anchor_kind: 'step', anchor_id: check.stepRunId })
  }, 60_000)

  it('pushes memwise:changed as runs move', () => {
    const changes = api.pushes.filter((p) => p.channel === ch.CHANGED).map((p) => p.args[0] as MwChange)
    expect(changes.some((c) => c.kind === 'run' && c.workflowId === 'client-intake')).toBe(true)
  })
})
