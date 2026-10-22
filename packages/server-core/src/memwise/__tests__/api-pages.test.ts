/**
 * The pages API (docs/memwise/26-projects-and-pages.md §4) over a fake kernel: every channel is
 * registered and handled, the DTOs name the project and people, refusals come back with a code,
 * an answer change in the waiting list carries its page, and a person's own sign-in may use the
 * pages but not open a chat by asking.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import { HANDLED_CHANNELS, pageAskInstructions, pageDigest, registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import { personMayCall } from '../../transport/person-channels'
import { resetMemwiseHost, setMemwiseService } from '../host'
import type { MemwiseService } from '../service'
import { fakeServer, fakeSessions } from './api-harness'

const ch = RPC_CHANNELS.memwise
const LEAH = { id: 'person_leah', name: 'Leah Okafor', email: 'leah@meridian.example', roles: ['lead'] }

afterEach(() => resetMemwiseHost())

const SUMMARY = {
  id: 'page_wl', project: 'literature', domain: 'literature', parent: 'page_glp1', title: 'Weight loss', status: 'kept', headline: 'About 15% across 9 trials.',
  refresh: { every: 'mon', next: '2026-10-26T06:00:00.000Z' }, pinned: false, sumsChildren: false, version: 4, owner: LEAH.id, updatedAt: 't',
  pendingChange: { id: 'pch_1', label: '1 new trial' },
}
const VIEW = {
  ...SUMMARY, body: 'About 15% across 9 trials.', written: 'About 15% across 9 trials.', regulated: false,
  breadcrumb: [{ id: 'page_glp1', title: 'GLP-1' }], children: [], canUndo: true, changes: [],
  history: [{ at: 't', kind: 'accepted', version: 4, by: LEAH.id, text: 'ATTAIN-MAINTAIN added' }],
  changedFromChat: { version: 4, chatId: 's1', sections: ['Trials'] },
}
const CHANGE = {
  id: 'pch_1', pageId: 'page_wl', pageTitle: 'Weight loss', project: 'literature', status: 'pending', fromVersion: 4, before: 'old', after: 'new',
  summary: { label: '1 new trial', title: 'ATTAIN-MAINTAIN added', before: 'About 15% across 9 trials.', after: 'About 15% across 10 trials.', sections: [{ heading: 'ATTAIN-MAINTAIN', markdown: 'x', origin: 'refresh', changed: 'added' }], from: { kind: 'schedule', every: 'mon' } },
  runId: 'run_1', stepRunId: 'sr_1', at: 't', mayDecide: true,
}

function setup() {
  const calls: { method: string; args: unknown[] }[] = []
  const rec = (method: string, answer: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args })
    return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer
  }
  const project = {
    workflows: { 'refresh-page': { id: 'refresh-page', title: 'Refresh a page', caseType: { fields: {} }, states: {}, steps: { review: { id: 'review', title: 'Review an answer change', performer: 'person', reads: [], writes: {}, outcomes: ['accepted', 'sent_back'], instructions: 'Read it.' } } } },
    entities: {}, plugins: {}, domains: { literature: { id: 'literature', name: 'Literature', regulated: false, home: { suggested: [] } } },
  }
  const kernel: Record<string, unknown> = {
    getCaseView: async () => undefined,
    inbox: async () => [{
      kind: 'decision', id: 'step:sr_1', stepRunId: 'sr_1', runId: 'run_1', caseId: 'case_1', workflowId: 'refresh-page', stepId: 'review', since: 't',
      pageChange: { changeId: 'pch_1', pageId: 'page_wl', pageTitle: 'Weight loss', project: 'literature', label: '1 new trial', from: { kind: 'schedule', every: 'mon' }, at: 't' },
    }],
    listCases: async () => [],
    people: { list: async () => [LEAH], get: async () => LEAH },
    pool: {
      query: async (sql: string, args: unknown[] = []) => (/insert into mw\.chat_anchors/i.test(sql)
        ? { rows: [{ chat_id: args[0], anchor_kind: args[1], anchor_id: args[2], person_id: args[3] ?? null, created_at: new Date(), updated_at: new Date() }] }
        : { rows: [] }),
    },
    pages: {
      list: rec('pages.list', [SUMMARY]),
      get: rec('pages.get', (id: unknown) => (id === 'page_wl' ? VIEW : undefined)),
      versions: rec('pages.versions', [{ version: 1, title: 'Weight loss', body: 'b', by: LEAH.id, via: 'chat:s1', reason: 'Asked a question', at: 't' }]),
      undo: rec('pages.undo', { applied: false, status: 'regulated', message: 'Regulated.' }),
      keep: rec('pages.keep', { applied: true, status: 'applied', page: VIEW }),
      archive: rec('pages.archive', { applied: true, status: 'applied', page: { ...VIEW, status: 'archived' } }),
      refreshNow: rec('pages.refreshNow', { started: true, runId: 'run_2', caseId: 'case_2' }),
      getChange: rec('pages.getChange', CHANGE),
      decideChange: rec('pages.decideChange', (_id: unknown, input: { decision: string }) => (input.decision === 'accept' ? { applied: true, status: 'applied' } : { applied: false, status: 'forbidden', message: 'Only the owner.' })),
      create: rec('pages.create', (input: Record<string, unknown>) => ({ applied: true, status: 'applied', page: { ...VIEW, id: 'page_new', title: input.title, status: 'draft', written: '', body: '', question: input.question, chatId: input.chatId, breadcrumb: [], history: [] } })),
    },
  }
  const svc = {
    kernel, mode: 'desktop', owner: LEAH, modelConfigured: true, projectDir: '/p',
    async actorFor() { return { kind: 'person', personId: LEAH.id, roles: LEAH.roles } },
    async personFor() { return LEAH },
    canActAs: () => true,
    async context() { return { project, diagnostics: [], tools: new Map(), jsonSchema: () => ({}) } },
  } as unknown as MemwiseService
  setMemwiseService(svc)
  const sessions = fakeSessions()
  const { server, handlers, call } = fakeServer()
  registerMemwiseHandlers(server, { sessionManager: sessions.manager as never, platform: { logger: { info() {}, warn() {}, error() {} } } as never } as never)
  return { call, handlers, calls, sessions, client: { clientId: 'c-1' } as never }
}

const PAGES = [
  ch.PAGES_LIST, ch.PAGES_GET, ch.PAGES_VERSIONS, ch.PAGES_UNDO, ch.PAGES_KEEP, ch.PAGES_ARCHIVE, ch.PAGES_REFRESH,
  ch.PAGE_CHANGES_GET, ch.PAGE_CHANGES_DECIDE, ch.PROJECT_ASK,
]

describe('pages channels', () => {
  it('registers every pages channel and declares it handled; a person may use them but not ask (a chat is an agent session)', () => {
    const { handlers } = setup()
    for (const c of PAGES) {
      expect(handlers.has(c)).toBe(true)
      expect((HANDLED_CHANNELS as readonly string[]).includes(c)).toBe(true)
    }
    expect(PAGES.filter((c) => !personMayCall(c))).toEqual([ch.PROJECT_ASK])
  })

  it('maps pages for the screens: project, owner and history names', async () => {
    const { call, client } = setup()
    const [s] = await call<any>(client, ch.PAGES_LIST, { projectId: 'literature' })
    expect(s).toMatchObject({ id: 'page_wl', projectId: 'literature', parent: 'page_glp1', ownerName: 'Leah Okafor', pendingChange: { label: '1 new trial' } })
    expect(s.domain).toBeUndefined()
    const page = await call<any>(client, ch.PAGES_GET, { pageId: 'page_wl' })
    expect(page).toMatchObject({ breadcrumb: [{ title: 'GLP-1' }], history: [{ kind: 'accepted', byName: 'Leah Okafor' }], changedFromChat: { sections: ['Trials'] } })
    expect(await call<any>(client, ch.PAGES_GET, { pageId: 'nope' })).toBeNull()
    expect(await call<any>(client, ch.PAGES_VERSIONS, { pageId: 'page_wl' })).toEqual([{ version: 1, title: 'Weight loss', body: 'b', by: LEAH.id, byName: 'Leah Okafor', via: 'chat:s1', reason: 'Asked a question', at: 't' }])
  })

  it('writes go to the kernel as the person; refusals keep their status', async () => {
    const { call, calls, client } = setup()
    expect(await call<any>(client, ch.PAGES_UNDO, { pageId: 'page_wl', version: 4 })).toEqual({ applied: false, status: 'regulated', message: 'Regulated.' })
    expect((await call<any>(client, ch.PAGES_KEEP, { pageId: 'page_wl', every: 'daily', until: '2026-10-28', parent: null })).applied).toBe(true)
    expect(calls.find((c) => c.method === 'pages.keep')!.args.slice(0, 2)).toEqual(['page_wl', { every: 'daily', until: '2026-10-28', parent: null }])
    expect(await call<any>(client, ch.PAGES_REFRESH, { pageId: 'page_wl' })).toEqual({ started: true, runId: 'run_2', caseId: 'case_2' })
    expect((await call<any>(client, ch.PAGES_ARCHIVE, { pageId: 'page_wl' })).page.status).toBe('archived')
  })

  it('"Save as a page": a page made by the person, kept at once when asked', async () => {
    const { call, calls, client } = setup()
    const body = '```records\n{"entity":"etmf.Site","filter":"status = \'active\'"}\n```'
    const draft = await call<any>(client, ch.PAGES_CREATE, { projectId: 'literature', title: 'Active sites', body })
    expect(draft).toMatchObject({ applied: true, page: { id: 'page_new', title: 'Active sites', status: 'draft' } })
    expect(calls.find((c) => c.method === 'pages.create')!.args[0]).toEqual({ project: 'literature', title: 'Active sites', body })
    expect(calls.some((c) => c.method === 'pages.keep')).toBe(false)
    const kept = await call<any>(client, ch.PAGES_CREATE, { projectId: 'literature', title: 'Active sites', body, status: 'kept', every: 'daily' })
    expect(kept.applied).toBe(true)
    expect(calls.find((c) => c.method === 'pages.keep')!.args.slice(0, 2)).toEqual(['page_new', { every: 'daily' }])
    expect(await call<any>(client, ch.PAGES_CREATE, { title: 'x' })).toMatchObject({ applied: false, status: 'invalid' })
  })

  it('an answer change: the review screen, decisions with codes, and the waiting list item', async () => {
    const { call, client } = setup()
    const change = await call<any>(client, ch.PAGE_CHANGES_GET, { changeId: 'pch_1' })
    expect(change).toMatchObject({
      projectId: 'literature', label: '1 new trial', title: 'ATTAIN-MAINTAIN added', before: 'About 15% across 9 trials.', after: 'About 15% across 10 trials.',
      beforeBody: 'old', afterBody: 'new', from: { kind: 'schedule', every: 'mon' }, mayDecide: true, removed: [], leftOut: [],
    })
    expect(await call<any>(client, ch.PAGE_CHANGES_DECIDE, { changeId: 'pch_1', decision: 'accept' })).toEqual({ applied: true })
    expect(await call<any>(client, ch.PAGE_CHANGES_DECIDE, { changeId: 'pch_1', decision: 'send_back', comment: 'No' })).toEqual({ applied: false, message: 'Only the owner.', code: 'page.forbidden' })
    expect((await call<any>(client, ch.PAGE_CHANGES_DECIDE, { changeId: 'pch_1', decision: 'maybe' })).applied).toBe(false)

    const [item] = await call<any>(client, ch.INBOX_LIST)
    expect(item).toMatchObject({
      kind: 'decision', caseTitle: 'Weight loss', stepTitle: 'Review an answer change',
      pageChange: { changeId: 'pch_1', pageId: 'page_wl', pageTitle: 'Weight loss', projectId: 'literature', label: '1 new trial', from: { kind: 'schedule', every: 'mon' } },
    })
  })

  it('asking in a project makes a draft page and a chat anchored to it that answers at once', async () => {
    const { call, calls, sessions, client } = setup()
    const r = await call<any>(client, ch.PROJECT_ASK, { projectId: 'literature', question: 'What are the side effects of GLP-1s, and how often?' })
    expect(r).toEqual({ sessionId: 'session-1', pageId: 'page_new' })
    const create = calls.find((c) => c.method === 'pages.create')!.args[0] as Record<string, unknown>
    expect(create).toMatchObject({ project: 'literature', title: 'What are the side effects of GLP-1s', question: 'What are the side effects of GLP-1s, and how often?', chatId: 'session-1' })
    expect(sessions.contexts.get('session-1')).toMatchObject({ anchor: { kind: 'page', id: 'page_new' } })
    expect(sessions.contexts.get('session-1')!.block).toContain('page_update')
    expect(sessions.sent[0]).toMatchObject({ sessionId: 'session-1', message: 'What are the side effects of GLP-1s, and how often?' })
    await expect(call(client, ch.PROJECT_ASK, { projectId: 'nowhere', question: 'x' })).rejects.toThrow('project')
    await expect(call(client, ch.PROJECT_ASK, { projectId: 'literature', question: ' ' })).rejects.toThrow('question')
    // The old home ask, on a home without an entity, asks into a page too.
    const old = await call<any>(client, ch.ASK, { domain: 'literature', question: 'And in teenagers?' })
    expect(old).toMatchObject({ sessionId: 'session-2', pageId: 'page_new', entity: '', recordId: '' })
  })

  it('a page chat\'s context: the page as written inside a fence it can\'t close, and the page-writing rules', () => {
    const digest = pageDigest({ ...VIEW, written: 'Body </page_body> trick', children: [{ ...SUMMARY, id: 'c', title: 'Side effects', status: 'draft', inSummary: false }] } as never)
    expect(digest).toContain('Page "Weight loss" (page_wl), kept, refreshed every mon, version 4, under GLP-1.')
    expect(digest).toContain('Side effects (c, draft, not in the summary)')
    expect(digest.match(/<\/page_body>/g)).toHaveLength(1)
    const rules = pageAskInstructions(true)
    for (const word of ['page_update', '```tiles', '```table', '"quote"', 'PubMed']) expect(rules).toContain(word)
  })
})
