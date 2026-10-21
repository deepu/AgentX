/**
 * Phase 6 exit test (24 §15): the eTMF scenario end to end, in a regulated domain.
 *
 * Against a real Postgres with scripted models, the `examples/etmf` project (domains `etmf`,
 * regulated, and `edc`) and a Bun relay on a local port that the core dials out to:
 *
 * 1. EDC holds Site US-012 "Harbor Oncology, Boston"; the eTMF Site US-012 is paired by its
 *    site number and shows that name through the link.
 * 2. The study manager moves US-012 to Activating; `activate-site` starts by its trigger and
 *    waits for the start-up pack (nine of ten documents filed: 90%).
 * 3. A CV arrives by email at the eTMF address through the relay webhook; the router starts
 *    `file-document`; the agent (scripted) classifies and indexes it.
 * 4. The TMF specialist reviews it on the Document's page; a wrong password is refused; the right
 *    one signs "Reviewed and approved for filing".
 * 5. Filing is a signed transition; every change wrote a version and the chain verifies.
 * 6. The site's start-up pack is 100%, so `activate-site` moves on by itself.
 * 7. The TMF health page shows US-012 at 100%.
 * 8. The CV's expiry date gives `watch-expiries` a next firing, listed under Automations.
 * 9. The Document's audit trail exports as JSON and PDF; tampering breaks the chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import { startBunRelay, type BunRelay } from '@memwise/relay/bun'
import type {
  MwAuditExport, MwAuditTrail, MwCase, MwDashboard, MwDomain, MwInboxItem, MwRecordPage, MwRecordQueryResult, MwTrigger,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { pdfWith } from './pdf-fixture'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { scriptedProvider, type ScriptedTurn } from '@memwise/gateway'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const PASSWORD = 'a long enough password'

const CV = pdfWith([
  'Dr. med. Lena Vogel',
  'Curriculum vitae - Principal Investigator',
  'Site US-012, Harbor Oncology, Boston',
  'GCP training: 2025',
  'Signed: L. Vogel   Date: 14 Mar 2026',
])

describe.skipIf(!postgresAvailable())('Phase 6 exit: the eTMF scenario in a regulated domain', () => {
  let db: TestDatabase
  let dir: string
  let projectDir: string
  let svc: MemwiseService
  let relay: BunRelay
  const api = fakeServer()
  const sessions = fakeSessions()
  let specialist: RequestContext
  let manager: RequestContext
  let ownerCtx: RequestContext
  const saved: Record<string, string | undefined> = {}
  const env = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  // Records seeded for the story.
  const ids: Record<string, string> = {}
  const script: Record<string, ScriptedTurn[]> = {}
  let fileCaseId: string
  let documentId: string
  let activationCaseId: string

  async function itemFor<K extends MwInboxItem['kind']>(who: RequestContext, kind: K, match: (i: Extract<MwInboxItem, { kind: K }>) => boolean) {
    type Item = Extract<MwInboxItem, { kind: K }>
    const mine = (i: MwInboxItem): i is Item => i.kind === kind && match(i as Item)
    const items = await until(`a ${kind} item`, () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST), (xs) => xs.some(mine), 30_000)
    return items.find(mine)!
  }

  const create = async (who: RequestContext, entity: string, values: Record<string, unknown>, status?: string) => {
    const r = await api.call(who, ch.RECORDS_CREATE, { entity, values, ...(status ? { status } : {}), reason: 'study set-up' })
    expect(r).toMatchObject({ applied: true })
    return r.id as string
  }

  beforeAll(async () => {
    relay = startBunRelay({ port: 0, hostname: '127.0.0.1', log: quiet })
    env('MEMWISE_PUBLIC_URL', undefined)
    env('MEMWISE_RELAY_URL', undefined)
    db = await createTestDatabase('mw_exit6', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit6-'))
    projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    // Phase 6's scenario, from before EDC read Medidata Rave (Stage 6): without the Rave binding,
    // EDC's sites are made by hand. With it, only Rave may give their facts (one owner per fact).
    rmSync(join(projectDir, 'domain', 'bindings', 'memwise__medidata-rave.yaml'))
    mkdirSync(join(dir, 'relay'), { recursive: true })
    writeFileSync(join(dir, 'relay', 'settings.json'), JSON.stringify({ enabled: true, relayUrl: relay.url }))
    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: async (input) => {
        // The examples' scripts (the router from "cv-arrives", the classifier and verifier from
        // "files-a-pi-cv"), read live so the classifier can name this test's record ids.
        const resolved = await scriptedModels(input, 'cv-arrives')
        const examples = Object.values(input.project?.workflows ?? {}).flatMap((wf) => wf.examples)
        for (const e of examples) {
          for (const [role, turns] of Object.entries(e.model ?? {})) {
            if (e.name === 'files-a-pi-cv' || e.name === 'cv-arrives' || !script[role]) script[role] = structuredClone(turns)
          }
        }
        return { ...resolved, providers: [scriptedProvider(script)] }
      },
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const priya = await svc.kernel.people.create({ name: 'Priya Shah', email: 'priya@northlight.example', roles: ['tmf_specialist'], password: PASSWORD })
    const tom = await svc.kernel.people.create({ name: 'Tom Ellis', email: 'tom@northlight.example', roles: ['study_manager'], password: PASSWORD })
    specialist = ctxFor('specialist-client', priya.id)
    manager = ctxFor('manager-client', tom.id)
    ownerCtx = ctxFor('owner-client', svc.owner.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await relay?.stop()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }, 60_000)

  it('has two domains, eTMF regulated, and no acting as someone else', async () => {
    const domains = await api.call<MwDomain[]>(ownerCtx, ch.DOMAINS_LIST)
    // The meta playbooks the app adds make no default domain appear beside the named ones.
    expect(domains.map((d) => d.id).sort()).toEqual(['edc', 'etmf'])
    expect(domains.find((d) => d.id === 'etmf')).toMatchObject({ name: 'eTMF', regulated: true })
    const status = await api.call(ownerCtx, ch.STATUS)
    expect(status.canActAs).toBe(false)
  })

  it('sets up the study: the eTMF site shows its name from EDC', async () => {
    ids.edcSite = await create(manager, 'edc.Site', { site_number: 'US-012', name: 'Harbor Oncology, Boston', principal_investigator: 'Dr. Mei Chen' }, 'active')
    ids.sponsor = await create(manager, 'etmf.Sponsor', { name: 'Aster Bio' })
    ids.study = await create(manager, 'etmf.Study', { code: 'AST-301', title: 'A study of AST-301 in solid tumours', sponsor: ids.sponsor })
    ids.site = await create(manager, 'etmf.Site', { site_number: 'US-012', study: ids.study })
    ids.person = await create(manager, 'etmf.Person', { name: 'Dr. Lena Vogel', role: 'Principal investigator', site: ids.site })
    const artifacts = ['Protocol signature page', 'FDA Form 1572', 'GCP certificates', 'Financial disclosure', 'Lab normal ranges',
      'Sub-investigator CVs', 'Clinical trial agreement', 'IRB approval', 'Lab certification', 'Investigator CV']
    for (const artifact of artifacts) {
      // Nine were filed before MemWise; only a playbook step may file one from now on.
      const id = await create(manager, 'etmf.ExpectedDocument', { site: ids.site, study: ids.study, artifact, phase: 'start_up' }, artifact === 'Investigator CV' ? undefined : 'filed')
      if (artifact === 'Investigator CV') ids.expectedCv = id
    }
    const page = await until('the site paired with EDC', () => api.call<MwRecordPage>(manager, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: ids.site }),
      (p) => p?.fields.some((f) => f.name === 'name' && f.value === 'Harbor Oncology, Boston'), 30_000)
    const name = page.fields.find((f) => f.name === 'name')!
    expect(name).toMatchObject({ followed: true, editable: false, source: { kind: 'link', domain: 'edc' } })
    expect(page.title).toContain('US-012')
    expect(page.fields.find((f) => f.name === 'start_up_pack_complete')?.value).toBe(90)
    // Its expected documents show their own values: not the site they belong to, nor the study's id.
    const expected = page.related.expected_documents!
    expect(expected.total).toBe(10)
    expect(expected.rows.every((r) => !('site' in r.values) && !('study' in r.values) && r.values.phase === 'start_up')).toBe(true)
    // With their types, so the page reads "Start up", not "start_up".
    expect(expected.types?.phase).toBe('Enum[start_up, conduct, close_out]')
    // A list of records names what they point at.
    const sites = await api.call<MwRecordQueryResult>(manager, ch.RECORDS_QUERY, { entity: 'etmf.Site' })
    expect(sites.rows[0]!.refs?.study).toMatchObject({ id: ids.study, title: 'AST-301 · A study of AST-301 in solid tumours' })
  }, 60_000)

  it('moving the site to Activating starts its activation case, which waits for the start-up pack', async () => {
    expect(await api.call(manager, ch.RECORDS_TRANSITION, { entity: 'etmf.Site', id: ids.site, transition: 'picked', reason: 'site selected' }))
      .toMatchObject({ applied: true })
    const cases = await until('the activation case', () => api.call<any[]>(manager, ch.CASES_LIST, { workflowId: 'activate-site' }), (xs) => xs.length > 0, 30_000)
    expect(cases).toHaveLength(1)
    // A case with nothing typed of its own is named after the record it is about.
    expect(cases[0].title).toBe('US-012 · Harbor Oncology, Boston')
    activationCaseId = cases[0].caseId
    const view = await until('waiting for the pack', () => api.call<MwCase>(manager, ch.CASES_GET, activationCaseId), (c) => c.state === 'collect_pack' && !!c.waiting, 30_000)
    expect(view.waiting).toMatchObject({ holds: false, record: { id: ids.site } })
    expect(view.waiting!.values.start_up_pack_complete).toBe(90)
  }, 60_000)

  it('a CV arrives by email at the eTMF address and is classified', async () => {
    // The classifier's answer names this study's records (the example names its own fixed ids).
    const finish = script.classifier!.flatMap((t) => t.toolCalls ?? []).find((c) => c.name === 'step.finish')!
    Object.assign((finish.args as { writes: Record<string, unknown> }).writes, {
      study: ids.study, site: ids.site, about: ids.person, expected_document: ids.expectedCv,
    })
    const hook = await svc.kernel.channels.createWebhook({ purpose: 'email-inbound:etmf', scheme: 'hmac-sha256' }, { kind: 'system' })
    const body = JSON.stringify({
      messageId: '<cv-1@harbor-oncology.example>',
      from: 'coordinator@harbor-oncology.example',
      to: 'etmf@northlight.example',
      subject: 'AST-301 US-012: PI CV (Dr. Vogel)',
      text: 'Please find attached the signed CV of our principal investigator.',
      attachments: [{ filename: 'vogel-cv.pdf', contentType: 'application/pdf', contentBase64: Buffer.from(CV).toString('base64') }],
    })
    const sig = createHmac('sha256', hook.secret).update(body).digest('hex')
    const url = `${svc.publicAddress.publicUrl()}/h/${hook.hook.id}`
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-memwise-signature': `sha256=${sig}` }, body })
    expect({ status: res.status, text: await res.text() }).toMatchObject({ status: 200 })
    // The same email delivered twice starts nothing new.
    const again = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-memwise-signature': `sha256=${sig}` }, body })
    expect(again.status).toBe(200)

    const files = await until('the filing case', () => api.call<any[]>(specialist, ch.CASES_LIST, { workflowId: 'file-document' }), (xs) => xs.length > 0, 30_000)
    expect(files).toHaveLength(1)
    fileCaseId = files[0].caseId
    const routed = await api.call<any[]>(specialist, ch.CASES_LIST, { workflowId: 'route-message' })
    expect(routed).toHaveLength(1)
    const view = await until('at QC', () => api.call<MwCase>(specialist, ch.CASES_GET, fileCaseId), (c) => c.state === 'qc' || c.status !== 'active', 60_000)
    expect(view.state).toBe('qc')
    documentId = view.values.document!.value as string
    expect(view.caseLinks?.some((l) => l.kind === 'started_by')).toBe(true)
  }, 120_000)

  it('the TMF specialist reviews it on the Document page and signs', async () => {
    const item = await itemFor(specialist, 'input', (i) => i.caseId === fileCaseId)
    expect(item.review).toMatchObject({ kind: 'document', entity: 'etmf.Document', recordId: documentId })
    expect(item.sign).toMatchObject({ meaning: 'Reviewed and approved for filing' })
    const page = await api.call<MwRecordPage>(specialist, ch.RECORDS_PAGE, { entity: 'etmf.Document', id: documentId, review: { stepRunId: item.stepRunId } })
    expect(page.layout.layout).toBe('split')
    expect(page.review?.proposed.find((p) => p.field === 'artifact')?.value).toBe('Investigator CV')
    // A proposed reference carries its record's title, so the screen does not show the id.
    expect(page.review?.proposed.find((p) => p.field === 'site')?.ref).toMatchObject({ id: ids.site, title: 'US-012 · Harbor Oncology, Boston' })
    expect(page.review?.sign?.meaning).toBe('Reviewed and approved for filing')
    expect(page.documents.file?.name).toBe('vogel-cv.pdf')

    // The specialist corrects one value while reviewing: the record takes it with the signature.
    const values = { ...Object.fromEntries(page.review!.proposed.map((p) => [p.field, p.value])), version: '2026-03 (signed copy)' }
    const unsigned = await api.call(specialist, ch.INBOX_SUBMIT, { stepRunId: item.stepRunId, outcome: 'approved', values })
    expect(unsigned).toMatchObject({ applied: false, code: 'submit.signature-required' })
    const wrong = await api.call(specialist, ch.INBOX_SUBMIT, { stepRunId: item.stepRunId, outcome: 'approved', values, signature: { password: 'not it' } })
    expect(wrong).toMatchObject({ applied: false, code: 'submit.signature-failed' })
    const signed = await api.call(specialist, ch.INBOX_SUBMIT, { stepRunId: item.stepRunId, outcome: 'approved', values, signature: { password: PASSWORD } })
    expect(signed).toMatchObject({ applied: true })
  }, 60_000)

  it('the document is filed with a signature and an unbroken history', async () => {
    const fileCase = await until('filed', () => api.call<MwCase>(specialist, ch.CASES_GET, fileCaseId), (c) => c.status !== 'active', 60_000)
    // Values approved as the agent proposed them keep the agent's provenance; only the correction is the specialist's.
    expect(fileCase.values.artifact?.provenance.kind).not.toBe('person')
    expect(fileCase.values.version?.provenance.kind).toBe('person')
    const page = await api.call<MwRecordPage>(specialist, ch.RECORDS_PAGE, { entity: 'etmf.Document', id: documentId })
    expect(page.status).toBe('filed')
    expect(page.signatures).toHaveLength(1)
    expect(page.signatures[0]).toMatchObject({ name: 'Priya Shah', meaning: 'Reviewed and approved for filing', changedSince: false })
    expect(page.fields.find((f) => f.name === 'version')?.value).toBe('2026-03 (signed copy)')
    const trail = await api.call<MwAuditTrail>(specialist, ch.AUDIT_GET, { entity: 'etmf.Document', id: documentId })
    expect(trail.chain.ok).toBe(true)
    expect(trail.versions.length).toBeGreaterThanOrEqual(3)
    expect(trail.versions.every((v) => v.hash.length === 64)).toBe(true)
  }, 60_000)

  it('the start-up pack is complete, so the activation case moves on by itself', async () => {
    const view = await until('activation moved on', () => api.call<MwCase>(manager, ch.CASES_GET, activationCaseId), (c) => c.state !== 'collect_pack', 60_000)
    expect(view.state).toBe('approve_activation')
    const page = await api.call<MwRecordPage>(manager, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: ids.site })
    expect(page.fields.find((f) => f.name === 'start_up_pack_complete')?.value).toBe(100)
  }, 90_000)

  it('the TMF health page shows US-012 complete', async () => {
    const dash = await api.call<MwDashboard>(manager, ch.PAGES_DASHBOARD, { domain: 'etmf', pageId: 'tmf-health', params: { study: ids.study } })
    const heat = dash.blocks.find((b) => b.kind === 'heatmap')
    if (!heat || heat.kind !== 'heatmap') throw new Error('no heatmap')
    expect(heat.rows.find((r) => r.record.id === ids.site)?.values[0]).toBe(100)
    const missing = await api.call<MwRecordQueryResult>(manager, ch.RECORDS_QUERY, { entity: 'etmf.ExpectedDocument', filter: "status = 'missing'" })
    expect(missing.total).toBe(0)
  })

  it('the CV expiry is watched: the automation lists its next firing', async () => {
    expect(await api.call(specialist, ch.RECORDS_UPDATE, { entity: 'etmf.Person', id: ids.person, values: { cv_expires: '2028-03-14' }, reason: 'CV on file expires after two years' }))
      .toMatchObject({ applied: true })
    const triggers = await until('the expiry trigger', () => api.call<MwTrigger[]>(manager, ch.TRIGGERS_LIST), (ts) => ts.some((t) => t.workflowId === 'watch-expiries' && !!t.nextDue), 30_000)
    const expiry = triggers.find((t) => t.workflowId === 'watch-expiries')!
    expect(expiry.kind).toBe('date')
    expect(expiry.nextDue).toMatchObject({ at: expect.stringContaining('2028-02-13'), record: { id: ids.person } })
    expect(triggers.find((t) => t.workflowId === 'activate-site')?.firings).toBe(1)
  })

  it('the owner works in eTMF themselves: every role, and a signing password they choose', async () => {
    // No "act as" in a regulated domain, so the install's owner holds the project's roles.
    expect([...svc.owner.roles].sort()).toEqual(['cra', 'data_manager', 'study_manager', 'tmf_specialist'])
    expect(await api.call(ownerCtx, ch.RECORDS_CREATE, { entity: 'etmf.Sponsor', values: { name: 'Owner Bio' }, reason: 'trying it out' }))
      .toMatchObject({ applied: true })
    // They start with no password; the first one needs nothing more, a change needs the current one.
    expect(await svc.kernel.people.hasPassword(svc.owner.id)).toBe(false)
    expect(await api.call(ownerCtx, ch.PEOPLE_PASSWORD_SET, { password: 'short' })).toMatchObject({ applied: false, code: 'password.rule' })
    expect(await api.call(ownerCtx, ch.PEOPLE_PASSWORD_SET, { password: PASSWORD })).toMatchObject({ applied: true })
    expect(await api.call(ownerCtx, ch.PEOPLE_PASSWORD_SET, { password: 'another long password' })).toMatchObject({ applied: false, code: 'password.current-wrong' })
    expect(await api.call(ownerCtx, ch.PEOPLE_PASSWORD_SET, { password: 'another long password', current: PASSWORD })).toMatchObject({ applied: true })
  })

  it("the document's audit trail exports, and tampering breaks the chain", async () => {
    const json = await api.call<MwAuditExport>(manager, ch.AUDIT_EXPORT, { entity: 'etmf.Document', id: documentId, format: 'json' })
    const trail = JSON.parse(Buffer.from(json.dataBase64, 'base64').toString('utf8'))
    expect(trail.signatures[0].meaning).toBe('Reviewed and approved for filing')
    const pdf = await api.call<MwAuditExport>(manager, ch.AUDIT_EXPORT, { entity: 'etmf.Document', id: documentId, format: 'pdf' })
    expect(pdf.mime).toBe('application/pdf')
    expect(Buffer.from(pdf.dataBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-')

    // As the database owner (no app role can), rewrite history: the chain shows it.
    await db.pool.query(`alter table mw.record_versions disable trigger user`)
    await db.pool.query(`update mw.record_versions set reason = 'nothing to see' where record_id = $1 and version = 1`, [documentId])
    await db.pool.query(`alter table mw.record_versions enable trigger user`)
    expect(await svc.kernel.audit.verifyChain('etmf.Document', documentId)).toMatchObject({ ok: false, brokenAt: 1 })
  })
})
