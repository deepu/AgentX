/**
 * Literature on pages, the exit test (docs/memwise/26-projects-and-pages.md §6, §11 Stage 2), end
 * to end on fixtures.
 *
 * Against a real Postgres with scripted models, the `examples/literature` project (project and
 * domain `literature`) and the fake PubMed MCP server on a local port. The installed PubMed
 * plugin's server URL is pointed at the fake, so every `PubMed.*` call goes through the binding,
 * the gateway and the real HTTP MCP route.
 *
 * Before: Leah (medical affairs lead) keeps GLP-1, a page that sums up its sub-pages, with Weight
 * loss kept under it and Muscle loss a draft under it.
 *
 * 1. Leah asks "How often do people stop oral GLP-1s because of side effects?" from GLP-1. A draft
 *    page appears under GLP-1 with the question, and a chat anchored to it gets the question as
 *    its visible first message, with page_update to write the page (not `record_update`). The chat writes the
 *    page: its numbers are table cells, each linked to the sentence of the abstract it came from.
 * 2. Keep: the page refreshes every Monday with the Literature's own refresh; when it is due, the
 *    sweep starts "Refresh a page" for it.
 * 3. PubMed has added a paper (Example Trial D). The refresh searches PubMed since the page last
 *    refreshed, stores the paper in Papers and reads it once, the writer adds a section, and the
 *    compare step makes "Review an answer change" for Leah (not for the reviewer Omar). Accepting
 *    it updates the page and its history ("Example Trial D added, accepted by Leah").
 * 4. In the chat, "Add how long each trial ran" changes the trials table: a new version, the
 *    section marked as changed from chat, with Undo; Undo restores the previous version.
 * 5. GLP-1's summary refresh reads its kept sub-pages only: the draft Muscle loss is listed apart,
 *    left out of the summary and marked so in the sub-pages block.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import { loadProject, type ScriptedTurn } from '@memwise/defs'
import { scriptedProvider, type ModelProvider, type ModelRequest } from '@memwise/gateway'
import { handlePageGet, handlePageUpdate } from '@memwise/session-tools-core'
import type { MwInboxItem, MwPage, MwPageChange, MwPageWriteResult, MwProjectAskResult, MwSubmitResult } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers, shortQuestion } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { buildMemwisePageToolCallbacks } from '../chat-tools'
import { resetMemwiseHost } from '../host'
import { startMemwiseService, type MemwiseService } from '../service'
import { ATTAIN_2, EXAMPLE_TRIAL_D, startFakePubmed, type FakeArticle } from '../../../../runtime/tests/fixtures/fake-pubmed-http'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const PASSWORD = 'a long enough password'
const REAL_PUBMED = 'https://pubmed.mcp.claude.com/mcp'
const P = 'literature'
const REFRESH = 'refresh-literature-page'

const QUESTION = 'How often do people stop oral GLP-1s because of side effects?'
const SE_QUERY = '("oral semaglutide" OR orforglipron) AND ("adverse events" OR stopped)'
const ATTAIN_2_DOI = `https://doi.org/${ATTAIN_2.identifiers.doi}`
const TRIAL_D_DOI = `https://doi.org/${EXAMPLE_TRIAL_D.identifiers.doi}`

/** A table cell whose number links to the sentence it came from. */
const cell = (text: string, quote: string, cite: string, href: string) => ({ text, quote: { text: quote, cite, href } })
const table = (t: unknown) => ['```table', JSON.stringify(t), '```'].join('\n')

