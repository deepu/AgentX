/**
 * Stage 3 exit test (docs/memwise/26-projects-and-pages.md §3, §11 "Stage 3"): projects inside
 * apps, through the app API the screens call, against a real Postgres and a copy of examples/etmf.
 *
 * 1. Priya (CRA in MW-301 only) sees nothing of MW-207: not in the switcher, its settings, its
 *    sites, its documents or Waiting for you.
 * 2. MW-301 runs its own Chase missing documents (waits 5 days; the template waits 3).
 * 3. Template v5 gives MW-207 a "Review template update"; MW-301's review says it already does it.
 * 4. MW-310 is copied from MW-301 with no records, as a draft that runs nothing until Start study.
 * 5. "TMF across studies" shows both running studies.
 * 6. Describe it in chat: the create-project chat drafts a study with its project tools.
 * (The single-domain examples are the other exit suites: literature-exit, exit, phase6-exit.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type {
  MwApp, MwAppHome, MwDescribeProjectResult, MwInboxItem, MwProjectDetail, MwPublishTemplateResult, MwRecordQueryResult,
  MwTemplateUpdateReview, MwWaitingGroup,
  MwCaseSummary,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { buildMemwiseToolCallbacks } from '../chat-tools'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const SYSTEM = { kind: 'system' as const }

describe.skipIf(!postgresAvailable())('Stage 3 exit: projects inside apps, through the app API', () => {
  let db: TestDatabase
  let dir: string
  let projectDir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  let anika: RequestContext
  let priya: RequestContext
  let tom: RequestContext

  beforeAll(async () => {
    db = await createTestDatabase('mw_exit_s3', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit-s3-'))
    projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    // MW-310 is made here, from MW-301, as New project makes it.
    rmSync(join(projectDir, 'projects', 'mw310'), { recursive: true, force: true })
    svc = (await startMemwiseService({
      configDir: dir, projectDir, databaseUrl: db.url, mode: 'server',
      modelResolver: (input) => scriptedModels(input, 'cv-arrives'),
      logger: quiet, exampleRoots: [REPO], watch: false, throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    // The walkthrough records, as a desktop start makes them.
    for (const p of ['mw301', 'mw207']) expect((await svc.kernel.projects.seed(p, SYSTEM)).created).toBeGreaterThan(0)
    const ctx = async (email: string) => ctxFor(email, (await svc.kernel.people.byEmail(email))!.id)
    anika = await ctx('anika.rao@northlight.example')
    priya = await ctx('priya.shah@northlight.example')
    tom = await ctx('tom.okafor@northlight.example')
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  const sites = async (who: RequestContext, project?: string) =>
    (await api.call<MwRecordQueryResult>(who, ch.RECORDS_QUERY, { entity: 'etmf.Site', limit: 200, ...(project ? { project } : {}) })).rows

  it('exit 1: a person in MW-301 only sees nothing of MW-207', async () => {
    const apps = await api.call<MwApp[]>(priya, ch.APPS_LIST)
    const etmf = apps.find((a) => a.id === 'etmf')!
    expect(etmf.projects.map((p) => p.id)).toEqual(['mw301'])
    expect(etmf).toMatchObject({ title: 'eTMF', nouns: { one: 'study', many: 'studies' }, canCreate: false })
    expect(await api.call(priya, ch.PROJECTS_GET, 'mw207')).toBeNull()
    expect((await api.call<MwApp[]>(anika, ch.APPS_LIST)).find((a) => a.id === 'etmf')!.projects.map((p) => p.id).sort()).toEqual(['mw207', 'mw301'])
    // Her sites are MW-301's twelve; Anika sees eighteen across both studies.
    expect((await sites(priya)).length).toBe(12)
    expect((await sites(anika)).length).toBe(18)
    const docs = await api.call<MwRecordQueryResult>(priya, ch.RECORDS_QUERY, { entity: 'etmf.Document', limit: 200 })
    const all = await api.call<MwRecordQueryResult>(anika, ch.RECORDS_QUERY, { entity: 'etmf.Document', limit: 200 })
    expect(docs.total).toBeLessThan(all.total)
    // Nothing of MW-207 waits for her, in her inbox or across projects.
    const inbox = await api.call<MwInboxItem[]>(priya, ch.INBOX_LIST)
    expect(inbox.filter((i) => i.project === 'mw207')).toEqual([])
    const groups = await api.call<MwWaitingGroup[]>(priya, ch.WAITING_ALL)
    expect(groups.map((g) => g.project)).not.toContain('mw207')
  })

  it('exit 2: MW-301 runs its own Chase missing documents, changed to wait 5 days', async () => {
    const p = (await api.call<MwProjectDetail>(anika, ch.PROJECTS_GET, 'mw301'))!
    expect(p.overrides).toEqual([expect.objectContaining({ path: 'workflows/chase-missing/workflow.yaml', workflow: 'chase-missing' })])
    expect(p.playbooks.find((w) => w.id === 'chase-missing')).toMatchObject({ overridden: true })
    expect((await api.call<MwProjectDetail>(anika, ch.PROJECTS_GET, 'mw207'))!.overrides).toEqual([])
    const { project } = await svc.kernel.project()
    const wait = (id: string) => project.projects![id]!.workflows['chase-missing']!.states.wait_for_documents!.wait?.timeout
    expect(wait('mw301')?.afterMs).toBe(5 * 86_400_000)
    expect(wait('mw207')?.afterMs).toBe(3 * 86_400_000)
  })

  it('exit 4: MW-310 copied from MW-301 has its way of working and no records; a draft runs nothing until Start study', async () => {
    const made = await api.call<MwProjectDetail>(anika, ch.PROJECTS_CREATE, { name: 'Study MW-310', copyFrom: 'mw301', study: 'MW-310' })
    expect(made).toMatchObject({ id: 'study-mw-310', status: 'draft', app: 'etmf', apps: ['etmf'], from: { project: 'mw301' }, canEdit: true })
    expect(made.overrides.map((o) => o.path)).toEqual(['workflows/chase-missing/workflow.yaml'])
    expect(made.people.map((x) => x.email).sort()).toEqual(['anika.rao@northlight.example', 'priya.shah@northlight.example', 'tom.okafor@northlight.example'])
    // What it keeps records of: the app's project-scoped types (the shared Sponsor is the app's).
    expect(made.recordTypes.map((r) => r.entity)).toEqual(expect.arrayContaining(['etmf.Site', 'etmf.Document']))
    expect(made.recordTypes.map((r) => r.entity)).not.toContain('etmf.Sponsor')
    expect(made.pages.length).toBeGreaterThan(0)
    expect(await sites(anika, 'study-mw-310')).toEqual([])
    await expect(svc.kernel.startRun({ workflowId: 'chase-missing', case: {}, project: 'study-mw-310' })).rejects.toThrow('is a draft')
    expect(await api.call<MwProjectDetail>(anika, ch.PROJECTS_START, 'study-mw-310')).toMatchObject({ status: 'active' })
    // Start, inside the study: the case runs in it (the shell's Start passes its project).
    const started = await api.call<MwCaseSummary>(anika, ch.CASES_START, { workflowId: 'chase-missing', project: 'study-mw-310' })
    expect(started).toMatchObject({ project: 'study-mw-310' })
    await expect(api.call(anika, ch.CASES_START, { workflowId: 'chase-missing', project: 'no-such-study' })).rejects.toThrow('That project was not found.')
    // Priya isn't the owner role: she can't make or start one.
    await expect(api.call(priya, ch.PROJECTS_CREATE, { app: 'etmf', name: 'Mine', template: 'phase1' })).rejects.toThrow('only the Study manager')
    // A draft that never ran can be discarded.
    const draft = await api.call<MwProjectDetail>(anika, ch.PROJECTS_CREATE, { app: 'etmf', name: 'Pilot', template: 'phase1' })
    await api.call(anika, ch.PROJECTS_DISCARD, draft.id)
    expect(await api.call(anika, ch.PROJECTS_GET, draft.id)).toBeNull()
    expect(api.pushes.some((p) => (p.args[0] as { kind?: string })?.kind === 'projects')).toBe(true)
  }, 60_000)

  it('exit 3: template v5 gives each study a "Review template update"; MW-301 already does it', async () => {
    const file = join(projectDir, 'domains/etmf/workflows/chase-missing/workflow.yaml')
    const v4 = readFileSync(file, 'utf8')
    const v5 = v4.replace('version: 1', 'version: 2').replace(/(wait_for_documents:[\s\S]*?timeout: )3d/, '$15d')
    await expect(api.call(tom, ch.APPS_PUBLISH_TEMPLATE, { appId: 'etmf', files: { 'workflows/chase-missing/workflow.yaml': v5 } })).rejects.toThrow('only the Study manager')
    const published = await api.call<MwPublishTemplateResult>(anika, ch.APPS_PUBLISH_TEMPLATE, { appId: 'etmf', files: { 'workflows/chase-missing/workflow.yaml': v5 } })
    expect(published.version).toBe(5)
    expect(published.updates.map((u) => u.project).sort()).toEqual(['mw207', 'mw301', 'study-mw-310'])
    const groups = await api.call<MwWaitingGroup[]>(anika, ch.WAITING_ALL)
    expect(groups.find((g) => g.project === 'mw207')!.updates).toEqual([expect.objectContaining({ kind: 'template-update', title: 'Review template update: eTMF v5', from: 4, to: 5 })])
    const r207 = (await api.call<MwTemplateUpdateReview>(anika, ch.TEMPLATE_UPDATE_REVIEW, { projectId: 'mw207' }))!
    expect(r207).toMatchObject({ nothingChanges: false, changes: [expect.objectContaining({ project: 'takes', title: 'Chase missing documents' })] })
    // A site of MW-207 starts activating, so MW-207 surely has a Chase missing documents case; the
    // test run replays one on v5 and names it as lists do ("FR-114 · Nantes …"), never by a record id.
    const at005 = (await sites(anika, 'mw207')).find((r) => r.values.site_number === 'AT-005')!
    await api.call(anika, ch.RECORDS_TRANSITION, { entity: 'etmf.Site', id: at005.id, transition: 'picked' })
    await until('a Chase missing documents case in MW-207', () => db.pool.query(`select 1 from mw.runs where project = 'mw207' and workflow_id = 'chase-missing'`), (r) => r.rows.length > 0, 60_000)
    const t207 = (await api.call<MwTemplateUpdateReview>(anika, ch.TEMPLATE_UPDATE_REVIEW, { projectId: 'mw207', test: true }))!
    expect(t207.test?.caseId).toBeTruthy()
    expect(t207.test!.title).toMatch(/^[A-Z]{2}-\d{3} · /)
    expect(t207.test!.title).not.toMatch(/_[0-9A-Z]{26}/)
    const r301 = (await api.call<MwTemplateUpdateReview>(anika, ch.TEMPLATE_UPDATE_REVIEW, { projectId: 'mw301' }))!
    expect(r301.nothingChanges).toBe(true)
    expect(r301.changes[0]).toMatchObject({ project: 'overridden-same', note: 'This project already does that, so nothing changes here.' })
    // Priya can't review it; Anika takes MW-207's and skips MW-310's.
    expect(await api.call(priya, ch.TEMPLATE_UPDATE_REVIEW, { projectId: 'mw301' })).toBeNull()
    expect(await api.call<unknown>(anika, ch.TEMPLATE_UPDATE_TAKE, { projectId: 'mw207' })).toEqual({ version: 5, removed: [] })
    await api.call(anika, ch.TEMPLATE_UPDATE_SKIP, { projectId: 'study-mw-310' })
    const after = await api.call<MwWaitingGroup[]>(anika, ch.WAITING_ALL)
    expect(after.flatMap((g) => g.updates.map((u) => u.project))).toEqual(['mw301'])
  }, 120_000)

  it('exit 5: "TMF across studies" shows the running studies with their numbers', async () => {
    const home = await api.call<MwAppHome>(anika, ch.APPS_HOME, 'etmf')
    expect(home).toMatchObject({ title: 'TMF across studies', link: 'All studies', nouns: { one: 'study', many: 'studies' } })
    expect(home.columns.map((c) => c.label)).toEqual(['Phase', 'Sites', 'Filed', 'Missing', 'Waiting for QC'])
    const row = (id: string) => home.rows.find((r) => r.project === id)!
    expect(row('mw301')).toMatchObject({ status: 'active', values: [3, 12, expect.any(Number), expect.any(Number), expect.any(Number)] })
    expect(row('mw207')).toMatchObject({ status: 'active', values: [2, 6, expect.any(Number), expect.any(Number), expect.any(Number)] })
    expect(home.totals.active).toBeGreaterThanOrEqual(2)
    // Priya's home has her studies alone (she came along into MW-310 with MW-301's people).
    expect((await api.call<MwAppHome>(priya, ch.APPS_HOME, 'etmf')).rows.map((r) => r.project).sort()).toEqual(['mw301', 'study-mw-310'])
  })

  it('6: describe it in chat — the create-project chat drafts the study with its project tools', async () => {
    const r = await api.call<MwDescribeProjectResult>(anika, ch.PROJECTS_DESCRIBE, { app: 'etmf', request: 'A phase 1 study MW-311 in healthy volunteers' })
    expect(r.sessionId).toBeDefined()
    const ctx = sessions.contexts.get(r.sessionId!)!
    expect(ctx).toMatchObject({ anchor: { kind: 'step', id: r.stepRunId }, conversation: true, project: true })
    expect(ctx.block).toContain('A phase 1 study MW-311')
    expect(sessions.created.find((s) => s.id === r.sessionId)!.name).toBe('New in eTMF: A phase 1 study MW-311 in healthy volunteers')
    const tools = buildMemwiseToolCallbacks({ sessionId: r.sessionId! })
    const options = await tools.projectOptions!() as { templates: { id: string }[]; projects: { id: string }[]; roles: { id: string }[] }
    expect(options.templates.map((t) => t.id)).toEqual(['phase3', 'phase1'])
    expect(options.projects.map((p) => p.id)).toContain('mw301')
    expect(options.roles.map((x) => x.id)).toContain('study_manager')
    // Someone else's draft of the same name is never taken for this chat's.
    await svc.kernel.projects.create({
      app: 'etmf', name: 'Study MW-311', id: 'mw311-other', template: 'phase3',
      people: [{ email: 'anika.rao@northlight.example', name: 'Anika Rao', roles: ['study_manager'] }],
    }, SYSTEM)
    const drafted = await tools.projectDraft!({ name: 'Study MW-311', template: 'phase1', study: 'MW-311' })
    expect(drafted).toMatchObject({ project: 'study-mw-311', status: 'draft', stepFinished: true })
    // Later calls change the draft the chat made.
    await until('the run to finish', () => svc.kernel.getRun(r.runId), (run) => run?.status === 'done', 30_000)
    expect(await tools.projectDraft!({ settings: { phase: 1 } })).toMatchObject({ project: 'study-mw-311', changed: true })
    const p = (await api.call<MwProjectDetail>(anika, ch.PROJECTS_GET, 'study-mw-311'))!
    expect(p).toMatchObject({ status: 'draft', study: 'MW-311', templateTitle: 'Phase 1 study', settings: expect.objectContaining({ phase: 1 }) })
    expect((await svc.kernel.projects.get('mw311-other', SYSTEM))!).toMatchObject({ templateTitle: 'Phase 3 study' })
    await svc.kernel.projects.discard('mw311-other', SYSTEM)
    // Only Anika could: Priya's describe is refused before anything starts.
    await expect(api.call(priya, ch.PROJECTS_DESCRIBE, { app: 'etmf', request: 'x' })).rejects.toThrow('only the Study manager')
  }, 60_000)
})
