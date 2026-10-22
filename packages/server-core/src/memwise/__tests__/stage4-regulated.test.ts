/**
 * Projects and pages, Stage 4 with Stage 5 (docs/memwise/26-projects-and-pages.md §5, §8; D115,
 * D122): in the regulated eTMF, a playbook page's chat in Study MW-301 doesn't draft the study's
 * own copy. Its edit is a change request for the whole app (Stage 5's): the draft is the
 * request's, the page offers the request instead of "Send for review", and a grant in one study
 * can't raise it. The test run still runs on the study's site, sending nothing.
 *
 * Against a real Postgres with the eTMF example (regulated, as shipped) and scripted models; the
 * chat's tool calls go through the session tools' handlers with the chat's callbacks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { MwDraftSummary, MwSubmitDraftResult } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import { handlePlaybookRead, handlePlaybookTestRun, handlePlaybookWrite, type SessionToolContext } from '@memwise/session-tools-core'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { buildMemwiseToolCallbacks } from '../chat-tools'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const SEND = 'domains/etmf/workflows/remind-site/steps/send.md'

type Result = { content: { text: string }[]; isError?: boolean }
const parse = (r: Result): any => (r.isError ? { error: r.content[0]?.text ?? '' } : JSON.parse(r.content[0]?.text ?? 'null'))

describe.skipIf(!postgresAvailable())('Stage 4 in a regulated app: a playbook chat\'s edit is a change request', () => {
  let db: TestDatabase
  let dir: string
  let projectDir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  let manager: RequestContext
  let siteId = ''

  beforeAll(async () => {
    db = await createTestDatabase('mw_stage4_reg', { migrate: false })
    const admin = new URL(db.url)
    admin.pathname = '/postgres'
    dir = mkdtempSync(join(tmpdir(), 'mw-stage4-reg-'))
    projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    svc = (await startMemwiseService({
      configDir: dir, projectDir, databaseUrl: db.url, mode: 'server',
      modelResolver: (input) => scriptedModels(input, 'second-reminder'),
      logger: quiet, exampleRoots: [REPO], watch: false, throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
      testDatabaseUrl: admin.toString(),
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const anika = await svc.kernel.people.create({ name: 'Anika Rao', email: 'anika@northlight.example', roles: ['study_manager', 'staff'] })
    manager = ctxFor('manager-client', anika.id)
    const create = async (entity: string, values: Record<string, unknown>) => {
      const r = await api.call<any>(manager, ch.RECORDS_CREATE, { entity, values, project: 'mw301', reason: 'study set-up' })
      expect(r).toMatchObject({ applied: true })
      return r.id as string
    }
    const sponsor = await create('etmf.Sponsor', { name: 'Meridian Pharma' })
    const study = await create('etmf.Study', { code: 'MW-301', sponsor })
    siteId = await create('etmf.Site', { site_number: '101', study, cra_name: 'Priya Shah', cra_email: 'priya.shah@northlight.example' })
    for (const artifact of ['Investigator CV', 'Medical licence']) await create('etmf.ExpectedDocument', { site: siteId, study, artifact, phase: 'start_up' })
    await create('etmf.Reminder', { site: siteId, sent_to: 'owen.price@site101.example', subject: 'MW-301: 2 documents needed' })
    await api.call(manager, ch.CASES_START, { workflowId: 'remind-site', values: { site: siteId }, project: 'mw301' })
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  const edit = async (ctx: RequestContext) => {
    const opened = await api.call<{ sessionId: string }>(ctx, ch.CHAT_OPEN, { anchor: { kind: 'workflow', id: 'remind-site', project: 'mw301' }, message: 'Also copy the CRA on the second reminder' })
    const tools = { memwise: buildMemwiseToolCallbacks({ sessionId: opened.sessionId }) } as unknown as SessionToolContext
    const live = parse(await handlePlaybookRead(tools, { path: SEND }))
    const changed = (live.content as string)
      .replace('title: Send, wait 5 days, remind again', 'title: Send, wait 5 days, remind again, and copy the CRA from the second reminder')
      .replace('    subject: case.email_subject\n', '    copied:  case.email_cc\n    subject: case.email_subject\n')
    return { sessionId: opened.sessionId, tools, wrote: parse(await handlePlaybookWrite(tools, { files: [{ path: SEND, content: changed }], summary: 'Copy the CRA from the second reminder' })) }
  }

  it("the chat's edit opens a change request for the whole app, not a draft of the study's copy", async () => {
    const { sessionId, tools, wrote } = await edit(manager)
    expect(sessions.contexts.get(sessionId)?.block).toContain('a change made here is a change request for the whole app')
    expect(sessions.contexts.get(sessionId)?.block).not.toContain("that project's own copy")
    expect(wrote).toMatchObject({ status: 'kept', errors: 0, changeRequest: 'CR-001' })
    expect(wrote.next).toContain('QA')
    const summary = (await api.call<MwDraftSummary[]>(manager, ch.DRAFTS_LIST, { workflowId: 'remind-site' })).find((d) => d.id === wrote.draftId)!
    // The app's playbook, every study's: no study copy, and the draft is the request.
    expect(summary).toMatchObject({ chatId: sessionId, kind: 'change' })
    expect(summary.project).toBeUndefined()
    expect(summary.changeRequest).toMatchObject({ label: 'CR-001', project: 'etmf' })
    // "Send for review" doesn't apply: it goes to QA from the request's page.
    const sent = await api.call<MwSubmitDraftResult>(manager, ch.DRAFTS_SUBMIT, wrote.draftId)
    expect(sent).toMatchObject({ applied: false, code: 'draft.change_request', changeRequest: { label: 'CR-001' } })
    // Asking for a study's own copy of a regulated playbook gets the app's draft (and its own request) instead.
    const own = await api.call<MwDraftSummary>(manager, ch.DRAFTS_CREATE, { workflowId: 'remind-site', kind: 'change', project: 'mw301' })
    expect(own.project).toBeUndefined()
    expect(own.changeRequest).toMatchObject({ label: 'CR-002', project: 'etmf' })
    expect(existsSync(join(projectDir, 'projects', 'mw301', 'overrides', 'workflows', 'remind-site'))).toBe(false)

    // The test run still runs it on MW-301's site 101, sending nothing.
    const run = parse(await handlePlaybookTestRun(tools, { record: 'site 101' }))
    expect(run).toMatchObject({ status: 'pass' })
    expect(run.calls.find((c: any) => c.tool === 'etmf.reminder.create').args).toMatchObject({ copied: 'priya.shah@northlight.example' })
  }, 240_000)

  it('a grant in one study can\'t raise a change to the whole app\'s playbook', async () => {
    const mara = await svc.kernel.people.create({ name: 'Mara Novak', email: 'mara@northlight.example', roles: [] })
    await (svc.kernel as any).domains.setGrants(mara.id, [{ role: 'study_manager', domain: 'etmf', project: 'mw301' }], { kind: 'system' })
    const { wrote } = await edit(ctxFor('mara-client', mara.id))
    expect(wrote.error).toContain('change request for the whole app')
  }, 60_000)
})
