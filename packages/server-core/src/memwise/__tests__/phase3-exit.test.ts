/**
 * Phase 3 exit test (20 §10): the app API and the chat's playbook tools, driven as staff, a
 * manager and a partner against a real Postgres with scripted models. Example cases and past
 * cases run out of process through the real TestRunner (the `memwise` CLI from source).
 *
 * 1. Staff start "New playbook"; the chat's tool calls build `engagement-letter` in a draft (case
 *    type, steps, a new `partner` role, example cases); the checks pass; `playbook_finish` ends
 *    the interview; the check step passes; the manager approves in the inbox; it is published as
 *    v1, and a case runs on it through the partner's approval to the recorded Engagement.
 * 2. "Change with chat" on client intake makes `recall.similar_cases` a required tool of `check`
 *    and updates the example cases; the review shows the structural diff (step `check`: tools)
 *    and the impact counts the open intake case; approved, it is v2. The case started before
 *    stays on v1 and finishes there; a new case starts on v2.
 * 3. A chat edit is discarded and the file is back; a correction on a case becomes an example case
 *    in a draft; `memwise diff` and `memwise push` work on a plain folder.
 *
 * The chat itself is not run on a model here: its tool calls are made through the session tools'
 * handlers with the callbacks SessionManager wires for an anchored chat (`buildMemwiseToolCallbacks`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import type { ScriptedTurn } from '@memwise/defs'
import type { MwCase, MwCaseSummary, MwDraft, MwInboxItem, MwVersion } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import {
  handlePlaybookCheck, handlePlaybookDiff, handlePlaybookFinish, handlePlaybookRead, handlePlaybookVocabulary, handlePlaybookWrite,
  type SessionToolContext,
} from '@memwise/session-tools-core'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until as untilOk } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { buildMemwiseToolCallbacks } from '../chat-tools'
import { resetMemwiseHost } from '../host'
import type { ModelResolverInput, ResolvedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const FIXTURE = join(import.meta.dir, 'fixtures', 'engagement-letter')
const CLI = join(REPO, 'packages', 'runtime', 'src', 'cli.ts')
const ch = RPC_CHANNELS.memwise

const CHECK = 'workflows/client-intake/steps/check.md'
const EXTRACT_CALL = '        - { name: intake.extract_fields, args: { documents: [pan-card.pdf, gst-certificate.pdf] } }\n'
const RECALL_CALL = '        - { name: recall.similar_cases, args: { limit: 5 } }\n'
const CHECKED_EXAMPLES = ['clean-application', 'full-intake', 'pan-mismatch']

/** Every file of the fixture, project-relative (what the chat writes into the draft). */
function fixtureFiles(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push({ path: relative(FIXTURE, p).split('\\').join('/'), content: readFileSync(p, 'utf8') })
    }
  }
  walk(FIXTURE)
  return out
}

/** The change to client intake's check step: similar past cases become a required look-up. */
const requireRecall = (checkMd: string) => checkMd
  .replace('required: [gst.validate_gstin]', 'required: [gst.validate_gstin, recall.similar_cases]')
  .replace('Compare what the client typed', 'Look at how the check ended on similar past cases (`recall.similar_cases`), and say in the\nrationale if one of them was flagged.\n\nCompare what the client typed')

/** An example whose scripted checker also makes the new call. */
const exampleCallsRecall = (yaml: string) => {
  if (yaml.split(EXTRACT_CALL).length !== 2) throw new Error('the example does not have exactly one extract_fields call')
  return yaml.replace(EXTRACT_CALL, EXTRACT_CALL + RECALL_CALL)
}

/**
 * Scripted models for the whole test: intake's clean-application script, with the checker also
 * calling `recall.similar_cases` (allowed on v1, required on v2), and the engagement letter's
 * drafter from the fixture's example case.
 */
