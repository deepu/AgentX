/**
 * Stage 5 exit test (docs/memwise/26-projects-and-pages.md §11 "Stage 5"): regulated projects on
 * the eTMF example, through the app API, the chat's tools and the public routes, against a real
 * Postgres with fake models (runtime/tests/fixtures/regulated-fakes.ts: a classifier that reads the
 * CV's file name, a verifier that fails a signature rule on an unsigned CV).
 *
 * 1. Last month: three CVs filed through "File a TMF document"; QC approved two and sent back the
 *    unsigned one. The walkthrough seed opens CR-014 on that playbook and the MHRA inspection link.
 * 2. CR-014 is edited from its chat: QC is skipped for CVs that pass every AI check. The chat's
 *    `playbook_check` validates it on the past CVs: 2 of 3 match QC (the AI checks would have
 *    passed the unsigned CV), so it fails. Fixed from the chat (a signed-and-dated rule on the AI
 *    check): 3 of 3. `playbook_finish` is refused: only signatures move it.
 * 3. The raiser signs it to QA (a wrong password signs nothing); QA's inbox has it; QA signs and
 *    version 2 goes live. A CV that arrived before finishes on version 1; a new one runs on 2.
 * 4. The project's audit trail has the AI entry with its model and quote, the signatures and the
 *    change; the signed export verifies, a tampered one doesn't.
 * 5. The MHRA link (public `/v/<token>`) shows filed documents, signatures and their trail only, no
 *    drafts, chats or change requests; every view and download is logged; a question reaches the
 *    study manager's inbox and the answer comes back; an expired link opens nothing.
 * 6. The TMF index counts the zone and site documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type {
  MwAuditExport, MwAuditLog, MwAuditVerifyResult, MwChangeRequest, MwChangeSignResult, MwOpenChangeResult, MwInboxItem, MwInspectorLink, MwInspectorQuestion,
  MwChangeRequestSummary,
  MwTmfIndex,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { PersonActor } from '@memwise/runtime'
import { seedRegulatedWalkthrough } from '@memwise/runtime'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import { registerMemwiseRegulatedHandlers } from '../../handlers/rpc/memwise-regulated'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { buildMemwiseToolCallbacks } from '../chat-tools'
import { startMemwiseService, type MemwiseService } from '../service'
import {
  answerQc, cvFile, FAKE_CLASSIFIER_MODEL, FAKE_VERIFIER_MODEL, fakeRegulatedProvider, fileAtQc, type FakeIndex,
} from '../../../../runtime/tests/fixtures/regulated-fakes'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const PASSWORD = 'a long enough password'
const SIGNED_RULE = 'A CV is signed and dated by the person it is about.'
const QC_PATH = 'domains/etmf/workflows/file-document/steps/qc.md'
/** Screenshots of the inspector's page (EInspector) are written here when it is set. */
const SHOTS = process.env.MEMWISE_WALKTHROUGH_DIR
const CLASSIFY_PATH = 'domains/etmf/workflows/file-document/steps/classify.md'