const HEADLINE = 'In ATTAIN-2, 89.5% of people completed the 72-week trial, so about 1 in 10 stopped early for any reason.'
const trialsTable = (weeks: boolean) => table({
  columns: [{ key: 'trial', label: 'Trial' }, { key: 'people', label: 'People' }, ...(weeks ? [{ key: 'weeks', label: 'Weeks', changed: true }] : []), { key: 'completed', label: 'Completed' }],
  rows: [{
    trial: { text: 'ATTAIN-2', href: ATTAIN_2_DOI },
    people: cell('1613', '1613 (757 [46·9%] female) were randomly assigned', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI),
    ...(weeks ? { weeks: cell('72', 'This 72-week, phase 3, double-blind, placebo-controlled trial', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI) } : {}),
    completed: cell('89.5%', '1444 (89·5%) completed the study', 'ATTAIN-2 · Horn DB et al. Lancet 2025', ATTAIN_2_DOI),
  }],
})
/** What the chat writes first (step 1). */
const BODY_V1 = [HEADLINE, '', '## The trials', '', trialsTable(false), '', '## What is unknown', '', 'How many stop because of side effects alone, in the long run.'].join('\n')
/** What the refresh writes once Example Trial D is out (step 3): a new section. */
const STOPPING = [
  '## Stopping because of side effects', '',
  table({
    columns: [{ key: 'trial', label: 'Trial' }, { key: 'drug', label: 'Stopped on the drug' }, { key: 'placebo', label: 'Stopped on placebo' }],
    rows: [{
      trial: { text: 'Example Trial D', href: TRIAL_D_DOI },
      drug: cell('7.2%', 'stopped because of adverse events by 7·2% of participants on oral semaglutide', 'Example Trial D', TRIAL_D_DOI),
      placebo: cell('2.9%', '2·9% on placebo', 'Example Trial D', TRIAL_D_DOI),
    }],
  }),
].join('\n')
const BODY_V2 = [HEADLINE, '', '## The trials', '', trialsTable(false), '', STOPPING, '', '## What is unknown', '', 'How many stop because of side effects alone, in the long run.'].join('\n')
/** "Add how long each trial ran" (step 4). */
const BODY_V3 = BODY_V2.replace(trialsTable(false), trialsTable(true))

/** A date as YYYY/MM/DD in the process's local calendar (PubMed's entry dates). */
function pubmedDay(at: Date): string {
  return `${at.getFullYear()}/${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')}`
}

/** The Article fields a searcher copies from PubMed's metadata. */
function articleValues(a: Omit<FakeArticle, 'entry_date'>): Record<string, unknown> {
  const { year, month, day } = a.publication_date
  return {
    pmid: a.identifiers.pmid, doi: a.identifiers.doi, title: a.title, journal: a.journal.iso_abbreviation,
    published: `${year}-${month}-${day}`, year: Number(year), article_types: [...a.article_types],
    authors: a.authors.map((x) => `${x.last_name} ${x.initials}`).join(', '), abstract: a.abstract,
  }
}