async function phase3Models(input: ModelResolverInput): Promise<ResolvedModels> {
  const { scriptedProvider } = await import('@memwise/gateway')
  const { parseExampleFile } = await import('@memwise/defs')
  const clean = input.project!.workflows['client-intake']!.examples.find((e) => e.name === 'clean-application')!
  const checker = structuredClone(clean.model!.checker!) as ScriptedTurn[]
  checker[0]!.toolCalls!.push({ name: 'recall.similar_cases', args: { limit: 5 } })
  const file = join(FIXTURE, 'workflows/engagement-letter/examples/letter-approved.yaml')
  const letter = parseExampleFile(readFileSync(file, 'utf8'), file).value!
  const script: Record<string, ScriptedTurn[]> = { ...clean.model!, checker, drafter: letter.model!.drafter! }
  const roles = [...new Set([...input.roles, ...Object.keys(script)])]
  return {
    modelRoles: Object.fromEntries(roles.map((r) => [r, { provider: 'scripted', model: 'scripted' }])),
    providers: [scriptedProvider(script)],
    configured: true,
    message: 'Scripted answers for the Phase 3 exit test.',
    example: clean,
  }
}

type ToolName = 'playbook_vocabulary' | 'playbook_read' | 'playbook_write' | 'playbook_diff' | 'playbook_check' | 'playbook_finish'

/** The chat's session tools, as the agent in that chat calls them. Errors come back as `{ error }`. */
function chatTools(sessionId: string) {
  const ctx = { memwise: buildMemwiseToolCallbacks({ sessionId }) } as unknown as SessionToolContext
  const handlers: Record<ToolName, (c: SessionToolContext, a: any) => Promise<{ content: { text: string }[]; isError?: boolean }>> = {
    playbook_vocabulary: handlePlaybookVocabulary,
    playbook_read: handlePlaybookRead,
    playbook_write: handlePlaybookWrite,
    playbook_diff: handlePlaybookDiff,
    playbook_check: handlePlaybookCheck,
    playbook_finish: handlePlaybookFinish,
  }
  return async (name: ToolName, args: Record<string, unknown> = {}): Promise<any> => {
    const r = await handlers[name](ctx, args)
    const text = r.content[0]?.text ?? ''
    return r.isError ? { error: text } : JSON.parse(text)
  }
}

/**
 * Polls like the harness's `until`, but rides out a Postgres deadlock (40P01) on a read. Publishing
 * re-indexes the project, and the kernel re-applies the domain tables' row rules (DDL) on every
 * index, which can deadlock with a read made at that moment. Reported to the kernel side; a client
 * would simply refetch.
 */
function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs?: number): Promise<T> {
  const retrying = async (): Promise<T> => {
    for (let i = 0; ; i++) {
      try { return await fn() } catch (e) {
        if ((e as { code?: string }).code !== '40P01' || i >= 5) throw e
      }
    }
  }
  return untilOk(what, retrying, ok, timeoutMs)
}

async function runCli(args: string[], timeoutMs = 300_000): Promise<{ code: number | null; output: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  clearTimeout(timer)
  return { code, output: `${out}${err}` }
}

