/**
 * Projects and pages, Stage 4 (docs/memwise/26-projects-and-pages.md §11): the playbook page's
 * chat changes "Chase missing documents" in a draft, the draft runs on site DE-104 in a throwaway
 * database, and it goes for review; a list's chat filters the list.
 *
 * Against a real Postgres with the eTMF example and scripted models. The chat is not run on a
 * model here: its tool calls are made through the session tools' handlers with the callbacks
 * SessionManager wires for the chat (`buildMemwiseToolCallbacks`, `buildMemwiseRecordToolCallbacks`).
 * The test run goes through the real TestRunner (the `memwise` CLI from source).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { MwCase, MwDraft, MwDraftSummary, MwRecordsChatFilter, MwTestRunDraftResult } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import {
  handlePlaybookFinish, handlePlaybookRead, handlePlaybookTestRun, handlePlaybookWrite, handleRecordsFilter,
  type SessionToolContext,
} from '@memwise/session-tools-core'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { buildMemwiseRecordToolCallbacks, buildMemwiseToolCallbacks } from '../chat-tools'
import { resetMemwiseHost } from '../host'
import { scriptedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const SEND = 'domains/etmf/workflows/chase-missing/steps/send.md'

type Result = { content: { text: string }[]; isError?: boolean }
const parse = (r: Result): any => (r.isError ? { error: r.content[0]?.text ?? '' } : JSON.parse(r.content[0]?.text ?? 'null'))

describe.skipIf(!postgresAvailable())('Stage 4: everything has a page', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  let manager: RequestContext
  let reviewer: RequestContext
  let siteId = ''
  let chatId = ''
  let draftId = ''

  const create = async (entity: string, values: Record<string, unknown>) => {
    const r = await api.call(manager, ch.RECORDS_CREATE, { entity, values, reason: 'study set-up' })
    expect(r).toMatchObject({ applied: true })
    return r.id as string
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_stage4', { migrate: false })
    const admin = new URL(db.url)
    admin.pathname = '/postgres'
    dir = mkdtempSync(join(tmpdir(), 'mw-stage4-'))
    const projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true })
    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      // The chase's writer drafts its email with the turns of its "second-reminder" example.
      modelResolver: (input) => scriptedModels(input, 'second-reminder'),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@northlight.example' },
      testDatabaseUrl: admin.toString(),
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const anika = await svc.kernel.people.create({ name: 'Anika Rao', email: 'anika@northlight.example', roles: ['study_manager', 'staff'] })
    const omar = await svc.kernel.people.create({ name: 'Omar Haddad', email: 'omar@northlight.example', roles: ['manager'] })
    manager = ctxFor('manager-client', anika.id)
    reviewer = ctxFor('reviewer-client', omar.id)

    const sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' })
    const study = await create('etmf.Study', { code: 'MW-301', sponsor })
    siteId = await create('etmf.Site', {
      site_number: 'DE-104', study, coordinator_email: 'coordinator@charite-studien.example',
      cra_name: 'Priya Shah', cra_email: 'priya.shah@northlight.example',
    })
    for (const artifact of ['Protocol signature page', 'Lab normal ranges', 'Sub-investigator CVs']) {
      await create('etmf.ExpectedDocument', { site: siteId, study, artifact, phase: 'start_up' })
    }
    await create('etmf.Reminder', { site: siteId, sent_to: 'coordinator@charite-studien.example', subject: 'MW-301: 3 documents needed' })
    expect(await api.call(manager, ch.RECORDS_TRANSITION, { entity: 'etmf.Site', id: siteId, transition: 'picked', reason: 'Selected' }))
      .toMatchObject({ applied: true })
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('the site\'s chase drafts its reminder and waits for the study manager', async () => {
    const cases = await until('the chase', () => api.call<any[]>(manager, ch.CASES_LIST, { workflowId: 'chase-missing' }), (xs) => xs.length > 0, 30_000)
    const c = await until('at approve_email', () => api.call<MwCase>(manager, ch.CASES_GET, cases[0].caseId), (x) => x.state === 'approve_email' || x.status !== 'active', 60_000)
    expect(c.state).toBe('approve_email')
    expect(c.values.email_to?.value).toBe('coordinator@charite-studien.example')
  }, 90_000)

  it('the playbook\'s chat drafts the change: kept at once, in a draft of its own', async () => {
    const opened = await api.call<{ sessionId: string }>(manager, ch.CHAT_OPEN, { anchor: { kind: 'workflow', id: 'chase-missing' }, message: 'Also copy the CRA on the second reminder' })
    chatId = opened.sessionId
    expect(sessions.contexts.get(chatId)?.anchor).toEqual({ kind: 'workflow', id: 'chase-missing' })
    const ctx = { memwise: buildMemwiseToolCallbacks({ sessionId: chatId }) } as unknown as SessionToolContext
    const live = parse(await handlePlaybookRead(ctx, { path: SEND }))
    const changed = (live.content as string)
      .replace('title: Send, wait 5 days, remind again', 'title: Send, wait 5 days, remind again, and copy the CRA from the second reminder')
      .replace('    subject: case.email_subject\n', '    copied:  case.email_cc\n    subject: case.email_subject\n')
    const wrote = parse(await handlePlaybookWrite(ctx, { files: [{ path: SEND, content: changed }], summary: 'Copy the CRA from the second reminder' }))
    expect(wrote).toMatchObject({ status: 'kept', errors: 0 })
    draftId = wrote.draftId
    const drafts = await api.call<MwDraftSummary[]>(manager, ch.DRAFTS_LIST, { workflowId: 'chase-missing' })
    expect(drafts.find((d) => d.id === draftId)).toMatchObject({ chatId, kind: 'change', pendingEdits: 0, stage: 'draft' })
    // The chat never sends it for review: the page's button does.
    expect(parse(await handlePlaybookFinish(ctx, { summary: 'Copy the CRA' })).error).toContain('Send for review')
  }, 60_000)

  it('the chat runs it on site 104: nothing is sent, and the reminder would copy Priya Shah', async () => {
    const ctx = { memwise: buildMemwiseToolCallbacks({ sessionId: chatId }) } as unknown as SessionToolContext
    const run = parse(await handlePlaybookTestRun(ctx, { record: 'site 104' }))
    expect(run.error).toBeUndefined()
    expect(run).toMatchObject({ status: 'pass', stoppedAt: 'wait_for_upload (active)' })
    const reminder = run.calls.find((c: any) => c.tool === 'etmf.reminder.create')
    expect(reminder.args).toMatchObject({ sent_to: 'coordinator@charite-studien.example', copied: 'priya.shah@northlight.example' })

    const draft = await api.call<MwDraft>(manager, ch.DRAFTS_GET, draftId)
    expect(draft.testRun).toBe('pass')
    expect(draft.testRunStale).toBe(false)
    expect(draft.lastTestRun).toMatchObject({ status: 'pass', record: { entity: 'etmf.Site', id: siteId }, byName: 'Anika Rao' })
    expect(draft.structure?.steps.send?.parts).toEqual(expect.arrayContaining(['title', 'map']))
  }, 180_000)

  it('the page runs it on a record too, and refuses one it can\'t start from', async () => {
    const r = await api.call<MwTestRunDraftResult>(manager, ch.DRAFTS_TEST_RUN, { draftId, record: { entity: 'etmf.Site', id: siteId } })
    expect(r).toMatchObject({ applied: true, testRun: { status: 'pass', record: { title: expect.stringContaining('DE-104') } } })
    const study = (await api.call<any>(manager, ch.RECORDS_QUERY, { entity: 'etmf.Study' })).rows[0].id
    const refused = await api.call<MwTestRunDraftResult>(manager, ch.DRAFTS_TEST_RUN, { draftId, record: { entity: 'etmf.Study', id: study } })
    expect(refused).toMatchObject({ applied: false, code: 'draft.test_run_failed' })
    expect(refused.message).toContain("doesn't start from a Study")
  }, 180_000)

  it('Send for review starts the change run, which waits for a manager', async () => {
    const sent = await api.call<any>(manager, ch.DRAFTS_SUBMIT, draftId)
    expect(sent).toMatchObject({ applied: true })
    const c = await until('the review', () => api.call<MwCase>(reviewer, ch.CASES_GET, sent.caseId), (x) => x.state === 'review' || x.status !== 'active', 170_000)
    expect(c.state).toBe('review')
    expect((await api.call<MwDraft>(manager, ch.DRAFTS_GET, draftId)).stage).toBe('in_review')
  }, 180_000)

  it('a list\'s chat filters the list: chips on the page, a bad filter refused, × clears it', async () => {
    const opened = await api.call<{ sessionId: string }>(manager, ch.CHAT_OPEN, { anchor: { kind: 'records', id: 'etmf.Site' }, message: 'Which sites are missing documents?' })
    const context = sessions.contexts.get(opened.sessionId)!
    expect(context.anchor).toEqual({ kind: 'records', id: 'etmf.Site' })
    expect(context.block).toContain('DE-104')
    const ctx = { memwiseRecords: buildMemwiseRecordToolCallbacks({ sessionId: opened.sessionId }) } as unknown as SessionToolContext
    expect(parse(await handleRecordsFilter(ctx, { filter: 'missing_documentz > 0', label: 'Missing documents' })).error).toBeTruthy()
    const set = parse(await handleRecordsFilter(ctx, { filter: 'missing_documents > 0', label: 'Missing documents', chips: ['Missing documents'] }))
    expect(set).toMatchObject({ applied: true, total: 1, chips: ['Missing documents'] })
    const shown = await api.call<MwRecordsChatFilter | null>(manager, ch.RECORDS_CHAT_FILTER_GET, { entity: 'etmf.Site' })
    expect(shown).toMatchObject({ entity: 'etmf.Site', sessionId: opened.sessionId, filter: 'missing_documents > 0', label: 'Missing documents' })
    // Only for the person whose chat it is.
    expect(await api.call(reviewer, ch.RECORDS_CHAT_FILTER_GET, { entity: 'etmf.Site' })).toBeNull()
    expect(await api.call(manager, ch.RECORDS_CHAT_FILTER_CLEAR, { entity: 'etmf.Site' })).toEqual({ applied: true })
    expect(await api.call(manager, ch.RECORDS_CHAT_FILTER_GET, { entity: 'etmf.Site' })).toBeNull()
  }, 60_000)
})