const stateOf = (r: ModelRequest) => /Workflow [\w-]+ v\d+, state ([\w-]+)\./.exec(r.systemPrompt)?.[1]
const caseRef = (r: ModelRequest, field: string) => new RegExp(`^- ${field} \\(.*\\): "([^"]+)"$`, 'm').exec(r.systemPrompt)?.[1]
const finish = (args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [{ name: 'step.finish', args }] })
const call = (name: string, args: Record<string, unknown>) => ({ name, args })
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content[0]!.text ?? ''
/** The JSON of a ```table block in a body, by the heading of its section. */
function tableIn(body: string, heading: string): { columns: { key: string }[]; rows: Record<string, { text: string; quote?: { text: string } }>[] } {
  const section = body.split(/^## /m).find((s) => s.startsWith(heading))!
  return JSON.parse(/```table\n([\s\S]*?)\n```/.exec(section)![1]!)
}

describe.skipIf(!postgresAvailable())('Literature on pages: ask, keep, refresh, review, change from chat, sum up', () => {
  let db: TestDatabase
  let dir: string
  let projectDir: string
  let svc: MemwiseService
  let fake: Awaited<ReturnType<typeof startFakePubmed>>
  const api = fakeServer()
  const sessions = fakeSessions()
  let leah: RequestContext
  let omar: RequestContext
  let leahId: string

  const ids: Record<string, string> = {}
  let askSessionId: string
  /** What GLP-1's summary refresh read (`page.get`), captured when its writer finishes. */
  let summaryRead: Record<string, unknown> | undefined

  const pool = () => svc.kernel.pool
  const pagesCore = () => svc.kernel.pages as unknown as { forRefresh(id: string): Promise<Record<string, unknown>>; sweep(now?: Date): Promise<{ pageId: string; runId: string }[]> }
  async function articleId(pmid: string): Promise<string | undefined> {
    const { rows } = await pool().query(`select id from domain.literature__article where pmid = $1`, [pmid])
    return rows[0]?.id
  }

  /** The scripted models: each step's script, chosen from what the step engine puts in the prompt. */
  async function scriptFor(role: string, request: ModelRequest): Promise<ScriptedTurn[]> {
    const state = stateOf(request)
    const page = caseRef(request, 'page')
    if (role === 'searcher' && state === 'search') {
      if (page === ids.glp1) {
        return [{ toolCalls: [call('page.get', { page })] }, finish({ outcome: 'nothing_new', writes: { found_count: 0, new_articles: [] }, rationale: 'GLP-1 sums up its sub-pages; nothing to search.' })]
      }
      if (page === ids.side) {
        const read = await pagesCore().forRefresh(page)
        const from = pubmedDay(new Date(String(read.last_refresh)))
        const stored = await articleId(EXAMPLE_TRIAL_D.identifiers.pmid)
        return [
          { toolCalls: [call('page.get', { page })] },
          { toolCalls: [call('PubMed.search_articles', { query: SE_QUERY, datetype: 'edat', date_from: from, max_results: 50 })] },
          { toolCalls: [call('PubMed.get_article_metadata', { pmids: [EXAMPLE_TRIAL_D.identifiers.pmid] })] },
          { toolCalls: [call('literature.article.create', articleValues(EXAMPLE_TRIAL_D))] },
          finish({
            outcome: 'found',
            writes: { query: SE_QUERY, searched_from: from, found_count: 1, new_articles: [stored ?? EXAMPLE_TRIAL_D.identifiers.pmid] },
            rationale: `One paper added to PubMed since the page last refreshed (${from}).`,
          }),
        ]
      }
      // Weight loss: nothing new since it was kept.
      return [{ toolCalls: [call('page.get', { page })] }, finish({ outcome: 'nothing_new', writes: { found_count: 0, new_articles: [] }, rationale: 'Nothing new.' })]
    }
    if (role === 'extractor' && state === 'extract') {
      const article = caseRef(request, 'article')!
      return [
        { toolCalls: [call('literature.article.get', { id: article })] },
        finish({
          outcome: 'extracted',
          writes: { study_type: 'randomised_trial', phase: 'phase_3', n: 640, sponsor: 'Example Pharma', intervention: 'Oral semaglutide 25 mg once daily', condition: 'Obesity' },
          quotes: {
            study_type: 'were randomly assigned to once-daily oral semaglutide 25 mg or placebo',
            phase: 'In this 52-week, phase 3, double-blind trial',
            n: '640 adults with obesity were randomly assigned',
            sponsor: 'Funded by Example Pharma.',
            intervention: 'once-daily oral semaglutide 25 mg',
            condition: '640 adults with obesity',
          },
          rationale: 'A randomised phase 3 trial of 640 adults.',
        }),
      ]
    }
    if (role === 'writer' && state === 'write') {
      if (page === ids.side) {
        const trialD = await articleId(EXAMPLE_TRIAL_D.identifiers.pmid)
        return [
          { toolCalls: [call('page.get', { page }), call('literature.article.get', { id: trialD })] },
          finish({
            outcome: 'written',
            writes: {
              body: BODY_V2, label: '1 new trial', change_title: 'Example Trial D added',
              plus: 'in Example Trial D, 7.2% stopped oral semaglutide because of adverse events, against 2.9% on placebo.',
            },
            rationale: 'Example Trial D is the first to report stopping because of adverse events.',
          }),
        ]
      }
      if (page === ids.glp1) {
        // The summary reads its kept sub-pages; the draft is named apart.
        summaryRead = await pagesCore().forRefresh(page)
        const kids = (summaryRead.children as { title: string; headline: string }[])
        return [
          { toolCalls: [call('page.get', { page })] },
          finish({
            outcome: 'written',
            writes: {
              body: [`Oral GLP-1s, by outcome: ${kids.map((k) => `${k.title}: ${k.headline}`).join(' ')}`, '', '```subpages', '{}', '```'].join('\n'),
              label: 'Summary updated', change_title: 'Summary of the kept sub-pages',
            },
            rationale: 'One sentence for each kept sub-page.',
          }),
        ]
      }
      return [{ toolCalls: [call('page.get', { page })] }, finish({ outcome: 'written', writes: { body: (await pagesCore().forRefresh(page!)).body }, rationale: 'Nothing new.' })]
    }
    if (role === 'verifier') {
      return [{ toolCalls: [call('checkpoint.verdict', { results: [{ rule: 1, passed: true, reason: 'Fine.' }] })] }]
    }
    return []
  }

  const provider: ModelProvider = {
    id: 'scripted',
    async complete(model, request, options) {
      return scriptedProvider({ [options.role]: await scriptFor(options.role, request) }).complete(model, request, options)
    },
  }

  const getPage = (who: RequestContext, pageId: string) => api.call<MwPage | null>(who, ch.PAGES_GET, { pageId })
  const toolCtx = (sessionId: string) => ({ sessionId, memwisePages: buildMemwisePageToolCallbacks({ sessionId }) }) as never
  const reviewsFor = async (who: RequestContext) =>
    (await api.call<MwInboxItem[]>(who, ch.INBOX_LIST)).filter((i) => (i.kind === 'decision' || i.kind === 'input') && !!(i as { pageChange?: unknown }).pageChange) as (MwInboxItem & { pageChange: { changeId: string; pageId: string; label?: string; from?: { kind: string; every?: string } } })[]
  const refreshCases = async (pageId: string) =>
    (await pool().query(`select r.id, r.status, r.state from mw.runs r join mw.cases c on c.id = r.case_id where r.workflow_id = $1 and c.values #>> '{page,value}' = $2`, [REFRESH, pageId])).rows

  beforeAll(async () => {
    fake = await startFakePubmed()
    db = await createTestDatabase('mw_exit_litpages', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit-litpages-'))
    projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'literature'), projectDir, { recursive: true })

    // The installed PubMed plugin, its server pointed at the fake; the binding pinned to the new hash.
    const pluginDir = join(projectDir, 'plugins', 'claude__pubmed', '1.0.0')
    for (const file of [join(pluginDir, 'memwise-plugin.yaml'), join(pluginDir, '.claude-plugin', 'plugin.json')]) {
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll(REAL_PUBMED, fake.url))
    }
    const { project } = await loadProject(projectDir)
    const hash = project.pluginVersions!['claude/pubmed']!['1.0.0']!.hash
    const bindingFile = join(projectDir, 'domain', 'bindings', 'claude__pubmed.yaml')
    writeFileSync(bindingFile, readFileSync(bindingFile, 'utf8').replace(/^plugin_hash: .*$/m, `plugin_hash: ${hash}`))

    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: async (input) => ({
        modelRoles: Object.fromEntries([...new Set([...input.roles, 'verifier'])].map((r) => [r, { provider: 'scripted', model: 'scripted' }])),
        providers: [provider],
        configured: true,
        message: 'Scripted answers for the literature pages exit test.',
      }),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@meridian.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const l = await svc.kernel.people.create({ name: 'Leah Park', email: 'leah@meridian.example', roles: ['lead'], password: PASSWORD })
    const o = await svc.kernel.people.create({ name: 'Omar Haddad', email: 'omar@meridian.example', roles: ['reviewer'], password: PASSWORD })
    leahId = l.id
    leah = ctxFor('leah-client', l.id)
    omar = ctxFor('omar-client', o.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await fake?.stop()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('the Literature project: a question box that makes pages, its own refresh, no Topic, Screening or Evidence', async () => {
    const { project, diagnostics } = await svc.kernel.project()
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const lit = project.domains![P]!
    expect(lit.home?.entity).toBeUndefined()
    expect(lit.pageRules).toEqual({ refresh: REFRESH, reviewer: 'lead', every: 'mon' })
    expect(Object.values(project.entities).filter((e) => e.domain === P).map((e) => e.entity).sort()).toEqual(['Article', 'Enquiry'])
    expect(Object.keys(project.workflows).filter((w) => project.workflows[w]!.domain === P).sort())
      .toEqual(['answer-enquiry', 'evidence-pack', 'monthly-digest', 'read-paper', REFRESH])
  })

  it('before: GLP-1 sums up its sub-pages; Weight loss is kept under it, Muscle loss is a draft', async () => {
    const made = async (input: Record<string, unknown>) => {
      const r = await api.call<MwPageWriteResult>(leah, ch.PAGES_CREATE, { projectId: P, ...input })
      expect(r.applied).toBe(true)
      return r.page!
    }
    const glp1 = await made({ title: 'GLP-1', body: 'Oral GLP-1s, by outcome.\n\n```subpages\n{}\n```', sumsChildren: true, status: 'kept' })
    ids.glp1 = glp1.id
    expect(glp1).toMatchObject({ status: 'kept', sumsChildren: true, refresh: { every: 'mon', playbook: REFRESH } })
    ids.weight = (await made({ title: 'Weight loss', parent: glp1.id, question: 'How much weight do people lose on oral GLP-1s?', body: 'Oral GLP-1s give 9 to 13 points more weight loss than placebo.', status: 'kept' })).id
    ids.muscle = (await made({ title: 'Muscle loss', parent: glp1.id, question: 'Do people lose muscle on oral GLP-1s?', body: 'Not known yet.' })).id
  })

  it('1. the question makes a draft page under GLP-1 and a chat that writes it, every number linked to its sentence', async () => {
    const asked = await api.call<MwProjectAskResult>(leah, ch.PROJECT_ASK, { projectId: P, question: QUESTION, parent: ids.glp1 })
    ids.side = asked.pageId
    askSessionId = asked.sessionId

    const draft = (await getPage(leah, ids.side))!
    expect(draft).toMatchObject({ status: 'draft', parent: ids.glp1, question: QUESTION, title: shortQuestion(QUESTION), chatId: askSessionId, breadcrumb: [{ id: ids.glp1, title: 'GLP-1' }] })

    // The chat: anchored to the page, the question its visible first message, the page tools in hand (no record_update).
    const context = sessions.contexts.get(askSessionId)!
    expect(context.anchor).toEqual({ kind: 'page', id: ids.side })
    expect(context.block).toContain(QUESTION)
    expect(context.block).toContain('page_update')
    expect(context.block).not.toContain('record_update')
    // (A page anchor is what gives the chat page_get, page_update and page_create: memwise-context.test.ts.)
    expect(sessions.sent.filter((m) => m.sessionId === askSessionId)).toEqual([expect.objectContaining({ message: QUESTION })])
    expect(sessions.sent.find((m) => m.sessionId === askSessionId)!.hidden).toBeFalsy()

    // The chat answers, and writes the page as it goes.
    const ctx = toolCtx(askSessionId)
    expect(textOf(await handlePageGet(ctx, {}))).toContain(QUESTION)
    const saved = await handlePageUpdate(ctx, { body: BODY_V1, reason: 'Answered the question' })
    expect(saved.isError).toBeFalsy()

    const page = (await getPage(leah, ids.side))!
    expect(page.status).toBe('draft')
    expect(page.headline).toBe(HEADLINE)
    // Each number in the trials table carries the sentence it came from, word for word in the paper's abstract.
    const t = tableIn(page.body, 'The trials')
    const numbers = t.rows.flatMap((r) => Object.values(r)).filter((c) => /^[\d.,%]+$/.test(c.text))
    expect(numbers.map((c) => c.text)).toEqual(['1613', '89.5%'])
    for (const c of numbers) expect(ATTAIN_2.abstract).toContain(c.quote!.text)

    // GLP-1 lists it, a draft, left out of its summary.
    const glp1 = (await getPage(leah, ids.glp1))!
    expect(glp1.children.find((k) => k.id === ids.side)).toMatchObject({ status: 'draft', inSummary: false })
    // Nothing refreshes a draft.
    expect(await refreshCases(ids.side)).toEqual([])
  }, 60_000)

  it('2. Keep: the page refreshes every Monday, and the sweep starts its refresh when it is due', async () => {
    const kept = await api.call<MwPageWriteResult>(leah, ch.PAGES_KEEP, { pageId: ids.side, every: 'mon' })
    expect(kept.applied).toBe(true)
    const page = (await getPage(leah, ids.side))!
    expect(page).toMatchObject({ status: 'kept', owner: leahId, refresh: { every: 'mon', playbook: REFRESH } })
    const next = new Date(page.refresh!.next!)
    expect(next.getDay()).toBe(1)
    expect(next.getTime()).toBeGreaterThan(Date.now())
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000)
    // Now in the kept sub-pages GLP-1 sums up.
    expect((await getPage(leah, ids.glp1))!.children.find((k) => k.id === ids.side)).toMatchObject({ status: 'kept', inSummary: true })

    // PubMed adds a paper today; then Monday comes.
    fake.add({ ...EXAMPLE_TRIAL_D, entry_date: pubmedDay(new Date()) })
    await pool().query(`update mw.pages set refresh = jsonb_set(refresh, '{next}', to_jsonb($2::text)) where id = $1`, [ids.side, new Date(Date.now() - 60_000).toISOString()])
    const swept = await pagesCore().sweep(new Date())
    expect(swept.map((s) => s.pageId)).toContain(ids.side)
    const after = (await getPage(leah, ids.side))!
    expect(new Date(after.refresh!.next!).getDay()).toBe(1)
    expect(new Date(after.refresh!.next!).getTime()).toBeGreaterThan(Date.now())
    expect(await refreshCases(ids.side)).toHaveLength(1)
  }, 60_000)

  it('3. the refresh finds the new trial, reads it once, and the answer change waits for Leah; accepting updates the page and its history', async () => {
    const items = await until('the answer change in Leah\'s waiting list', () => reviewsFor(leah), (xs) => xs.some((i) => i.pageChange.pageId === ids.side), 90_000)
    const item = items.find((i) => i.pageChange.pageId === ids.side)!
    expect(item.pageChange).toMatchObject({ pageTitle: shortQuestion(QUESTION), label: '1 new trial', from: { kind: 'schedule', every: 'mon' } })
    // Omar is a reviewer, not the page's owner or the lead: it isn't his to review.
    expect((await reviewsFor(omar)).some((i) => i.pageChange.pageId === ids.side)).toBe(false)

    // PubMed was searched by entry date from the day the page last refreshed; the paper is in Papers, read once.
    const search = fake.calls.find((c) => c.name === 'search_articles' && c.args.query === SE_QUERY)!
    expect(search.args).toMatchObject({ datetype: 'edat', date_from: pubmedDay(new Date()) })
    const { rows: papers } = await pool().query(`select lifecycle as status, n::int as n, phase from domain.literature__article where pmid = $1`, [EXAMPLE_TRIAL_D.identifiers.pmid])
    expect(papers).toEqual([{ status: 'read', n: 640, phase: 'phase_3' }])

    // "Review an answer change": the headline stays, plus the new section from the refresh.
    const change = await api.call<MwPageChange>(leah, ch.PAGE_CHANGES_GET, { changeId: item.pageChange.changeId })
    expect(change).toMatchObject({ status: 'pending', mayDecide: true, before: HEADLINE, plus: expect.stringContaining('7.2%'), title: 'Example Trial D added' })
    expect(change.sections.map((s) => [s.heading, s.origin, s.changed])).toEqual([['Stopping because of side effects', 'refresh', 'added']])
    expect((await getPage(leah, ids.side))!.body).toBe(BODY_V1)
    expect((await api.call<MwPageChange>(omar, ch.PAGE_CHANGES_GET, { changeId: change.id })).mayDecide).toBe(false)

    const decided = await api.call<MwSubmitResult>(leah, ch.PAGE_CHANGES_DECIDE, { changeId: change.id, decision: 'accept' })
    expect(decided.applied).toBe(true)
    const page = await until('the page updated', () => getPage(leah, ids.side), (p) => p!.body === BODY_V2 && p!.history[0]?.kind === 'accepted', 60_000)
    expect(page!.history[0]).toMatchObject({ kind: 'accepted', byName: 'Leah Park', text: 'Example Trial D added' })
    expect(page!.pendingChange).toBeUndefined()
    const runs = await until('the refresh ended', () => refreshCases(ids.side), (rs) => rs.every((r) => r.status !== 'active'), 60_000)
    expect(runs).toHaveLength(1)
    expect((await reviewsFor(leah)).some((i) => i.pageChange.pageId === ids.side)).toBe(false)
  }, 120_000)

  it('4. "Add how long each trial ran" changes the trials table from chat, with Undo; Undo restores the page', async () => {
    const before = (await getPage(leah, ids.side))!
    const saved = await handlePageUpdate(toolCtx(askSessionId), { body: BODY_V3, reason: 'Added how long each trial ran' })
    expect(saved.isError).toBeFalsy()
    const page = (await getPage(leah, ids.side))!
    expect(page.version).toBe(before.version + 1)
    expect(tableIn(page.body, 'The trials').columns.map((c) => c.key)).toEqual(['trial', 'people', 'weeks', 'completed'])
    expect(tableIn(page.body, 'The trials').rows[0]!.weeks!.quote!.text).toBe('This 72-week, phase 3, double-blind, placebo-controlled trial')
    expect(page.changedFromChat).toMatchObject({ sections: ['The trials'], chatId: askSessionId })
    expect(page.canUndo).toBe(true)
    expect(page.history[0]).toMatchObject({ kind: 'chat', text: 'Added how long each trial ran' })

    const undone = await api.call<MwPageWriteResult>(leah, ch.PAGES_UNDO, { pageId: ids.side, version: page.version })
    expect(undone.applied).toBe(true)
    const back = (await getPage(leah, ids.side))!
    expect(back.body).toBe(BODY_V2)
    expect(back.version).toBe(page.version + 1)
    expect(back.changedFromChat).toBeUndefined()
    expect(back.history[0]).toMatchObject({ kind: 'undo', byName: 'Leah Park' })
  }, 60_000)

  it('5. GLP-1\'s summary reads its kept sub-pages only: the draft is left out', async () => {
    // Accepting the side-effects change made GLP-1's summary due; refresh it now if no sweep has yet.
    const r = await api.call<{ started: boolean }>(leah, ch.PAGES_REFRESH, { pageId: ids.glp1 })
    expect(typeof r.started).toBe('boolean')
    const glp1 = await until('GLP-1\'s summary waiting for review', () => getPage(leah, ids.glp1), (p) => !!p?.pendingChange, 90_000)
    expect(summaryRead).toBeDefined()
    expect((summaryRead!.children as { title: string }[]).map((c) => c.title).sort()).toEqual([shortQuestion(QUESTION), 'Weight loss'].sort())
    expect(summaryRead!.drafts_left_out).toEqual(['Muscle loss'])

    const decided = await api.call<MwSubmitResult>(leah, ch.PAGE_CHANGES_DECIDE, { changeId: glp1!.pendingChange!.id, decision: 'accept' })
    expect(decided.applied).toBe(true)
    const after = await until('GLP-1 updated', () => getPage(leah, ids.glp1), (p) => p!.headline.startsWith('Oral GLP-1s, by outcome:'), 60_000)
    expect(after!.headline).toContain('Weight loss:')
    expect(after!.headline).toContain(HEADLINE)
    expect(after!.headline).not.toContain('Muscle loss')
    expect(after!.children.map((k) => [k.title, k.inSummary]).sort()).toEqual([['Muscle loss', false], ['Weight loss', true], [shortQuestion(QUESTION), true]].sort())
    // The live sub-pages block, as the page opens: the draft shows, marked out of the summary.
    const block = JSON.parse(/```subpages\n([\s\S]*?)\n```/.exec(after!.body)![1]!)
    expect(block.pages.find((p: { title: string }) => p.title === 'Muscle loss')).toMatchObject({ status: 'draft', inSummary: false })
    expect(block.changes.map((c: { title: string }) => c.title)).toContain(shortQuestion(QUESTION))
  }, 120_000)
})