describe.skipIf(!postgresAvailable())('Phase 3 exit: building and changing playbooks by chat', () => {
  let db: TestDatabase
  let dir: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  let staff: RequestContext
  let manager: RequestContext
  let partner: RequestContext
  const temps: string[] = []

  const filledIntake = {
    client_name: 'Asha Rao',
    client_email: 'asha@acme-traders.example',
    pan: 'AAACA1234A',
    gstin: '29AAACA1234A1Z5',
    annual_turnover: { amount: 42000000, currency: 'INR' },
    documents: [] as unknown[],
  }

  async function caseAt(who: RequestContext, caseId: string, state: string, timeoutMs = 120_000): Promise<MwCase> {
    return until(`case ${caseId} at ${state}`, () => api.call<MwCase>(who, ch.CASES_GET, caseId),
      (c) => c.state === state || c.status !== 'active', timeoutMs)
  }

  async function inboxItem<K extends MwInboxItem['kind']>(who: RequestContext, kind: K, pick: (i: Extract<MwInboxItem, { kind: K }>) => boolean, timeoutMs = 60_000) {
    const items = await until(`a ${kind} item`, () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST),
      (list) => list.some((i) => i.kind === kind && pick(i as Extract<MwInboxItem, { kind: K }>)), timeoutMs)
    return items.find((i) => i.kind === kind && pick(i as Extract<MwInboxItem, { kind: K }>)) as Extract<MwInboxItem, { kind: K }>
  }

  /** Staff start an intake case and fill the form; the check runs; it waits for the manager. */
  async function intakeAtVerify(): Promise<MwCase> {
    const started = await api.call<MwCaseSummary>(staff, ch.CASES_START, { workflowId: 'client-intake', values: {} })
    const form = await inboxItem(staff, 'input', (i) => i.caseId === started.caseId)
    const doc = (name: string, text: string) => api.call(staff, ch.FILES_UPLOAD, { name, mime: 'application/pdf', data: Buffer.from(text).toString('base64') })
    const docs = [await doc('pan-card.pdf', 'PAN AAACA1234A'), await doc('gst-certificate.pdf', 'GSTIN 29AAACA1234A1Z5')]
    expect(await api.call<any>(staff, ch.INBOX_SUBMIT, { stepRunId: form.stepRunId, outcome: 'submitted', values: { ...filledIntake, documents: docs } })).toEqual({ applied: true })
    const c = await caseAt(staff, started.caseId, 'verify')
    expect(c.state).toBe('verify')
    return c
  }

  /** The manager approves the change run's review step, and the run publishes. */
  async function managerApproves(caseId: string): Promise<MwCase> {
    const review = await inboxItem(manager, 'decision', (i) => i.caseId === caseId)
    expect(review.outcomes).toEqual(['approved', 'changes_requested'])
    expect(await api.call<any>(manager, ch.INBOX_SUBMIT, { stepRunId: review.stepRunId, outcome: 'approved' })).toEqual({ applied: true })
    const done = await until('the change run published', () => api.call<MwCase>(manager, ch.CASES_GET, caseId), (c) => c.status !== 'active', 120_000)
    expect(done).toMatchObject({ status: 'done', state: 'end' })
    return done
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_exit3', { migrate: false })
    const admin = new URL(db.url)
    admin.pathname = '/postgres'
    dir = mkdtempSync(join(tmpdir(), 'mw-exit3-'))
    temps.push(dir)
    svc = (await startMemwiseService({
      configDir: dir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: phase3Models,
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@example.com' },
      // Example cases run in the `memwise test` CLI on throwaway databases of this cluster.
      testDatabaseUrl: admin.toString(),
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const priya = await svc.kernel.people.create({ name: 'Priya', email: 'priya@example.com', roles: ['staff'] })
    const ravi = await svc.kernel.people.create({ name: 'Ravi', email: 'ravi@example.com', roles: ['manager'] })
    staff = ctxFor('staff-client', priya.id)
    manager = ctxFor('manager-client', ravi.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    for (const d of temps) rmSync(d, { recursive: true, force: true })
  }, 60_000)

  // ------------------------------------------------------------------ 1. a new playbook by chat

  let build = { sessionId: '', runId: '', caseId: '', stepRunId: '' }
  let letterDraft = ''

  it('"New playbook" starts create-playbook and opens its chat with the guide as context', async () => {
    const request = 'We need engagement letters for onboarded customers, drafted for us and approved by a partner.'
    build = await api.call(staff, ch.PLAYBOOKS_BUILD, { request, title: 'Engagement letter' })
    expect(build.stepRunId).toBe(`${build.runId}/0/interview`)
    expect(sessions.created.find((s) => s.id === build.sessionId)?.name).toBe('Building: Engagement letter')

    // Context is a system-prompt block, not a message; the first turn is hidden.
    const context = sessions.contexts.get(build.sessionId)!
    expect(context).toMatchObject({ anchor: { kind: 'step', id: build.stepRunId }, conversation: true, personName: 'Priya' })
    expect(context.block).toContain(request)
    expect(context.block).toContain('Walk me through what happens when')
    const kickoff = sessions.sent.find((m) => m.sessionId === build.sessionId)!
    expect(kickoff.hidden).toBe(true)
    expect(kickoff.message).not.toContain(request)

    // The inbox's conversation item reopens the same chat; so does opening the step.
    const item = await inboxItem(staff, 'conversation', (i) => i.stepRunId === build.stepRunId)
    expect(item).toMatchObject({ caseId: build.caseId, workflowId: 'create-playbook', sessionId: build.sessionId, caseTitle: 'Engagement letter', assignee: 'staff' })
    expect(item.draftId).toBeUndefined()
    expect(await api.call<any>(staff, ch.CHAT_OPEN, { anchor: { kind: 'step', id: build.stepRunId } })).toEqual({ sessionId: build.sessionId })
    expect((await api.call<MwInboxItem[]>(manager, ch.INBOX_LIST)).some((i) => i.kind === 'conversation')).toBe(false)
    // Opening it as someone without the step's role is refused; so is building, before any run starts.
    await expect(api.call(manager, ch.CHAT_OPEN, { anchor: { kind: 'step', id: build.stepRunId } })).rejects.toThrow(/staff/)
    const runsBefore = (await api.call<MwCaseSummary[]>(manager, ch.CASES_LIST, { workflowId: 'create-playbook' })).length
    await expect(api.call(manager, ch.PLAYBOOKS_BUILD, { request: 'Anything' })).rejects.toThrow(/staff role/)
    expect(await api.call<MwCaseSummary[]>(manager, ch.CASES_LIST, { workflowId: 'create-playbook' })).toHaveLength(runsBefore)
  }, 60_000)

  it('the chat builds engagement-letter in a draft with its tools, and the checks pass', async () => {
    const tool = chatTools(build.sessionId)
    const vocabulary = await tool('playbook_vocabulary')
    expect(vocabulary.roles.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['staff', 'manager']))
    expect(vocabulary.tools.find((t: { name: string }) => t.name === 'domain.engagement.create')).toMatchObject({ effect: 'write' })
    expect(await tool('playbook_diff')).toMatchObject({ draftId: null })

    // The first write makes the draft, and needs the new playbook's id.
    const files = fixtureFiles()
    const shape = files.filter((f) => !f.path.includes('/examples/'))
    const examples = files.filter((f) => f.path.includes('/examples/'))
    expect((await tool('playbook_write', { files: shape, summary: 'The shape, case type and steps' })).error).toMatch(/playbook/)
    const first = await tool('playbook_write', { files: shape, summary: 'The shape, case type and steps; a partner role', playbook: 'engagement-letter' })
    expect(first).toMatchObject({ errors: 0, status: 'pending' })
    letterDraft = first.draftId
    const second = await tool('playbook_write', { files: examples, summary: 'Two example cases: approved, and sent back once' })
    expect(second).toMatchObject({ draftId: letterDraft, errors: 0 })

    const read = await tool('playbook_read', { path: 'workflows/engagement-letter/steps/record.md' })
    expect(read.content).toContain('domain.engagement.create')
    const diff = await tool('playbook_diff')
    expect(diff.structure.roles.added).toEqual(['partner'])
    expect(Object.keys(diff.structure.steps).sort()).toEqual(['draft_letter', 'partner_review', 'record', 'request'])

    const report = await tool('playbook_check')
    expect(report).toMatchObject({ outcome: 'passed', errors: 0 })
    expect(report.examples).toEqual([
      { name: 'letter-approved', status: 'pass', differences: [] },
      { name: 'partner-sends-back', status: 'pass', differences: [] },
    ])

    // The editor and the inbox see the draft, its chat edits and the passed check.
    const draft = await api.call<MwDraft>(staff, ch.DRAFTS_GET, letterDraft)
    expect(draft).toMatchObject({ kind: 'create', workflowId: 'engagement-letter', stage: 'checked', reportStale: false, pendingEdits: 2, runId: build.runId, caseId: build.caseId })
    expect(draft.edits.map((e) => [e.via, e.sessionId, e.byName])).toEqual([['chat', build.sessionId, 'Priya'], ['chat', build.sessionId, 'Priya']])
    expect(draft.files.find((f) => f.path === 'domain/roles.yaml')).toMatchObject({ status: 'modified', pendingEditId: first.editId, after: expect.stringContaining('partner:') })
    // The step editor gets every file of the playbook's folder, and the domain files it changes.
    expect(Object.keys(draft.fileTexts ?? {}).sort()).toEqual(files.map((f) => f.path).sort())
    expect(draft.fileTexts?.['workflows/engagement-letter/steps/record.md']).toBe(files.find((f) => f.path.endsWith('record.md'))!.content)
    expect(draft.playbook?.steps.partner_review).toMatchObject({ performer: 'person', assignee: 'partner' })
    expect(draft.diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    expect(await api.call<any>(staff, ch.DRAFTS_KEEP, { draftId: letterDraft, editId: first.editId })).toEqual({ applied: true })
    expect((await inboxItem(staff, 'conversation', (i) => i.stepRunId === build.stepRunId)).draftId).toBe(letterDraft)
  }, 300_000)

  it('playbook_finish ends the interview; the check passes; the manager approves; v1 is live', async () => {
    const tool = chatTools(build.sessionId)
    const finished = await tool('playbook_finish', {
      title: 'Engagement letter',
      summary: 'Staff ask for an engagement letter for an onboarded customer. An agent drafts it from the scope, fee and start date. A partner approves it or sends it back with a comment, and the engagement is recorded.',
      rationale: 'Priya confirmed the steps and the partner approval.',
    })
    expect(finished).toMatchObject({ applied: true, draftId: letterDraft, outcome: 'drafted' })
    // Finishing again is refused: the step is no longer waiting on the chat.
    expect((await tool('playbook_finish', { summary: 'again' })).error).toMatch(/no longer waiting|already answered/)

    const atReview = await caseAt(manager, build.caseId, 'review')
    expect(atReview.state).toBe('review')
    expect(atReview.values.summary?.provenance).toMatchObject({ kind: 'judgement', chatId: build.sessionId })
    expect(atReview.values.errors?.value).toBe(0)
    const inReview = await api.call<MwDraft>(manager, ch.DRAFTS_GET, letterDraft)
    expect(inReview.stage).toBe('in_review')
    expect(await api.call<any>(staff, ch.DRAFTS_SUBMIT, letterDraft)).toMatchObject({ applied: false, code: 'draft.in_review' })

    await managerApproves(build.caseId)
    const list = await until('engagement-letter listed', () => api.call(staff, ch.PLAYBOOKS_LIST), (l: { id: string }[]) => l.some((p) => p.id === 'engagement-letter'))
    expect(list.find((p: { id: string }) => p.id === 'engagement-letter')).toMatchObject({ title: 'Engagement letter' })
    const versions = await api.call<MwVersion[]>(staff, ch.PLAYBOOKS_VERSIONS, 'engagement-letter')
    expect(versions).toEqual([expect.objectContaining({ version: 1, source: 'app', publishedByName: 'Ravi', draftId: letterDraft, runId: build.runId, live: true, openCases: 0 })])
    expect((await api.call<MwDraft>(staff, ch.DRAFTS_GET, letterDraft)).stage).toBe('published')
    expect((await api.call(staff, ch.ROLES_LIST)).map((r: { id: string }) => r.id)).toContain('partner')
  }, 300_000)

  it('a case runs on the new playbook: staff ask, the agent drafts, the partner approves, the engagement is recorded', async () => {
    const meera = await svc.kernel.people.create({ name: 'Meera', email: 'meera@example.com', roles: ['partner'] })
    partner = ctxFor('partner-client', meera.id)
    const started = await api.call<MwCaseSummary>(staff, ch.CASES_START, { workflowId: 'engagement-letter', values: {} })
    expect(started).toMatchObject({ state: 'request', workflowVersion: 1, waitingOn: { kind: 'role', role: 'staff' } })
    const form = await inboxItem(staff, 'input', (i) => i.caseId === started.caseId)
    expect(form.fields.map((f) => f.name)).toEqual(['client_name', 'client_email', 'scope', 'fee', 'start_date'])
    expect(await api.call<any>(staff, ch.INBOX_SUBMIT, {
      stepRunId: form.stepRunId, outcome: 'submitted',
      values: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', scope: 'Statutory audit of the accounts for FY 2026-27', fee: { amount: 250000, currency: 'INR' }, start_date: '2026-11-01' },
    })).toEqual({ applied: true })

    const atPartner = await caseAt(partner, started.caseId, 'partner_review')
    expect(atPartner).toMatchObject({ state: 'partner_review', waitingOn: { kind: 'role', role: 'partner' } })
    expect(atPartner.values.engagement_title?.value).toBe('Statutory audit FY 2026-27')
    expect(String(atPartner.values.letter?.value)).toContain('Dear Asha Rao')
    const decision = await inboxItem(partner, 'decision', (i) => i.caseId === started.caseId)
    expect(decision).toMatchObject({ stepTitle: 'Partner approves the letter', outcomes: ['approved', 'sent_back'] })
    expect((await api.call<MwInboxItem[]>(manager, ch.INBOX_LIST)).some((i) => i.caseId === started.caseId)).toBe(false)

    expect(await api.call<any>(partner, ch.INBOX_SUBMIT, { stepRunId: decision.stepRunId, outcome: 'approved' })).toEqual({ applied: true })
    const done = await until('the letter case done', () => api.call<MwCase>(partner, ch.CASES_GET, started.caseId), (c) => c.status !== 'active')
    expect(done).toMatchObject({ status: 'done', state: 'end' })
    const engagements = await api.call(partner, ch.ENTITIES_LIST, 'Engagement')
    expect(engagements).toHaveLength(1)
    expect(engagements[0].values.title.value).toBe('Statutory audit FY 2026-27')
    expect(done.values.engagement?.value).toBe(engagements[0].id)
  }, 120_000)

  // ------------------------------------------------------------------ 2. changing a live playbook by chat

  let oldCase: MwCase
  let change = { sessionId: '', runId: '', caseId: '', stepRunId: '' }
  let changeDraft = ''

  it('"Change with chat" on client intake opens a chat on a change draft', async () => {
    oldCase = await intakeAtVerify()
    expect(oldCase.workflowVersion).toBe(1)

    change = await api.call(staff, ch.PLAYBOOKS_BUILD, { workflowId: 'client-intake', request: 'Before deciding, the check should always look at how similar past cases went.' })
    expect(sessions.created.find((s) => s.id === change.sessionId)?.name).toBe('Changing: Client intake')
    const item = await inboxItem(staff, 'conversation', (i) => i.stepRunId === change.stepRunId)
    expect(item.workflowId).toBe('change-playbook')
    expect(item.sessionId).toBe(change.sessionId)
    changeDraft = item.draftId!
    expect(changeDraft).toBeTruthy()
    // The draft is already on the case, so the chat's context names it and the playbook's files.
    const block = sessions.contexts.get(change.sessionId)!.block
    expect(block).toContain('similar past cases went')
    expect(block).toContain(CHECK)
    const drafts = await api.call(staff, ch.DRAFTS_LIST, { workflowId: 'client-intake' })
    expect(drafts.find((x: { id: string }) => x.id === changeDraft)).toMatchObject({ kind: 'change', stage: 'draft', baseVersion: 1, runId: change.runId })
  }, 180_000)

  it('the chat makes the check require the new tool; the example cases fail until they are updated', async () => {
    const tool = chatTools(change.sessionId)
    const live = await tool('playbook_read', { path: CHECK })
    const edit = await tool('playbook_write', { files: [{ path: CHECK, content: requireRecall(live.content) }], summary: 'The check must look at similar past cases' })
    expect(edit).toMatchObject({ draftId: changeDraft, errors: 0 })

    const failing = await tool('playbook_check', { pastCases: 0 })
    expect(failing.outcome).toBe('failed')
    expect(failing.examples.find((e: { name: string }) => e.name === 'clean-application')).toMatchObject({ status: 'fail' })

    const updated = []
    for (const name of CHECKED_EXAMPLES) {
      const path = `workflows/client-intake/examples/${name}.yaml`
      updated.push({ path, content: exampleCallsRecall((await tool('playbook_read', { path })).content) })
    }
    expect(await tool('playbook_write', { files: updated, summary: 'The example cases look at similar past cases too' })).toMatchObject({ errors: 0 })
    const passing = await tool('playbook_check')
    expect(passing).toMatchObject({ outcome: 'passed', errors: 0 })
    expect(passing.examples.every((e: { status: string }) => e.status === 'pass')).toBe(true)

    const diff = await tool('playbook_diff')
    expect(diff.structure.requiredTools).toEqual([{ step: 'check', tool: 'recall.similar_cases', change: 'added' }])
    expect(diff.structure.version).toEqual({ from: 1, to: 2 })

    expect(await tool('playbook_finish', { summary: 'The check now always looks at how similar past cases went before deciding, and says so when one was flagged. The example cases do the same. Running cases stay on version 1.' }))
      .toMatchObject({ applied: true, draftId: changeDraft })
  }, 300_000)

  it('the review shows the structural diff and the impact on the open intake case; approved, v2 is live', async () => {
    await caseAt(manager, change.caseId, 'review')
    const draft = await api.call<MwDraft>(manager, ch.DRAFTS_GET, changeDraft)
    expect(draft.stage).toBe('in_review')
    expect(draft.structure?.steps.check).toEqual({ change: 'changed', parts: expect.arrayContaining(['tools']) })
    expect(draft.structure?.requiredTools).toEqual([{ step: 'check', tool: 'recall.similar_cases', change: 'added' }])
    expect(draft.files.map((f) => f.path)).toEqual(expect.arrayContaining([CHECK, 'workflows/client-intake/workflow.yaml', 'workflows/client-intake/examples/clean-application.yaml']))
    expect(draft.report).toMatchObject({ outcome: 'passed' })
    expect(draft.report!.impact).toMatchObject({
      liveVersion: 1, newVersion: 2,
      openCases: { total: 1, byState: { verify: 1 } },
      newRequiredTools: [{ step: 'check', tool: 'recall.similar_cases' }],
    })

    await managerApproves(change.caseId)
    const versions = await until('client-intake v2', () => api.call<MwVersion[]>(staff, ch.PLAYBOOKS_VERSIONS, 'client-intake'), (v) => v.some((x) => x.version === 2 && x.live))
    expect(versions.find((v) => v.version === 2)).toMatchObject({ source: 'app', publishedByName: 'Ravi', draftId: changeDraft, live: true })
    expect(versions.find((v) => v.version === 1)).toMatchObject({ live: false, openCases: 1 })
    const pb = await api.call(staff, ch.PLAYBOOKS_GET, 'client-intake')
    expect(pb.version).toBe(2)
  }, 300_000)

  let newCase: MwCase

  it('the case started before stays on v1 and finishes there; a new case starts on v2', async () => {
    const verify = await inboxItem(manager, 'decision', (i) => i.caseId === oldCase.caseId)
    expect(await api.call<any>(manager, ch.INBOX_SUBMIT, { stepRunId: verify.stepRunId, outcome: 'approved' })).toEqual({ applied: true })
    const done = await until('the v1 case done', () => api.call<MwCase>(manager, ch.CASES_GET, oldCase.caseId), (c) => c.status !== 'active')
    expect(done).toMatchObject({ status: 'done', workflowVersion: 1 })

    newCase = await intakeAtVerify()
    expect(newCase.workflowVersion).toBe(2)
    const check = newCase.timeline.find((t) => t.stepId === 'check')!
    const record = await api.call(staff, ch.STEPS_GET, check.stepRunId)
    expect(JSON.stringify(record)).toContain('recall.similar_cases')
  }, 240_000)

  // ------------------------------------------------------------------ 3. discard, corrections, the CLI

  it('a chat edit is discarded and the file is back', async () => {
    const opened = await api.call(staff, ch.PLAYBOOKS_BUILD, { workflowId: 'engagement-letter', request: 'Shorter letters.' })
    expect(sessions.created.find((s) => s.id === opened.sessionId)?.name).toBe('Changing: Engagement letter')
    const tool = chatTools(opened.sessionId)
    const path = 'workflows/engagement-letter/steps/draft_letter.md'
    const before = (await tool('playbook_read', { path })).content as string
    const edit = await tool('playbook_write', { files: [{ path, content: before.replace('Keep it to one page', 'Keep it to half a page') }], summary: 'Shorter letters' })
    const draftId = edit.draftId as string

    const withEdit = await api.call<MwDraft>(staff, ch.DRAFTS_GET, draftId)
    expect(withEdit.files.find((f) => f.path === path)).toMatchObject({ status: 'modified', pendingEditId: edit.editId })
    expect(withEdit.pendingEdits).toBe(1)

    expect(await api.call<any>(staff, ch.DRAFTS_DISCARD_EDIT, { draftId, editId: edit.editId })).toEqual({ applied: true })
    expect((await tool('playbook_read', { path })).content).toBe(before)
    const after = await api.call<MwDraft>(staff, ch.DRAFTS_GET, draftId)
    expect(after.files.find((f) => f.path === path)).toBeUndefined()
    expect(after.edits.find((e) => e.id === edit.editId)?.status).toBe('discarded')
    expect(await api.call<any>(staff, ch.DRAFTS_DISCARD_EDIT, { draftId, editId: edit.editId })).toMatchObject({ applied: false, code: 'edit.not_pending' })
    expect(await api.call<any>(staff, ch.DRAFTS_KEEP, { draftId, editId: 'edit-nope' })).toMatchObject({ applied: false, code: 'edit.missing' })
    expect(await api.call<any>(staff, ch.DRAFTS_KEEP, { draftId: 'no-such-draft', editId: 'x' })).toMatchObject({ applied: false, code: 'draft.missing' })
  }, 120_000)

  it('a correction on a case becomes an example case in a draft, and the draft checks clean', async () => {
    const r = await api.call(manager, ch.EXAMPLES_FROM_CASE, {
      caseId: oldCase.caseId, name: 'should-send-back',
      correction: { step: 'verify', outcome: 'sent_back', note: 'The GST certificate scan was unreadable.' },
    })
    expect(r).toMatchObject({ applied: true, path: 'workflows/client-intake/examples/should-send-back.yaml' })
    const draft = await api.call<MwDraft>(manager, ch.DRAFTS_GET, r.draftId)
    expect(draft).toMatchObject({ kind: 'change', workflowId: 'client-intake', baseVersion: 2 })
    expect(draft.files.find((f) => f.path === r.path)).toMatchObject({ status: 'added' })
    expect(draft.structure?.examples.added).toEqual(['should-send-back.yaml'])
    const text = draft.files.find((f) => f.path === r.path)!.hunks.flatMap((h) => h.lines.map((l) => l.text)).join('\n')
    expect(text).toContain('startAt: verify')
    expect(text).toContain('sent_back')

    const report = await api.call(manager, ch.DRAFTS_CHECK, { draftId: r.draftId, pastCases: 0 })
    expect(report.outcome).toBe('passed')
    expect(report.examples.find((e: { name: string }) => e.name === 'should-send-back')).toMatchObject({ status: 'pass' })

    expect(await api.call<any>(manager, ch.EXAMPLES_FROM_CASE, { caseId: 'case_nope' }))
      .toMatchObject({ applied: false, code: expect.stringMatching(/^example\./) })
  }, 300_000)

  it('memwise diff and memwise push work on a plain folder', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'mw-exit3-cli-')), 'proj')
    temps.push(join(root, '..'))
    expect((await runCli(['init', root, '--template', 'intake'])).code).toBe(0)
    const drafted = await runCli(['draft', root, 'client-intake', '--title', 'Look at similar cases'])
    expect(drafted.code, drafted.output).toBe(0)
    const folder = drafted.output.trim().split('\n').reverse().find((l) => l.startsWith('/'))!
    writeFileSync(join(folder, CHECK), requireRecall(readFileSync(join(folder, CHECK), 'utf8')))
    for (const name of CHECKED_EXAMPLES) {
      const p = join(folder, `workflows/client-intake/examples/${name}.yaml`)
      writeFileSync(p, exampleCallsRecall(readFileSync(p, 'utf8')))
    }

    const diff = await runCli(['diff', root, folder])
    expect(diff.code, diff.output).toBe(0)
    expect(diff.output).toContain('+  required: [gst.validate_gstin, recall.similar_cases]')
    expect(diff.output).toContain('Version 1 → 2.')

    // An app database the push records the version in.
    const pushDb = await createTestDatabase('mw_exit3_push')
    try {
      const admin = new URL(pushDb.url)
      admin.pathname = '/postgres'
      const pushed = await runCli(['push', root, folder, '--database-url', pushDb.url, '--test-database-url', admin.toString()])
      expect(pushed.code, pushed.output).toBe(0)
      expect(pushed.output).toContain('4 passed, 0 failed')
      expect(pushed.output).toContain('published client-intake version 2')
      expect(readFileSync(join(root, CHECK), 'utf8')).toContain('recall.similar_cases]')
      const { rows } = await pushDb.pool.query('select version, source from mw.workflow_versions where workflow_id = $1', ['client-intake'])
      expect(rows).toEqual([{ version: 2, source: 'cli' }])
    } finally {
      await pushDb.drop()
    }
  }, 300_000)
})
