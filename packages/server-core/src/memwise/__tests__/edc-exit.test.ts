/**
 * Stage 6 exit test (docs/memwise/26-projects-and-pages.md §9, §11): EDC and a study across apps.
 *
 * Against a real Postgres, scripted models, the `examples/etmf` project (apps eTMF and EDC) and the
 * fake Medidata Rave (RWS) on a local port, with the connection's settings in the environment:
 *
 * 1. The Rave connector reads study MW-301: its sites, subjects and queries become EDC records,
 *    with the site rollups (site 104: 7 randomised, 14 open queries, 9 older than 14 days).
 * 2. Every Rave fact shows Rave as its source and when it was read; nobody can edit one.
 * 3. The EDC study home: 186 of 300 randomised (plan 190), 142 open queries (23 old), 91% verified.
 * 4. Site 104 in both apps: EDC owns the coordinator and the queries, eTMF owns the documents;
 *    each shows the other's facts read only, with a jump to the owner. "Also in other apps".
 * 5. Rave names a new coordinator at 104: the next read changes the EDC site, eTMF's site follows
 *    it, and "Ask a new coordinator for their documents" starts, expects her CV and GCP training,
 *    and emails her once approved.
 * 6. Chase old queries drafts one reminder per site with old queries (5), each approved before it
 *    goes, and the EDC home lists them as waiting.
 * 7. Part B, with projects: each EDC project names its study (`study:` in project.yaml), and Rave is
 *    read per project, into it. The home reads the project's study before RAVE_STUDY or the app's
 *    default, and one study is linked across apps through the projects naming it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, tableOf, type TestDatabase } from '@memwise/db'
import type {
  MwCase, MwEdcHome, MwInboxItem, MwLinkedRecord, MwRecordPage, MwRecordQueryResult, MwStudyApps, MwTreeNode,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import { scriptedProvider, type ScriptedTurn } from '@memwise/gateway'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'
import { RAVE_PLUGIN } from '../rave'
import {
  FAKE_RAVE_PASSWORD, FAKE_RAVE_USER, MW207, MW301, startFakeRave, type FakeRave,
} from '../../../../runtime/tests/fixtures/fake-rave-http'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const PASSWORD = 'a long enough password'

describe.skipIf(!postgresAvailable())('Stage 6 exit: EDC from Medidata Rave, and a study across apps', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  let rave: FakeRave
  const api = fakeServer()
  const sessions = fakeSessions()
  let dana: RequestContext // data manager
  let priya: RequestContext // TMF specialist
  let tom: RequestContext // study manager
  let ownerCtx: RequestContext
  const saved: Record<string, string | undefined> = {}
  const env = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const script: Record<string, ScriptedTurn[]> = {}
  const ids: Record<string, string> = {}

  const query = (who: RequestContext, entity: string, filter?: string, limit = 500) =>
    api.call<MwRecordQueryResult>(who, ch.RECORDS_QUERY, { entity, ...(filter ? { filter } : {}), limit })
  const create = async (who: RequestContext, entity: string, values: Record<string, unknown>, status?: string) => {
    const r = await api.call(who, ch.RECORDS_CREATE, { entity, values, ...(status ? { status } : {}), reason: 'study set-up' })
    expect(r).toMatchObject({ applied: true })
    return r.id as string
  }
  const approvals = (who: RequestContext, caseId: string) =>
    api.call<MwInboxItem[]>(who, ch.INBOX_LIST).then((xs) => xs.filter((i): i is Extract<MwInboxItem, { kind: 'approval' }> => i.kind === 'approval' && i.caseId === caseId))
  const outbox = async (to: string) => {
    // The sample email plugin makes its outbox on the first send.
    if (!(await db.pool.query(`select to_regclass('mw_sandbox.outbox') as t`)).rows[0].t) return []
    return (await db.pool.query(`select "to", subject, body from mw_sandbox.outbox where "to" = $1`, [to])).rows
  }

  beforeAll(async () => {
    rave = await startFakeRave()
    // The connection, set once for the workspace: nobody types these into a playbook or a page.
    env('RAVE_URL', rave.url)
    env('RAVE_USER', FAKE_RAVE_USER)
    env('RAVE_PASSWORD', FAKE_RAVE_PASSWORD)
    env('RAVE_STUDY', undefined)
    env('MEMWISE_PUBLIC_URL', undefined)
    env('MEMWISE_RELAY_URL', undefined)
    db = await createTestDatabase('mw_exit_edc', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit-edc-'))
    const projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: async (input) => ({ ...(await scriptedModels(input, 'two-sites-behind')), providers: [scriptedProvider(script)] }),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const people = [
      ['Dana Brooks', 'dana@northlight.example', 'data_manager'],
      ['Priya Shah', 'priya@northlight.example', 'tmf_specialist'],
      ['Tom Ellis', 'tom@northlight.example', 'study_manager'],
    ] as const
    const made = []
    for (const [name, email, role] of people) {
      // Dana is a person of the EDC projects (project.yaml): she is there already; her workspace role is set here.
      const there = await svc.kernel.people.byEmail(email)
      made.push(there ? await svc.kernel.people.setRoles(there.id, [...new Set([...there.roles, role])]) : await svc.kernel.people.create({ name, email, roles: [role], password: PASSWORD }))
    }
    dana = ctxFor('dana-client', made[0]!.id)
    priya = ctxFor('priya-client', made[1]!.id)
    tom = ctxFor('tom-client', made[2]!.id)
    ownerCtx = ctxFor('owner-client', svc.owner.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    rave?.stop()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }, 60_000)

  it('reads MW-301 from Rave: studies, sites, subjects and queries, with the site rollups', async () => {
    // The first read happens on start, once the domain tables exist (it used to race them).
    const first = await until('the first read of Rave on start', () => svc.kernel.identity.syncs(), (xs) => !!xs.find((x) => x.plugin === RAVE_PLUGIN && (x.at || x.error)), 60_000)
    expect(first.find((x) => x.plugin === RAVE_PLUGIN)).toMatchObject({ at: expect.any(String) })
    expect(first.find((x) => x.plugin === RAVE_PLUGIN)?.error).toBeUndefined()
    const counts = await svc.kernel.identity.resolve({ plugin: RAVE_PLUGIN })
    const expected = rave.data.studies.length + rave.data.sites.length + rave.data.subjects.length + rave.data.queries.length
    expect(counts.linked + counts.created).toBe(expected)
    expect(counts.unmatched + counts.candidates).toBe(0)

    const sites = await query(dana, 'edc.Site', "study = 'MW-301'")
    expect(sites.total).toBe(12)
    const s104 = sites.rows.find((r) => r.values.site_number === '104')!
    ids.edc104 = s104.id
    expect(s104.values).toMatchObject({
      name: 'Kliniken am Stadtpark', principal_investigator: 'Dr Jonas Weber', coordinator: 'Lena Hoffmann',
      enrolment_target: 12, randomised: 7, open_queries: 14, old_queries: 9,
    })
    expect(String(s104.values.coordinator_since).slice(0, 10)).toBe('2026-09-02')
    expect((await query(dana, 'edc.Subject', "study = 'MW-301'")).total).toBe(186)
    expect((await query(dana, 'edc.Query', "study = 'MW-301' and query_status = 'Open'")).total).toBe(142)
    // The sync records when it read Rave and when it reads again.
    const syncs = await svc.kernel.identity.syncs()
    expect(syncs.find((s) => s.plugin === RAVE_PLUGIN)).toMatchObject({ at: expect.any(String), nextDue: expect.any(String) })
    // Only GET ever reached Rave.
    expect(new Set(rave.calls.map((c) => c.method))).toEqual(new Set(['GET']))
  }, 120_000)

  it('every Rave fact shows Rave as its source and when it was read; nobody can edit one', async () => {
    const page = await api.call<MwRecordPage>(dana, ch.RECORDS_PAGE, { entity: 'edc.Site', id: ids.edc104 })
    const coordinator = page.fields.find((f) => f.name === 'coordinator')!
    expect(coordinator).toMatchObject({ value: 'Lena Hoffmann', editable: false, source: { kind: 'plugin', plugin: RAVE_PLUGIN, title: 'Medidata Rave', asOf: expect.any(String) } })
    expect(page.fields.find((f) => f.name === 'old_queries')).toMatchObject({ value: 9, calculated: true, editable: false })
    const refused = await api.call(ownerCtx, ch.RECORDS_UPDATE, { entity: 'edc.Site', id: ids.edc104, values: { coordinator: 'Someone Else' }, reason: 'trying' })
    expect(refused).toMatchObject({ applied: false })
  })

  it('one owner per fact: a person can\'t make Rave\'s facts, and a record Rave never read says so', async () => {
    // Sites come from Rave: their facts are refused on create (only the key Rave matches by may be given).
    const made = await api.call(dana, ch.RECORDS_CREATE, { entity: 'edc.Site', values: { site_number: '999', name: 'Made here', rave_ref: `${MW301}/999` }, reason: 'trying' })
    expect(made).toMatchObject({ applied: false, status: 'invalid' })
    expect(Object.keys(made.errors).sort()).toEqual(['name', 'site_number'])
    expect(made.errors.name[0]).toContain('read from the memwise/medidata-rave connector')

    // A record no link ties to Rave shows its Rave fields as "not yet in Rave", with no "as of".
    const s101 = (await query(dana, 'edc.Site', "site_number = '101'")).rows[0]!
    const link = (await db.pool.query(`select * from mw.identity_links where record_id = $1 and plugin = $2`, [s101.id, RAVE_PLUGIN])).rows[0]
    expect(link).toBeDefined()
    await db.pool.query(`delete from mw.identity_links where id = $1`, [link.id])
    try {
      const page = await api.call<MwRecordPage>(dana, ch.RECORDS_PAGE, { entity: 'edc.Site', id: s101.id })
      expect(page.fields.find((f) => f.name === 'coordinator')?.source).toEqual({ kind: 'plugin', plugin: RAVE_PLUGIN, title: 'Medidata Rave', unlinked: true })
    } finally {
      await db.pool.query(`insert into mw.identity_links (id, entity, record_id, plugin, source, external_id, method, score, reasons, linked_by, at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [link.id, link.entity, link.record_id, link.plugin, link.source, link.external_id, link.method, link.score, JSON.stringify(link.reasons), link.linked_by, link.at])
    }
    // Reading Rave again with nothing changed there writes nothing ("104" and 104 are the same Text).
    const again = await svc.kernel.identity.resolve({ plugin: RAVE_PLUGIN })
    expect(again.refreshed ?? 0).toBe(0)
  }, 60_000)

  it('a failed read is recorded with its next try within minutes, and its own error is the one thrown', async () => {
    const was = process.env.RAVE_URL
    process.env.RAVE_URL = 'http://127.0.0.1:1/RaveWebServices'
    try {
      await expect(svc.kernel.identity.resolve({ plugin: RAVE_PLUGIN })).rejects.toThrow(/could not be reached/)
      const s = (await svc.kernel.identity.syncs()).find((x) => x.plugin === RAVE_PLUGIN)!
      expect(s.error).toContain('could not be reached')
      expect(s.error).not.toContain('127.0.0.1:1') // the connection is a secret, redacted
      const wait = Date.parse(s.nextDue!) - Date.parse(s.errorAt!)
      expect(wait).toBeGreaterThan(0)
      expect(wait).toBeLessThanOrEqual(5 * 60_000 + 1000)
    } finally {
      process.env.RAVE_URL = was
    }
    await svc.kernel.identity.resolve({ plugin: RAVE_PLUGIN })
    expect((await svc.kernel.identity.syncs()).find((x) => x.plugin === RAVE_PLUGIN)?.error).toBeUndefined()
  }, 60_000)

  it('the EDC study home: randomised against plan, open and old queries, pages verified, by site', async () => {
    const home = await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'MW-301' })
    expect(home.study).toMatchObject({ key: 'MW-301', record: { entity: 'edc.Study' } })
    expect(home.source).toMatchObject({ plugin: RAVE_PLUGIN, title: 'Medidata Rave', at: expect.any(String) })
    expect(home.randomised).toEqual({ value: 186, target: 300, plannedByNow: 190 })
    expect(home.queries).toEqual({ open: 142, old: 23, olderThanDays: 14 })
    expect(Math.round(home.pagesVerified!)).toBe(91)
    expect(home.sites).toHaveLength(12)
    // Behind first: each site's randomised against its target.
    const percents = home.sites.map((s) => s.percent!)
    expect([...percents].sort((a, b) => a - b)).toEqual(percents)
    expect(home.sites.find((s) => s.number === '104')).toMatchObject({ randomised: 7, target: 12, percent: 58, oldQueries: 9 })
    // MW-207's sites are another study.
    expect(home.sites.some((s) => s.number.startsWith('2'))).toBe(false)
    // In the project shell a project's id is its app's ("edc"): the study with the most sites.
    const shell = await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'edc', domain: 'edc' })
    expect(shell.study.key).toBe('MW-301')
    expect(shell.sites).toHaveLength(12)
  })

  it('site 104 in two apps: each fact owned by one, read only in the other, with a jump back', async () => {
    ids.sponsor = await create(tom, 'etmf.Sponsor', { name: 'Meridian Pharma' })
    ids.study = await create(tom, 'etmf.Study', { code: 'MW-301', title: 'Meriglutide once weekly (phase 3)', sponsor: ids.sponsor })
    ids.site = await create(tom, 'etmf.Site', { site_number: '104', study: ids.study })
    for (const [artifact, filed] of [['Protocol signature page', true], ['FDA Form 1572', true], ['Lab normal ranges', false], ['Investigator CV', true]] as const) {
      await create(tom, 'etmf.ExpectedDocument', { site: ids.site, study: ids.study, artifact, phase: 'start_up' }, filed ? 'filed' : undefined)
    }
    // eTMF's site follows EDC's: the coordinator is EDC's fact, read only here.
    const etmf = await until('the eTMF site paired with EDC', () => api.call<MwRecordPage>(priya, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: ids.site }),
      (p) => p?.fields.some((f) => f.name === 'coordinator' && f.value === 'Lena Hoffmann'), 30_000)
    expect(etmf.fields.find((f) => f.name === 'coordinator')).toMatchObject({ followed: true, editable: false, source: { kind: 'link', domain: 'edc', domainName: 'EDC', recordId: ids.edc104 } })
    expect(etmf.fields.find((f) => f.name === 'start_up_pack_complete')?.value).toBe(75)

    // From EDC: the same site in eTMF, with the facts eTMF owns.
    const fromEdc = await api.call<MwLinkedRecord[]>(dana, ch.RECORDS_LINKED, { entity: 'edc.Site', id: ids.edc104 })
    expect(fromEdc).toHaveLength(1)
    expect(fromEdc[0]).toMatchObject({ domain: 'etmf', domainName: 'eTMF', entity: 'etmf.Site', id: ids.site })
    expect(fromEdc[0]!.fields.find((f) => f.name === 'start_up_pack_complete')).toMatchObject({ value: 75, editable: false })
    expect(fromEdc[0]!.fields.some((f) => f.name === 'coordinator')).toBe(false) // EDC's own fact is not repeated as eTMF's
    // From eTMF: the same site in EDC, with the facts EDC owns.
    const fromEtmf = await api.call<MwLinkedRecord[]>(priya, ch.RECORDS_LINKED, { entity: 'etmf.Site', id: ids.site })
    expect(fromEtmf[0]).toMatchObject({ domain: 'edc', domainName: 'EDC', entity: 'edc.Site', id: ids.edc104 })
    expect(fromEtmf[0]!.fields.find((f) => f.name === 'old_queries')).toMatchObject({ value: 9, editable: false })

    // "Also in other apps" on the EDC home: the same study in eTMF.
    const also = await api.call<MwStudyApps>(dana, ch.STUDY_APPS, { projectId: 'MW-301', domain: 'edc' })
    expect(also.apps).toHaveLength(1)
    expect((await api.call<MwStudyApps>(dana, ch.STUDY_APPS, { projectId: 'edc', domain: 'edc' })).apps[0]).toMatchObject({ domain: 'etmf', record: { id: ids.study } })
    expect(also.apps[0]).toMatchObject({ domain: 'etmf', domainName: 'eTMF', record: { entity: 'etmf.Study', id: ids.study }, shares: ['Sites'] })
    expect(also.apps[0]!.facts.find((f) => f.name === 'tmf_complete')).toMatchObject({ value: 75, type: 'Percentage' })
    // Pairing a site is not a new coordinator.
    expect(await api.call<unknown[]>(tom, ch.CASES_LIST, { workflowId: 'new-coordinator' })).toHaveLength(0)
  }, 60_000)

  it('a new coordinator in Rave makes eTMF ask the site for her CV and GCP training', async () => {
    script.requester = [
      { toolCalls: [{ name: 'etmf.person.list', args: { filter: `site = '${ids.site}'` } }] },
      { toolCalls: [
        { name: 'etmf.person.create', args: { name: 'Mira Schulz', role: 'Study Coordinator', site: ids.site } },
        { name: 'etmf.expected_document.create', args: { site: ids.site, study: ids.study, artifact: 'CV, Mira Schulz (coordinator)', phase: 'conduct' } },
        { name: 'etmf.expected_document.create', args: { site: ids.site, study: ids.study, artifact: 'GCP training, Mira Schulz (coordinator)', phase: 'conduct' } },
      ] },
      { toolCalls: [{ name: 'step.finish', args: {
        outcome: 'drafted',
        writes: { subject: 'MW-301: your CV and GCP training certificate', body: 'Dear Mira Schulz,\n\nWelcome to study MW-301 at site 104. Please send us your signed and dated CV and your GCP training certificate.\n\nThe TMF team' },
        rationale: 'Mira Schulz is new at site 104.',
      } }] },
    ]
    rave.setCoordinator({ site: '104', name: 'Mira Schulz', email: 'mira.schulz@site104.example' })
    const counts = await svc.kernel.identity.resolve({ plugin: RAVE_PLUGIN })
    expect(counts.refreshed).toBe(1)

    const edc = await api.call<MwRecordPage>(dana, ch.RECORDS_PAGE, { entity: 'edc.Site', id: ids.edc104 })
    expect(edc.fields.find((f) => f.name === 'coordinator')?.value).toBe('Mira Schulz')
    const cases = await until('the new-coordinator case', () => api.call<any[]>(tom, ch.CASES_LIST, { workflowId: 'new-coordinator' }), (xs) => xs.length > 0, 30_000)
    expect(cases).toHaveLength(1)
    const caseId = cases[0].caseId as string
    const pending = await until('the email to approve', () => approvals(ownerCtx, caseId), (xs) => xs.length > 0, 60_000)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ tool: 'email.send', effect: 'outbound' })
    expect(JSON.stringify(pending[0]!.preview)).toContain('mira.schulz@site104.example')
    // Nothing is sent before it is approved.
    expect(await outbox('mira.schulz@site104.example')).toHaveLength(0)
    expect(await api.call(ownerCtx, ch.INBOX_DECIDE_APPROVAL, { approvalId: pending[0]!.approvalId, status: 'approved' })).toMatchObject({ applied: true })

    const done = await until('the case ends', () => api.call<MwCase>(tom, ch.CASES_GET, caseId), (c) => c.status !== 'active', 60_000)
    expect(done.status).toBe('done')
    const sent = await outbox('mira.schulz@site104.example')
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('MW-301: your CV and GCP training certificate')
    const expectedDocs = await query(priya, 'etmf.ExpectedDocument', `site = '${ids.site}' and phase = 'conduct'`)
    expect(expectedDocs.rows.map((r) => r.values.artifact).sort()).toEqual(['CV, Mira Schulz (coordinator)', 'GCP training, Mira Schulz (coordinator)'])
    // The change is Rave's, in the EDC site's history.
    const trail = await svc.kernel.audit.trail('edc.Site', ids.edc104, await svc.actorFor({ clientId: 'owner-client', personId: svc.owner.id }))
    expect(trail?.versions.at(-1)).toMatchObject({ by: `source:${RAVE_PLUGIN}`, reason: 'Read from Medidata Rave' })
  }, 120_000)

  it('Chase old queries: one reminder per site, each approved before it goes', async () => {
    const old = await query(dana, 'edc.Query', "study = 'MW-301' and query_status = 'Open' and days_open > 14")
    expect(old.total).toBe(23)
    const sites = await query(dana, 'edc.Site', "study = 'MW-301'")
    const bySite = new Map<string, typeof old.rows>()
    for (const q of old.rows) bySite.set(q.values.site as string, [...(bySite.get(q.values.site as string) ?? []), q])
    expect(bySite.size).toBe(5)
    const reminders = [...bySite].map(([siteId, qs]) => {
      const s = sites.rows.find((r) => r.id === siteId)!
      return {
        site: siteId, to: s.values.coordinator_email, queries: qs.length,
        subject: `MW-301: ${qs.length} queries open for more than two weeks at site ${s.values.site_number}`,
        body: `Dear ${s.values.coordinator},\n\n${qs.map((q) => `- ${q.values.subject_key}, ${q.values.visit}: ${q.values.text}`).join('\n')}\n\nPlease answer them in Rave.\n\nThe MW-301 data management team`,
      }
    })
    script.chaser = [
      { toolCalls: [{ name: 'edc.query.list', args: { filter: "query_status = 'Open' and days_open > 14" } }] },
      { toolCalls: [{ name: 'step.finish', args: {
        outcome: 'drafted',
        writes: { reminders, sites: 5, queries: 23, summary: 'Sites 104, 109 and 3 others · 23 queries older than 14 days' },
        rationale: '23 open queries are older than 14 days at 5 sites.',
      } }] },
    ]
    const started = await api.call(dana, ch.CASES_START, { workflowId: 'chase-old-queries', values: { older_than: 14 } })
    expect(started).toMatchObject({ workflowId: 'chase-old-queries' })
    const caseId = started.caseId as string
    // One email at a time, each with its exact text, each approved before it goes.
    const first = await until('the first email to approve', () => approvals(ownerCtx, caseId), (xs) => xs.length > 0, 60_000)
    expect(first[0]).toMatchObject({ tool: 'email.send', effect: 'outbound', caseTitle: 'Sites 104, 109 and 3 others · 23 queries older than 14 days' })
    // The EDC home lists it as waiting, grouped by case.
    const home = await api.call<MwEdcHome>(ownerCtx, ch.EDC_HOME, { projectId: 'MW-301' })
    expect(home.waiting.items.find((w) => w.caseId === caseId)).toMatchObject({ kind: 'approval', count: 1, workflowTitle: 'Chase old queries' })
    // Nothing has gone yet (site 104's coordinator has the eTMF request from before).
    const before = new Map<string, number>()
    for (const r of reminders) {
      const sent = await outbox(r.to as string)
      expect(sent.map((m) => m.subject)).not.toContain(r.subject)
      before.set(r.to as string, sent.length)
    }

    const approved = new Set<string>()
    for (let n = 0; n < 5; n++) {
      const [next] = await until(`email ${n + 1} to approve`, () => approvals(ownerCtx, caseId), (xs) => xs.some((x) => !approved.has(x.approvalId)), 60_000)
        .then((xs) => xs.filter((x) => !approved.has(x.approvalId)))
      const to = reminders[n]!.to as string
      expect(JSON.stringify(next!.preview)).toContain(to)
      expect(await api.call(ownerCtx, ch.INBOX_DECIDE_APPROVAL, { approvalId: next!.approvalId, status: 'approved' })).toMatchObject({ applied: true })
      approved.add(next!.approvalId)
    }
    expect(approved.size).toBe(5)
    const done = await until('the chase ends', () => api.call<MwCase>(dana, ch.CASES_GET, caseId), (c) => c.status !== 'active', 60_000)
    expect(done.status).toBe('done')
    for (const r of reminders) {
      const sent = await outbox(r.to as string)
      expect(sent.map((m) => m.subject)).toContain(r.subject)
      expect(sent).toHaveLength((before.get(r.to as string) ?? 0) + 1)
    }
    // Rave was only read.
    expect(new Set(rave.calls.map((c) => c.method))).toEqual(new Set(['GET']))
  }, 120_000)

  // ------------------------------------------------------------------ Part B: one study per project

  const tableRows = async (entity: string, sql: (table: string) => string) => {
    const def = (await svc.kernel.project()).project.entities[entity]!
    return (await db.pool.query(sql(tableOf(def)))).rows
  }

  it('Part B: each EDC project reads its own study from Rave, into itself', async () => {
    // examples/etmf/projects/edc-mw301 and edc-mw207: `study:` and a Rave connection each.
    const projects = (await svc.kernel.project()).project.projects!
    expect(projects['edc-mw301']).toMatchObject({ app: 'edc', study: 'MW-301' })
    expect(projects['edc-mw207']).toMatchObject({ app: 'edc', study: 'MW-207' })
    expect(projects.edc).toBeUndefined() // projects run the app, so it has no project of its own
    expect(await tableRows('edc.Site', (t) => `select project, study, count(*)::int as n from ${t} group by project, study order by project`))
      .toEqual([{ project: 'edc-mw207', study: 'MW-207', n: 6 }, { project: 'edc-mw301', study: 'MW-301', n: 12 }])
    expect(await tableRows('edc.Study', (t) => `select project, rave_ref from ${t} order by project`))
      .toEqual([{ project: 'edc-mw207', rave_ref: MW207 }, { project: 'edc-mw301', rave_ref: MW301 }])
    expect(await tableRows('edc.Query', (t) => `select project, count(*)::int as n from ${t} where study = 'MW-207' group by project`))
      .toEqual([{ project: 'edc-mw207', n: 1 }])
    // A project's page tree has its own sites only.
    const tree = await api.call<MwTreeNode[]>(dana, ch.RECORDS_TREE, { domain: 'edc', project: 'edc-mw207' })
    expect(tree.filter((n) => n.kind === 'record' && n.entity === 'edc.Site').map((n) => (n as { title: string }).title.slice(0, 3)).sort())
      .toEqual(['201', '202', '203', '204', '205', '206'])
    // And its old queries page counts its own: MW-301's 23 old queries at 5 sites, not MW-207's one.
    const page = await api.call<{ blocks: { kind: string; value?: number | null }[] }>(dana, ch.PAGES_DASHBOARD, { domain: 'edc', pageId: 'old-queries', project: 'edc-mw301' })
    expect(page.blocks.filter((b) => b.kind === 'kpi').map((b) => b.value)).toEqual([23, 5])
    const everywhere = await api.call<{ blocks: { kind: string; value?: number | null }[] }>(dana, ch.PAGES_DASHBOARD, { domain: 'edc', pageId: 'old-queries' })
    expect(everywhere.blocks.filter((b) => b.kind === 'kpi').map((b) => b.value)).toEqual([24, 6])
    // Each project's read asked Rave for its study only: no project read both.
    const sitesRead = new Set(rave.calls.filter((c) => /\/sites$/.test(c.path)).map((c) => decodeURIComponent(c.path)))
    expect([...sitesRead].sort()).toEqual([`/RaveWebServices/studies/${MW207}/sites`, `/RaveWebServices/studies/${MW301}/sites`])
  })

  it('Part B: the home reads the project\'s study before RAVE_STUDY or the app default', async () => {
    const mw207 = await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'edc-mw207', domain: 'edc' })
    expect(mw207.study).toMatchObject({ key: 'MW-207', record: { entity: 'edc.Study' } })
    expect(mw207.sites.map((x) => x.number).sort()).toEqual(['201', '202', '203', '204', '205', '206'])
    expect(mw207.randomised.value).toBe(5)
    env('RAVE_STUDY', MW207)
    try {
      // The project names MW-301: the connection's study doesn't change that.
      const mw301 = await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'edc-mw301', domain: 'edc' })
      expect(mw301.study.key).toBe('MW-301')
      expect(mw301.sites).toHaveLength(12)
      // No project named: the connection's study, before the app's default (the most sites).
      expect((await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'edc', domain: 'edc' })).study.key).toBe('MW-207')
    } finally {
      env('RAVE_STUDY', undefined)
    }
    expect((await api.call<MwEdcHome>(dana, ch.EDC_HOME, { projectId: 'edc', domain: 'edc' })).study.key).toBe('MW-301')
  })

  it('Part B: one study is linked across apps through the projects naming it', async () => {
    // eTMF's MW-301 and MW-207, each in its own study project (projects/mw301, mw207).
    const create = async (entity: string, values: Record<string, unknown>, project: string) => {
      const r = await api.call(tom, ch.RECORDS_CREATE, { entity, values, project, reason: 'study set-up' })
      expect(r).toMatchObject({ applied: true })
      return r.id as string
    }
    const sponsor = (await query(tom, 'etmf.Sponsor')).rows[0]!.id
    const study301 = await create('etmf.Study', { code: 'MW-301', title: 'Meriglutide once weekly (phase 3)', sponsor }, 'mw301')
    const study207 = await create('etmf.Study', { code: 'MW-207', title: 'Meriglutide in adolescents (phase 2)', sponsor }, 'mw207')

    // From EDC's MW-301 project: eTMF's MW-301 project, not the record of the same key elsewhere.
    const also301 = await api.call<MwStudyApps>(dana, ch.STUDY_APPS, { projectId: 'edc-mw301', domain: 'edc' })
    expect(also301.study.key).toBe('MW-301')
    expect(also301.apps).toEqual([expect.objectContaining({ domain: 'etmf', project: { id: 'mw301', name: 'Study MW-301' }, record: expect.objectContaining({ id: study301 }) })])
    const also207 = await api.call<MwStudyApps>(dana, ch.STUDY_APPS, { projectId: 'edc-mw207', domain: 'edc' })
    expect(also207.apps).toEqual([expect.objectContaining({ domain: 'etmf', project: { id: 'mw207', name: 'Study MW-207' }, record: expect.objectContaining({ id: study207 }) })])

    // Sites pair within the study: 201 in eTMF's MW-301 is not MW-207's 201 in EDC.
    const wrong = await create('etmf.Site', { site_number: '201', study: study301 }, 'mw301')
    const right = await create('etmf.Site', { site_number: '201', study: study207 }, 'mw207')
    const paired = await until('MW-207\'s eTMF site 201 paired with EDC\'s', () => api.call<MwRecordPage>(priya, ch.RECORDS_PAGE, { entity: 'etmf.Site', id: right }),
      (p) => p?.fields.some((f) => f.name === 'coordinator' && f.value === 'Samuel Sato'), 30_000)
    expect(paired.fields.find((f) => f.name === 'principal_investigator')?.value).toBe('Dr Aiko Lindqvist')
    const edc201 = (await tableRows('edc.Site', (t) => `select id from ${t} where project = 'edc-mw207' and site_number = '201'`))[0]!.id
    expect((await api.call<MwLinkedRecord[]>(dana, ch.RECORDS_LINKED, { entity: 'edc.Site', id: edc201 })).map((r) => r.id)).toEqual([right])
    expect((await db.pool.query(`select 1 from mw.identity_links where record_id = $1`, [wrong])).rows).toHaveLength(0)
  }, 60_000)
})