describe.skipIf(!postgresAvailable())('Stage 5 exit: a regulated project on the eTMF example', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  const index = new Map<string, FakeIndex>()
  const ids: Record<string, string> = {}
  let anika: PersonActor
  let tom: PersonActor
  let grace: PersonActor
  let anikaCtx: RequestContext
  let tomCtx: RequestContext
  let graceCtx: RequestContext
  let crId: string
  let chatId: string
  let inspectorToken: string
  let unsignedCase = ''
  let oldCase = ''
  let liveHash = ''

  const kernel = () => svc.kernel
  const create = async (entity: string, values: Record<string, unknown>) => {
    const r = await kernel().records.create({ entity, values, reason: 'study set-up' }, { kind: 'system' })
    if (!r.applied) throw new Error(`${entity}: ${r.status} ${r.message ?? ''}`)
    return r.id!
  }
  async function cvFor(site: string, person: string, name: string, signed: boolean, daysOld = 2) {
    const expected = await create('etmf.ExpectedDocument', { site: ids[site], study: ids.study, artifact: 'Investigator CV', phase: 'start_up' })
    index.set(name, {
      artifact: 'Investigator CV', study: ids.study!, site: ids[site]!, about: ids[person]!, expected_document: expected,
      document_date: new Date(Date.now() - daysOld * 86_400_000).toISOString().slice(0, 10), version: '1', signed,
    })
    return kernel().saveFile(cvFile(name), { kind: 'system' })
  }
  const inbox = (who: RequestContext) => api.call<MwInboxItem[]>(who, ch.INBOX_LIST)
  const publicGet = async (path: string) => svc.publicHandler(new Request(`http://core.test${path}`, { headers: { 'x-memwise-client-ip': '203.0.113.9' } }))
  const publicJson = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
    const res = init
      ? await svc.publicHandler(new Request(`http://core.test${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-memwise-client-ip': '203.0.113.9' } }))
      : await publicGet(path)
    return res.json() as Promise<T>
  }

  /** The inspector's page in a browser, through the public handler on a free port (Playwright, when this machine has it). */
  async function shootInspector(token: string) {
    let pw: any
    for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright/index.mjs']) {
      try { pw = await import(spec); break } catch { /* next */ }
    }
    if (!pw) return
    mkdirSync(SHOTS!, { recursive: true })
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => {
      const headers = new Headers(req.headers)
      headers.set('x-memwise-client-ip', '203.0.113.9')
      return svc.publicHandler(new Request(req, { headers }))
    } })
    const browser = await pw.chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })
      const shot = (name: string) => page.screenshot({ path: join(SHOTS!, `${name}.png`) })
      await page.goto(`http://127.0.0.1:${server.port}/v/${token}`)
      await page.locator('[data-inspector]').waitFor({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')
      await shot('EInspector-01-index')
      await page.locator('[data-zone="05"]').click()
      await page.locator('[data-doc]').first().waitFor({ timeout: 10_000 })
      await page.locator('[data-doc]').first().click()
      await page.locator('[data-document]').waitFor({ timeout: 10_000 })
      await page.waitForLoadState('networkidle')
      await shot('EInspector-02-document')
      await page.locator('[data-action="trail"]').click()
      await page.locator('[data-trail]').waitFor({ timeout: 10_000 })
      await shot('EInspector-03-trail')
      await page.locator('[data-action="ask"]').click()
      await page.locator('[data-ask] textarea').fill('Please show the site 109 CV that was sent back.')
      await shot('EInspector-04-ask')
      const requests = page.locator('[data-requests]')
      if (await requests.count()) { await requests.first().scrollIntoViewIfNeeded(); await shot('EInspector-05-requests') }
    } finally {
      await browser.close()
      server.stop(true)
    }
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_exit_stage5', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-stage5-'))
    const projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    const provider = fakeRegulatedProvider(index)
    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: async (input) => ({
        modelRoles: Object.fromEntries([...new Set([...input.roles, 'verifier', 'classifier'])].map((r) => [r, { provider: 'fake', model: r === 'verifier' ? FAKE_VERIFIER_MODEL : FAKE_CLASSIFIER_MODEL }])),
        providers: [provider],
        configured: true,
        message: 'fake models',
      }),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
    }))!
    const deps = { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps
    registerMemwiseHandlers(api.server, deps)
    registerMemwiseRegulatedHandlers(api.server, deps)
    const person = async (name: string, roles: string[]) =>
      kernel().people.actorFor((await kernel().people.create({ name, email: `${name.split(' ')[0]!.toLowerCase()}@northlight.example`, roles, password: PASSWORD })).id)
    anika = await person('Anika Rao', ['study_manager'])
    tom = await person('Tom Okafor', ['tmf_specialist'])
    grace = await person('Grace Lee', ['qa'])
    anikaCtx = ctxFor('anika-client', anika.personId)
    tomCtx = ctxFor('tom-client', tom.personId)
    graceCtx = ctxFor('grace-client', grace.personId)

    ids.sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' })
    ids.study = await create('etmf.Study', { code: 'MW-301', title: 'Aster-1 in advanced solid tumours', sponsor: ids.sponsor })
    for (const n of ['101', '104', '109']) {
      ids[`site${n}`] = await create('etmf.Site', { site_number: n, study: ids.study })
      ids[`pi${n}`] = await create('etmf.Person', { name: `Dr. PI ${n}`, role: 'Principal Investigator', site: ids[`site${n}`] })
    }
    const files = [
      await cvFor('site101', 'pi101', 'Investigator CV - site 101.pdf', true),
      await cvFor('site104', 'pi104', 'Investigator CV - site 104.pdf', true),
      await cvFor('site109', 'pi109', 'Investigator CV - site 109 unsigned.pdf', false),
    ]
    const cases: string[] = []
    for (const f of files) {
      const { caseId } = await fileAtQc(kernel(), f)
      cases.push(caseId)
      if (f.name.includes('unsigned')) unsignedCase = caseId
      await answerQc(kernel(), tom, PASSWORD, caseId, f.name.includes('unsigned') ? 'sent_back' : 'approved')
    }
    for (const c of cases) await until(`case ${c} to leave QC`, () => kernel().getCaseView(c, { kind: 'system' }), (v) => !!v && v.summary.state !== 'qc' && v.summary.state !== 'file')
    liveHash = (await kernel().project()).project.workflows['file-document']!.hash
  }, 300_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('the walkthrough seed: CR-014 on "File a TMF document", the MHRA inspection link, an audit trail with AI entries', async () => {
    const seed = await seedRegulatedWalkthrough(kernel(), { raiser: anika })
    expect(seed.changeRequest).toMatchObject({ label: 'CR-014', workflowId: 'file-document', status: 'open', raisedBy: { name: 'Anika Rao' } })
    expect(seed.inspector.link).toMatchObject({ name: 'MHRA inspection', status: 'active', inspectors: [{ name: 'GCP inspector', organisation: 'MHRA' }] })
    expect(seed.inspector.token).toMatch(/^mwi_/)
    expect(seed.aiEntries).toBeGreaterThan(0)
    crId = seed.changeRequest.id
    inspectorToken = seed.inspector.token!
    // A second run finds what the first made.
    const again = await seedRegulatedWalkthrough(kernel(), { raiser: anika })
    expect(again.changeRequest.id).toBe(crId)
    expect(again.inspector.link.id).toBe(seed.inspector.link.id)
    expect(again.inspector.token).toBeUndefined()

    const list = await api.call(anikaCtx, ch.CHANGES_LIST, { project: 'etmf' })
    expect(list).toEqual([expect.objectContaining({ label: 'CR-014', playbookTitle: expect.any(String), status: 'open' })])
    const cr = await api.call<MwChangeRequest>(anikaCtx, ch.CHANGES_GET, { crId: 'CR-014', project: 'etmf' })
    expect(cr).toMatchObject({ id: crId, regulated: true, liveVersion: 1, nextVersion: 2, can: { edit: true, send: false } })
    // A regulated playbook isn't changed through a change run or a direct publish.
    expect(await api.call(anikaCtx, ch.DRAFTS_SUBMIT, cr.draftId)).toMatchObject({ applied: false, code: 'draft.change_request', message: expect.stringContaining('CR-014'), changeRequest: { id: crId, label: 'CR-014', project: 'etmf' } })
  })

  it('CR-014 is edited from its chat: validation fails 2 of 3, the fix passes 3 of 3, and the chat cannot finish it', async () => {
    const opened = await api.call<{ sessionId: string }>(anikaCtx, ch.CHANGES_CHAT, { crId })
    chatId = opened.sessionId
    expect(sessions.contexts.get(chatId)).toMatchObject({ anchor: { kind: 'change', id: crId }, conversation: true })
    expect(sessions.contexts.get(chatId)!.block).toContain('CR-014')
    expect(sessions.created.find((s) => s.id === chatId)).toMatchObject({ name: expect.stringContaining('CR-014'), permissionMode: 'ask' })
    // Reopening gives the same chat; the request's page knows it.
    expect((await api.call<{ sessionId: string }>(anikaCtx, ch.CHANGES_CHAT, { crId })).sessionId).toBe(chatId)
    expect(await api.call<MwChangeRequest>(anikaCtx, ch.CHANGES_GET, { crId })).toMatchObject({ sessionId: chatId })
    // The project shell finds the same chat by the request's label, and continues it.
    expect(await api.call<unknown>(anikaCtx, ch.CHAT_FIND, { anchor: { kind: 'change', id: 'CR-014', project: 'etmf' } })).toMatchObject({ sessionId: chatId })
    expect(await api.call<{ sessionId: string }>(anikaCtx, ch.CHAT_OPEN, { anchor: { kind: 'change', id: 'CR-014', project: 'etmf' }, reuse: true })).toEqual({ sessionId: chatId })
    // A bare number could be another project's request: calls that change one, or chat on it, need its id or its project.
    await expect(api.call(anikaCtx, ch.CHAT_FIND, { anchor: { kind: 'change', id: 'CR-014' } })).rejects.toThrow(/which project/)
    await expect(api.call(anikaCtx, ch.CHANGES_UPDATE, { crId: 'CR-014', reason: 'x' })).rejects.toThrow(/which project/)

    // The chat's agent, through its playbook tools.
    const tools = buildMemwiseToolCallbacks({ sessionId: chatId })
    const qc = (await tools.read({ path: QC_PATH })) as { content: string }
    const w1 = await tools.write({ summary: 'QC only for CVs the AI checks don\'t pass', files: [{ path: QC_PATH, content: qc.content.replace('title: QC and sign', 'title: QC by the TMF lead, except CVs that pass every AI check') }] })
    expect(w1).toMatchObject({ errors: 0, changeRequest: 'CR-014' })
    await api.call(anikaCtx, ch.CHANGES_UPDATE, { crId, reason: 'QC of CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.' })
    const first = await tools.check({}) as { status: string; passed: number; total: number; mismatches: { caseId: string; ai: string; decided: { outcome: string } }[] }
    expect(first).toMatchObject({ status: 'failed', passed: 2, total: 3 })
    expect(first.mismatches).toEqual([expect.objectContaining({ caseId: unsignedCase, ai: 'pass', decided: expect.objectContaining({ outcome: 'sent_back' }) })])
    expect(await api.call<MwChangeSignResult>(anikaCtx, ch.CHANGES_SIGN, { crId, password: PASSWORD })).toMatchObject({ applied: false, status: 'not-validated' })

    const classify = (await tools.read({ path: CLASSIFY_PATH })) as { content: string }
    await tools.write({ summary: 'The AI check now includes signature and date', files: [{ path: CLASSIFY_PATH, content: classify.content.replace('checkpoint:\n', `checkpoint:\n  - ${SIGNED_RULE}\n`) }] })
    expect(await tools.check({})).toMatchObject({ status: 'passed', passed: 3, total: 3 })
    expect(await tools.finish({ summary: 'done' })).toMatchObject({ applied: false, message: expect.stringContaining('signature') })
    // The live playbook can still be read from the chat; the draft holds the change.
    expect(((await tools.read({ path: CLASSIFY_PATH, live: true })) as { content: string }).content).not.toContain(SIGNED_RULE)

    const cr = await api.call<MwChangeRequest>(anikaCtx, ch.CHANGES_GET, { crId })
    expect(cr.validations.map((v) => [v.passed, v.total, v.status, v.current])).toEqual([[2, 3, 'failed', false], [3, 3, 'passed', true]])
    expect(cr.steps.find((s) => s.stepId === 'classify')!.rules.filter((r) => r.kind === 'added').map((r) => r.text)).toEqual([SIGNED_RULE])
    expect(cr.steps.find((s) => s.stepId === 'qc')!.title.some((t) => t.kind === 'removed')).toBe(true)
    expect(cr.can).toMatchObject({ send: true, approve: false })
  }, 120_000)

  it('the raiser signs it to QA; QA signs and version 2 goes live while a case on version 1 finishes on it', async () => {
    const mine = await inbox(anikaCtx)
    expect(mine.find((i) => i.kind === 'change-request')).toMatchObject({ signoff: 'raiser', caseTitle: expect.stringContaining('CR-014'), workflowId: 'file-document' })
    expect(await api.call(anikaCtx, ch.CHANGES_SIGN, { crId, password: 'not my password' })).toMatchObject({ applied: false, status: 'signature-failed' })
    expect(await api.call(tomCtx, ch.CHANGES_SIGN, { crId, password: PASSWORD })).toMatchObject({ applied: false, status: 'not-your-turn' })
    const sent = await api.call<MwChangeSignResult>(anikaCtx, ch.CHANGES_SIGN, { crId, password: PASSWORD })
    expect(sent).toMatchObject({ applied: true, changeRequest: { status: 'in_review' } })
    expect(sent.changeRequest!.signoffs.map((s) => [s.role, s.status])).toEqual([['raiser', 'signed'], ['qa', 'waiting']])
    // The chat can't change it while QA has it.
    await expect(buildMemwiseToolCallbacks({ sessionId: chatId }).write({ summary: 'x', files: [{ path: QC_PATH, content: 'x' }] })).rejects.toThrow(/in review/)
    // Nor the app's draft editor.
    const draftId = sent.changeRequest!.draftId
    expect(await api.call(anikaCtx, ch.DRAFTS_WRITE, { draftId, summary: 'x', files: [{ path: QC_PATH, content: 'x' }] })).toMatchObject({ applied: false, message: expect.stringMatching(/in review/) })

    // A CV arrives before QA signs: its case pins version 1.
    const old = await fileAtQc(kernel(), await cvFor('site101', 'pi101', 'Investigator CV - site 101 renewal.pdf', true, 45))
    expect((await kernel().getRun(old.runId))!.workflowHash).toBe(liveHash)
    oldCase = old.caseId

    const qaItem = (await until('QA\'s sign-off', () => inbox(graceCtx), (xs) => xs.some((i) => i.kind === 'change-request')))
      .find((i) => i.kind === 'change-request')!
    expect(qaItem).toMatchObject({ signoff: 'qa', changeRequest: { label: 'CR-014', status: 'in_review' } })
    expect(await api.call(tomCtx, ch.CHANGES_SIGN, { crId, password: PASSWORD })).toMatchObject({ applied: false, status: 'forbidden' })
    const signed = await api.call<MwChangeSignResult>(graceCtx, ch.CHANGES_SIGN, { crId, password: PASSWORD })
    expect(signed).toMatchObject({ applied: true, published: { workflowId: 'file-document', version: 2 }, changeRequest: { status: 'published', toVersion: 2 } })
    expect((await inbox(graceCtx)).some((i) => i.kind === 'change-request')).toBe(false)
    const live = (await kernel().project()).project.workflows['file-document']!
    expect(live.version).toBe(2)
    expect(live.steps.classify!.checkpoint).toContain(SIGNED_RULE)

    await answerQc(kernel(), tom, PASSWORD, old.caseId, 'approved')
    expect(await kernel().waitForRun(old.runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 }))
      .toMatchObject({ status: 'done', workflowVersion: 1, workflowHash: liveHash })
    const fresh = await fileAtQc(kernel(), await cvFor('site104', 'pi104', 'Investigator CV - site 104 renewal.pdf', true))
    expect(await kernel().getRun(fresh.runId)).toMatchObject({ workflowVersion: 2, workflowHash: live.hash })
    await answerQc(kernel(), tom, PASSWORD, fresh.caseId, 'approved')
    expect(await kernel().waitForRun(fresh.runId, { until: (r) => r.status !== 'active', timeoutMs: 60_000 })).toMatchObject({ status: 'done', workflowVersion: 2 })
  }, 180_000)

  it('the audit trail: the AI names its model and quote; the signed export verifies and a tampered one fails', async () => {
    const log = await api.call<MwAuditLog>(anikaCtx, ch.AUDIT_LOG, { project: 'etmf', limit: 2000 })
    // The case that finished on version 1 keeps version 1's step titles; one on version 2 has the new ones.
    expect(log.entries.find((e) => e.caseId === oldCase && e.data?.step === 'qc')?.stepTitle).toBe('QC and sign')
    expect(log.entries.some((e) => e.data?.step === 'qc' && e.stepTitle?.startsWith('QC by the TMF lead'))).toBe(true)
    expect(log.chain.ok).toBe(true)
    const ai = log.entries.find((e) => e.actorKind === 'ai' && e.caseId === unsignedCase && e.data.step === 'classify')!
    expect(ai).toMatchObject({ action: 'step.completed', data: { model: FAKE_CLASSIFIER_MODEL, quote: 'Investigator CV' }, stepTitle: expect.any(String) })
    expect(log.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['change.opened', 'change.validated', 'change.published', 'signature.signed', 'record.changed']))
    // One record's trail.
    const doc = log.entries.find((e) => e.action === 'signature.signed' && e.entity === 'etmf.Document')!
    const trail = await api.call<MwAuditLog>(anikaCtx, ch.AUDIT_LOG, { project: 'etmf', entity: 'etmf.Document', recordId: doc.recordId })
    expect(trail.entries.some((e) => e.actorKind === 'ai')).toBe(true)

    const file = await api.call<MwAuditExport>(anikaCtx, ch.AUDIT_LOG_EXPORT, { project: 'etmf' })
    expect(file).toMatchObject({ mime: 'application/json', name: expect.stringMatching(/^audit-trail-etmf-\d{4}-\d{2}-\d{2}\.json$/) })
    const json = Buffer.from(file.dataBase64, 'base64').toString('utf8')
    expect(await api.call<MwAuditVerifyResult>(anikaCtx, ch.AUDIT_VERIFY, { exportJson: json })).toMatchObject({ ok: true, chain: { ok: true }, signature: { ok: true, trusted: true } })
    const tampered = JSON.parse(json)
    const entry = tampered.entries.find((e: { actorKind: string }) => e.actorKind === 'ai')
    entry.data.model = 'a better model'
    expect(await api.call<MwAuditVerifyResult>(anikaCtx, ch.AUDIT_VERIFY, { exportJson: JSON.stringify(tampered) }))
      .toMatchObject({ ok: false, chain: { ok: false, brokenAt: { id: entry.id, reason: 'hash' } } })
    expect(await api.call<MwAuditVerifyResult>(anikaCtx, ch.AUDIT_VERIFY, { exportJson: 'not json' })).toMatchObject({ ok: false })
    expect(await api.call<MwAuditVerifyResult>(anikaCtx, ch.AUDIT_VERIFY, { project: 'etmf' })).toMatchObject({ ok: true, chain: { ok: true } })

    // The chat beside the trail (the project shell): none yet; the person's question starts one
    // whose context is the trail, with its AI entry's model; then it is found and continued.
    const anchor = { kind: 'audit', id: 'etmf' }
    expect(await api.call<unknown>(anikaCtx, ch.CHAT_FIND, { anchor })).toEqual({ sessionId: null, recent: [] })
    const { sessionId } = await api.call<{ sessionId: string }>(anikaCtx, ch.CHAT_OPEN, { anchor, message: 'Who touched the protocol signature page?', reuse: true })
    expect(sessions.contexts.get(sessionId)).toMatchObject({ anchor: { kind: 'audit', id: 'etmf' } })
    expect(sessions.contexts.get(sessionId)!.block).toContain(FAKE_CLASSIFIER_MODEL)
    expect(sessions.contexts.get(sessionId)!.block).toContain('chain intact')
    expect(sessions.sent).toContainEqual(expect.objectContaining({ sessionId, message: 'Who touched the protocol signature page?' }))
    expect(await api.call<unknown>(anikaCtx, ch.CHAT_FIND, { anchor })).toMatchObject({ sessionId })
    expect(await api.call<unknown>(anikaCtx, ch.CHAT_OPEN, { anchor, reuse: true })).toEqual({ sessionId })
  })

  it('the MHRA link: filed documents, signatures and the trail only; every view and download logged; questions go to the study manager', async () => {
    const t = inspectorToken
    // The page itself (the form app's shell) and its API.
    const shell = await publicGet(`/v/${t}`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('text/html')
    const opened = await publicJson(`/v/${t}/api/index`)
    expect(opened.session).toMatchObject({ name: 'MHRA inspection', inspector: 'GCP inspector, MHRA', projectName: 'eTMF' })
    const list = await publicJson<{ documents: { entity: string; id: string; status: string; signatures: { meaning: string }[] }[] }>(`/v/${t}/api/documents?zone=05`)
    expect(list.documents.length).toBe(4)
    expect(list.documents.every((d) => d.status === 'filed' && d.signatures.some((s) => s.meaning === 'Reviewed and approved for filing'))).toBe(true)
    const first = list.documents[0]!
    const q = `entity=${encodeURIComponent(first.entity)}&id=${encodeURIComponent(first.id)}`
    const doc = await publicJson(`/v/${t}/api/document?${q}`)
    const trail = await publicJson<{ entries: { action: string }[] }>(`/v/${t}/api/trail?${q}`)
    if (!trail.entries) throw new Error(`trail: ${JSON.stringify(trail)}`)
    const everything = JSON.stringify([opened, list, doc, trail])
    // No drafts, chats, change requests or AI suggestions.
    expect(everything).not.toMatch(/draft|sessionId|chat|cr_|CR-014|proposal|notes/i)
    expect(trail.entries.length).toBeGreaterThan(3)
    expect(trail.entries.some((e) => /^(change|inspector|audit)\./.test(e.action))).toBe(false)
    const download = await publicGet(`/v/${t}/api/download?${q}`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(new TextDecoder().decode(await download.arrayBuffer())).toContain('%PDF')
    // A record that wasn't filed isn't there, by id either.
    const rejected = (await kernel().getCaseView(unsignedCase, { kind: 'system' }))!.values.document!.value as string
    expect((await publicGet(`/v/${t}/api/document?entity=etmf.Document&id=${rejected}`)).status).toBe(404)
    // Bad parameters and methods are refused before the kernel.
    expect((await publicGet(`/v/${t}/api/document?entity=..%2F&id=x`)).status).toBe(400)
    expect((await svc.publicHandler(new Request(`http://core.test/v/${t}/api/ask`, { method: 'PUT' }))).status).toBe(405)

    const asked = await publicJson<MwInspectorQuestion>(`/v/${t}/api/ask`, { method: 'POST', body: JSON.stringify({ question: 'Why was the site 109 CV sent back?', entity: first.entity, recordId: first.id }) })
    expect(asked).toMatchObject({ question: 'Why was the site 109 CV sent back?' })
    const item = (await until('the inspector\'s question', () => inbox(anikaCtx), (xs) => xs.some((i) => i.kind === 'inspector-question')))
      .find((i) => i.kind === 'inspector-question')!
    expect(item).toMatchObject({ caseTitle: 'Why was the site 109 CV sent back?', stepTitle: 'MHRA inspection' })
    expect((await inbox(tomCtx)).some((i) => i.kind === 'inspector-question')).toBe(false)
    const open = await api.call<MwInspectorQuestion[]>(anikaCtx, ch.INSPECTORS_QUESTIONS, { project: 'etmf', open: true })
    expect(open).toHaveLength(1)
    await api.call(anikaCtx, ch.INSPECTORS_ANSWER, { questionId: open[0]!.id, answer: 'It was not signed; the site sent a signed one on 3 Oct.' })
    const requests = await publicJson<MwInspectorQuestion[]>(`/v/${t}/api/requests`)
    expect(requests[0]).toMatchObject({ answer: expect.stringContaining('not signed'), answeredBy: { name: 'Anika Rao' } })

    // Logged, as the inspector; counted on the setup screen.
    const views = await api.call<MwAuditLog>(anikaCtx, ch.AUDIT_LOG, { project: 'etmf', actorKinds: ['inspector'] })
    expect(views.entries.map((e) => e.action)).toEqual(['inspector.opened', 'inspector.listed', 'inspector.viewed', 'inspector.viewed', 'inspector.downloaded', 'inspector.asked'])
    const [link] = await api.call<MwInspectorLink[]>(anikaCtx, ch.INSPECTORS_LIST, { project: 'etmf' })
    expect(link).toMatchObject({ name: 'MHRA inspection', views: 4, downloads: 1, questions: { open: 0, answered: 1 } })
    if (SHOTS) await shootInspector(t)
    // Only the domain's owner gives inspectors access.
    await expect(api.call(tomCtx, ch.INSPECTORS_CREATE, { project: 'etmf', name: 'x', inspectors: [{ name: 'y' }], expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toThrow()

    // Past its end date it opens nothing; revoked, neither.
    await db.pool.query(`update mw.inspector_links set expires_at = now() - interval '1 minute' where id = $1`, [link!.id])
    expect(await publicJson<unknown>(`/v/${t}/api/index`)).toEqual({ refused: 'expired' })
    await api.call(anikaCtx, ch.INSPECTORS_REVOKE, { linkId: link!.id })
    expect(await publicJson<unknown>(`/v/${t}/api/documents`)).toEqual({ refused: 'revoked' })
    expect(await publicJson<unknown>(`/v/mwi_${'x'.repeat(43)}/api/index`)).toEqual({ refused: 'unknown' })
  }, 60_000)

  it('the TMF index: zones, and a zone\'s sites and documents', async () => {
    const tmf = await api.call<MwTmfIndex>(anikaCtx, ch.TMF_INDEX, { project: 'etmf' })
    expect(tmf.zones).toHaveLength(11)
    expect(tmf.zones.find((z) => z.number === '05')).toMatchObject({ id: 'site-management', expected: 5, filed: 4, missing: 1, filedLate: 1 })
    const zone = await api.call<MwTmfIndex>(anikaCtx, ch.TMF_INDEX, { project: 'etmf', zone: '05' })
    expect(zone.zone!.sites.map((s) => [s.label, s.filed, s.missing])).toEqual([['101', 2, 0], ['104', 2, 0], ['109', 0, 1]])
    expect(zone.zone!.documents).toHaveLength(4)

    // The chat beside the index sees the zones' counts.
    const { sessionId } = await api.call<{ sessionId: string }>(anikaCtx, ch.CHAT_OPEN, { anchor: { kind: 'tmf', id: 'etmf' }, message: 'Which zones are behind?' })
    expect(sessions.contexts.get(sessionId)).toMatchObject({ anchor: { kind: 'tmf', id: 'etmf' } })
    expect(sessions.contexts.get(sessionId)!.block).toContain('05 · Site Management · 5 · 4 · 1')
  })

  it('Stage 3: a study of the app (mw301) has the app\'s change requests, trail and inspector links, and its own TMF index', async () => {
    const cr = await api.call<MwChangeRequest>(anikaCtx, ch.CHANGES_GET, { crId: 'CR-014', project: 'etmf' })
    expect(await api.call<MwChangeRequest>(anikaCtx, ch.CHANGES_GET, { crId: 'CR-014', project: 'mw301' })).toMatchObject({ id: cr.id, project: 'etmf' })
    expect((await api.call<MwChangeRequestSummary[]>(anikaCtx, ch.CHANGES_LIST, { project: 'mw301' })).map((c) => c.id)).toContain(cr.id)
    const trail = await api.call<{ entries: unknown[] }>(anikaCtx, ch.AUDIT_LOG, { project: 'etmf' })
    expect((await api.call<{ entries: unknown[] }>(anikaCtx, ch.AUDIT_LOG, { project: 'mw301' })).entries).toHaveLength(trail.entries.length)
    expect(await api.call<unknown[]>(anikaCtx, ch.INSPECTORS_LIST, { project: 'mw301' })).toEqual(await api.call<unknown[]>(anikaCtx, ch.INSPECTORS_LIST, { project: 'etmf' }))

    // The study's own plan: one expected document in MW-301; the records above are the app's own project's.
    const r = await kernel().records.create({ entity: 'etmf.Study', values: { code: 'MW-301', title: 'Aster-1, study project', sponsor: ids.sponsor }, project: 'mw301', reason: 'study set-up' }, { kind: 'system' })
    const site = await kernel().records.create({ entity: 'etmf.Site', values: { site_number: '201', study: r.id }, project: 'mw301', reason: 'study set-up' }, { kind: 'system' })
    const e = await kernel().records.create({ entity: 'etmf.ExpectedDocument', values: { site: site.id, study: r.id, artifact: 'Protocol', phase: 'start_up' }, project: 'mw301', reason: 'study set-up' }, { kind: 'system' })
    expect([r.message, site.message, e.message]).toEqual([undefined, undefined, undefined])
    const tmf = await api.call<MwTmfIndex>(anikaCtx, ch.TMF_INDEX, { project: 'mw301' })
    expect(tmf.kpis).toMatchObject({ expected: 1, filed: 0, missing: 1 })
    expect(tmf.study).toMatchObject({ id: r.id })
    expect((await api.call<MwTmfIndex>(anikaCtx, ch.TMF_INDEX, { project: 'etmf' })).kpis.expected).toBeGreaterThan(1)
  })

  it('a change log that continues a paper one starts at the paper number, never below a used one', async () => {
    const low = await api.call<MwOpenChangeResult>(anikaCtx, ch.CHANGES_OPEN, { workflowId: 'file-document', title: 'Below the log', number: 3 })
    expect(low.changeRequest.label).toBe('CR-015')
    await api.call(anikaCtx, ch.CHANGES_WITHDRAW, { crId: low.changeRequest.id })
    const paper = await api.call<MwOpenChangeResult>(anikaCtx, ch.CHANGES_OPEN, { workflowId: 'file-document', title: 'After the paper log', number: 30 })
    expect(paper.changeRequest.label).toBe('CR-030')
    await api.call(anikaCtx, ch.CHANGES_WITHDRAW, { crId: paper.changeRequest.id })
  })
})
