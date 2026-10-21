/**
 * Stage 6 (26 §9): the fake Medidata Rave (RWS) and the Rave plugin's read-only tools against it.
 * The manifest in `examples/plugins/medidata-rave` routes each tool to one of these builtins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ToolContext, ToolDefinition } from '@memwise/gateway'
import { parsePluginManifest } from '@memwise/defs'
import { RAVE_BUILTINS, RAVE_PLUGIN, ageInDays, parseRef, raveTools } from '../rave'
import {
  FAKE_RAVE_PASSWORD, FAKE_RAVE_USER, MW207, MW301, startFakeRave, type FakeRave,
} from '../../../../runtime/tests/fixtures/fake-rave-http'

const REPO = resolve(import.meta.dir, '../../../../..')
const NOW = new Date('2026-10-21T09:00:00Z')
const ctx = (secrets: Record<string, string> = {}): ToolContext => ({
  idempotencyKey: 'k', secrets, token: { stepRunId: 'sr_1' } as ToolContext['token'],
})

let rave: FakeRave
let tools: Map<string, ToolDefinition>
const call = async (name: string, args: Record<string, unknown> = {}, secrets?: Record<string, string>) =>
  (await tools.get(name)!.execute(args, ctx(secrets))) as any

beforeAll(async () => {
  rave = await startFakeRave({ now: NOW })
  // The connection's settings, once for the workspace; no tool takes them as arguments.
  const env = { RAVE_URL: rave.url, RAVE_USER: FAKE_RAVE_USER, RAVE_PASSWORD: FAKE_RAVE_PASSWORD, RAVE_STUDY: MW301 }
  tools = new Map(raveTools({ env, now: () => NOW }).map((t) => [t.name, t]))
})
afterAll(() => rave?.stop())

describe('the fake Rave', () => {
  const get = (path: string, auth = true, method = 'GET') => fetch(`${rave.url}/${path}`, {
    method, headers: auth ? { authorization: `Basic ${Buffer.from(`${FAKE_RAVE_USER}:${FAKE_RAVE_PASSWORD}`).toString('base64')}` } : {},
  })

  it('serves MW-301 with 12 sites, 186 subjects and 142 open queries, and MW-207 beside it', async () => {
    const studies = (await (await get('studies')).json()).studies
    expect(studies.map((s: any) => s.StudyOID).sort()).toEqual([MW207, MW301])
    const sites = (await (await get(`studies/${encodeURIComponent(MW301)}/sites`)).json()).sites
    expect(sites).toHaveLength(12)
    expect(sites.map((s: any) => s.SiteNumber)).toEqual(expect.arrayContaining(['101', '102', '104', '109']))
    expect((await (await get(`studies/${encodeURIComponent(MW301)}/subjects`)).json()).subjects).toHaveLength(186)
    expect((await (await get(`studies/${encodeURIComponent(MW301)}/queries?Status=Open`)).json()).queries).toHaveLength(142)
  })

  it('wants the Web Services account and only reads', async () => {
    expect((await get('studies', false)).status).toBe(401)
    expect((await get('studies', true, 'DELETE')).status).toBe(405)
    expect((await get('studies/NOPE/sites')).status).toBe(404)
  })

  it('changes a coordinator while it runs, and records each call', async () => {
    const before = rave.calls.length
    const fake = await startFakeRave({ now: NOW })
    try {
      const res = await fetch(`${fake.url.replace(/\/RaveWebServices$/, '')}/__fake/coordinator`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${fake.user}:${fake.password}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ site: '104', name: 'Mara Schulz', email: 'mara.schulz@stadtpark.example' }),
      })
      expect(res.status).toBe(200)
      const staff = fake.data.users.filter((u) => u.SiteNumber === '104' && u.Role === 'Study Coordinator' && u.Active)
      expect(staff.map((u) => `${u.FirstName} ${u.LastName}`)).toContain('Mara Schulz')
    } finally {
      fake.stop()
    }
    expect(rave.calls.length).toBe(before)
  })
})

describe('the Rave plugin tools', () => {
  let from = 0
  beforeAll(() => { from = rave.calls.length })
  it('are the manifest\'s builtins, every one read only', () => {
    const file = join(REPO, 'examples/plugins/medidata-rave/memwise-plugin.yaml')
    const r = parsePluginManifest(readFileSync(file, 'utf8'), file)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(r.value).toMatchObject({ id: RAVE_PLUGIN, version: '1.0.0', trust: 'first-party' })
    const routes = Object.values(r.value!.tools).map((t) => (t.run as { builtin: string }).builtin).sort()
    expect(routes).toEqual(Object.values(RAVE_BUILTINS).sort())
    for (const t of Object.values(r.value!.tools)) expect(t.effect).toBe('read')
    for (const t of tools.values()) expect([t.effect, t.idempotent, t.source]).toEqual(['read', true, { plugin: RAVE_PLUGIN }])
    expect(Object.keys(r.value!.records ?? {}).sort()).toEqual(['query', 'site', 'subject'])
    expect(readFileSync(join(REPO, 'examples/plugins/medidata-rave/README.md'), 'utf8')).toContain('Needs Sandeep')
  })

  it('reads site 104 with its PI, coordinator, target and pages verified', async () => {
    const { sites } = await call(RAVE_BUILTINS.listSites)
    expect(sites).toHaveLength(12)
    const s104 = sites.find((s: any) => s.SiteNumber === '104')
    expect(s104).toMatchObject({
      Ref: `${MW301}/104`, Study: 'MW-301', SiteName: 'Kliniken am Stadtpark', EnrollmentTarget: 12,
      Investigator: 'Dr Jonas Weber', Coordinator: 'Lena Hoffmann', CoordinatorSince: '2026-09-02',
    })
    expect(typeof s104.PagesVerifiedPercent).toBe('number')
    expect((await call(RAVE_BUILTINS.getSite, { site: `${MW301}/104` })).site).toEqual(s104)
    const { staff } = await call(RAVE_BUILTINS.siteStaff, { site: `${MW301}/104` })
    expect(staff.map((p: any) => p.Role).sort()).toEqual(['Investigator', 'Study Coordinator'])
  })

  it('counts subjects, finds old queries and the study\'s form status', async () => {
    expect((await call(RAVE_BUILTINS.listSubjects)).total).toBe(186)
    expect((await call(RAVE_BUILTINS.listSubjects, { site: '104' })).total).toBe(7)
    expect((await call(RAVE_BUILTINS.listSubjects, { study: 'MW-207' })).total).toBe(5)
    const subject = (await call(RAVE_BUILTINS.listSubjects, { site: '104' })).subjects[0]
    expect((await call(RAVE_BUILTINS.getSubject, { subject: subject.Ref })).subject).toEqual(subject)

    expect((await call(RAVE_BUILTINS.listQueries, { status: 'open' })).total).toBe(142)
    const old = (await call(RAVE_BUILTINS.listQueries, { status: 'open', older_than_days: 14 })).queries
    expect(old).toHaveLength(23)
    const bySite: Record<string, number> = {}
    for (const q of old) bySite[q.SiteNumber] = (bySite[q.SiteNumber] ?? 0) + 1
    expect(bySite).toEqual({ '104': 9, '109': 8, '102': 3, '106': 2, '111': 1 })
    const oldest = [...old].sort((a, b) => b.AgeDays - a.AgeDays).slice(0, 3).map((q: any) => `${q.SubjectKey} ${q.AgeDays}`)
    expect(oldest).toEqual(['104-007 31', '109-012 26', '109-004 25'])
    expect((await call(RAVE_BUILTINS.getQuery, { query: old[0].Ref })).query).toEqual(old[0])

    const { totals } = await call(RAVE_BUILTINS.formStatus)
    expect(Math.round(totals.PercentVerified)).toBe(91)
    expect((await call(RAVE_BUILTINS.listStudies)).studies).toHaveLength(2)
  })

  it('takes the connection\'s settings over the environment and says plainly what is wrong', async () => {
    const t = raveTools({ env: {}, now: () => NOW }).find((x) => x.name === RAVE_BUILTINS.listStudies)!
    await expect(t.execute({}, ctx())).rejects.toThrow('Medidata Rave is not connected: set RAVE_URL, RAVE_USER, RAVE_PASSWORD')
    const secrets = { RAVE_URL: rave.url, RAVE_USER: FAKE_RAVE_USER, RAVE_PASSWORD: FAKE_RAVE_PASSWORD }
    expect(((await t.execute({}, ctx(secrets))) as any).studies).toHaveLength(2)
    await expect(t.execute({}, ctx({ ...secrets, RAVE_PASSWORD: 'wrong' }))).rejects.toThrow('Medidata Rave refused the sign-in')
    await expect(call(RAVE_BUILTINS.getSite, { site: '104' })).rejects.toThrow('should be a Rave reference')
    await expect(call(RAVE_BUILTINS.listSites, { study: 'MW-999' })).rejects.toThrow('Medidata Rave has no study MW-999')
  })

  it('never sends anything but GET', () => {
    const mine = rave.calls.slice(from)
    expect(mine.length).toBeGreaterThan(10)
    expect(new Set(mine.map((c) => c.method))).toEqual(new Set(['GET']))
  })

  it('parses references and counts days', () => {
    expect(parseRef(`${MW301}/104-007`, 'subject')).toEqual({ study: MW301, id: '104-007' })
    expect(ageInDays('2026-10-01', NOW)).toBe(20)
  })
})
