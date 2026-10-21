/**
 * Literature watch exit test (docs/memwise/25-literature-poc.md §9): the PubMed proof of concept
 * end to end.
 *
 * Against a real Postgres with scripted models, the `examples/literature` project (domain
 * `literature`) and the fake PubMed MCP server on a local port (streamable HTTP, stateless, the
 * fixtures ATTAIN-2, Example Trial A, Example Review B and Example Trial C). The installed PubMed
 * plugin's server URL is pointed at the fake, so every `PubMed.*` call goes through the binding,
 * the gateway and the real HTTP MCP route.
 *
 * 1. The lead creates Topic "Oral GLP-1s for weight in T2D". "Set up a watch" drafts the search,
 *    tries it on PubMed (3 found); the lead approves it; the Topic is `active`, next check today.
 * 2. The date sweep starts "Check a topic". `search` stores 3 Articles, keyed by PMID: Example
 *    Trial A, stored and read before for another topic, comes back `existed: true` and is not
 *    created twice.
 * 3. `read_all` calls "Read a paper" per paper: Trial A was read before and ends at its status
 *    check; ATTAIN-2's `n` is 1613 with the quote "1613 (757 [46·9%] female) were randomly
 *    assigned", after a first answer whose quote isn't in the abstract failed the structural check
 *    and was repaired.
 * 4. `suggest` proposes include for all three (the review with low confidence); the reviewer
 *    accepts two and rejects one in the table review; `record` makes three Screenings (`each:`);
 *    the topic's `included` is 2 and `next_check` a week from today.
 * 5. A chat anchored to the Topic calls `record_query` and `record_get`, then `record_keep` with
 *    three ATTAIN-2 findings (the permission prompt answered yes): three Evidence records `kept`,
 *    quotes found. A fourth with a made-up quote is kept but flagged "Quote not found in the source".
 * 6. The reviewer rejects the made-up one; the Topic page's interval chart has three rows and the
 *    dashboard's bar chart counts the included papers by year.
 * 7. A week later the sweep starts "Check a topic" again: PubMed has nothing new since the last
 *    check, so nothing is stored, read or screened twice; the check is noted (`mark_checked`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@memwise/db'
import { loadProject, type ScriptedTurn } from '@memwise/defs'
import { scriptedProvider, type ModelProvider, type ModelRequest } from '@memwise/gateway'
import { handleRecordGet, handleRecordKeep, handleRecordQuery } from '@memwise/session-tools-core'
import type { MwCase, MwDashboard, MwDomain, MwInboxItem, MwRecordPage, MwStepRecord } from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { buildMemwiseRecordToolCallbacks } from '../chat-tools'
import { resetMemwiseHost } from '../host'
import { startMemwiseService, type MemwiseService } from '../service'
import {
  ATTAIN_2, EXAMPLE_REVIEW_B, EXAMPLE_TRIAL_A, GLP1_QUERY, startFakePubmed, type FakeArticle,
} from '../../../../runtime/tests/fixtures/fake-pubmed-http'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const ch = RPC_CHANNELS.memwise
const PASSWORD = 'a long enough password'
const REAL_PUBMED = 'https://pubmed.mcp.claude.com/mcp'
const DAY_MS = 86_400_000

const TOPIC = 'literature.Topic'
const ARTICLE = 'literature.Article'
const SCREENING = 'literature.Screening'
const EVIDENCE = 'literature.Evidence'

const INCLUSION = 'Include randomised trials in adults with type 2 diabetes and overweight or obesity that compare an oral GLP-1 receptor agonist with placebo or another treatment and report the change in bodyweight. Exclude reviews, animal and laboratory studies, injectable GLP-1s, and trials without a weight outcome.'
/** The quote the extractor's first answer gives for `n`: the screened count, in words that aren't in the abstract. */
const BAD_N_QUOTE = '2859 participants were randomised'
const N_QUOTE = '1613 (757 [46·9%] female) were randomly assigned'
const MADE_UP_QUOTE = 'HbA1c fell by 1·8 percentage points with 36 mg orforglipron'

/** A date as the kernel's `{ today: n }` writes it (the process's local calendar). */
function localDate(at: Date, days = 0): string {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The Article fields a searcher copies from PubMed's metadata. */
function articleValues(a: FakeArticle): Record<string, unknown> {
  const { year, month, day } = a.publication_date
  return {
    pmid: a.identifiers.pmid,
    doi: a.identifiers.doi,
    ...(a.identifiers.pmc ? { pmc_id: a.identifiers.pmc } : {}),
    title: a.title,
    journal: a.journal.iso_abbreviation,
    published: `${year}-${month}-${day}`,
    year: Number(year),
    article_types: [...a.article_types],
    authors: a.authors.map((x) => `${x.last_name} ${x.initials}`).join(', '),
    abstract: a.abstract,
  }
}

/** The step's state and a case reference, as the step engine writes them into the system prompt. */
const stateOf = (r: ModelRequest) => /Workflow [\w-]+ v\d+, state ([\w-]+)\./.exec(r.systemPrompt)?.[1]
const caseRef = (r: ModelRequest, field: string) => new RegExp(`^- ${field} \\(.*\\): "([^"]+)"$`, 'm').exec(r.systemPrompt)?.[1]

const finish = (args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [{ name: 'step.finish', args }] })
const call = (name: string, args: Record<string, unknown>) => ({ name, args })

describe.skipIf(!postgresAvailable())('Literature exit: a PubMed watch, end to end', () => {
  let db: TestDatabase
  let dir: string
  let projectDir: string
  let svc: MemwiseService
  let fake: Awaited<ReturnType<typeof startFakePubmed>>
  const api = fakeServer()
  const sessions = fakeSessions()
  let lead: RequestContext
  let reviewer: RequestContext
  let leadId: string

  // Records made along the story.
  const ids: Record<string, string> = {}
  let setupCaseId: string
  let checkCaseId: string
  /** Every model role call, in order, so the test can say who was asked. */
  const modelCalls: { role: string; state?: string; turn: number }[] = []

  const pool = () => svc.kernel.pool
  async function articleIds(): Promise<Record<string, string>> {
    const { rows } = await pool().query(`select id, pmid from domain.literature__article`)
    return Object.fromEntries(rows.map((r) => [r.pmid as string, r.id as string]))
  }
  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    (await pool().query(`select count(*)::int as n from domain.${table} where ${where}`, params)).rows[0].n as number

  /**
   * The scripted models. Each role's script is chosen per step run from what the step engine puts
   * in the prompt (the step and the case's references), and names the records this run made.
   */
  async function scriptFor(role: string, request: ModelRequest): Promise<ScriptedTurn[]> {
    const state = stateOf(request)
    if (role === 'searcher' && state === 'draft_query') {
      const topic = caseRef(request, 'topic')!
      const pmids = [EXAMPLE_REVIEW_B, ATTAIN_2, EXAMPLE_TRIAL_A].map((a) => a.identifiers.pmid)
      return [
        { toolCalls: [call('literature.topic.get', { id: topic })] },
        { toolCalls: [call('PubMed.search_articles', { query: GLP1_QUERY, max_results: 20 })] },
        { toolCalls: [call('PubMed.get_article_metadata', { pmids })] },
        finish({
          outcome: 'drafted',
          writes: {
            query: GLP1_QUERY,
            inclusion: INCLUSION,
            found_count: 3,
            sample: [EXAMPLE_REVIEW_B, ATTAIN_2, EXAMPLE_TRIAL_A].map((a) => ({ pmid: a.identifiers.pmid, title: a.title, year: Number(a.publication_date.year) })),
          },
          rationale: 'The two oral GLP-1 receptor agonists by name and the class, with type 2 diabetes and obesity or weight; three papers today, ATTAIN-2 among them.',
        }),
      ]
    }
    if (role === 'searcher' && state === 'search') {
      const topic = caseRef(request, 'topic')!
      const { rows } = await pool().query(`select last_checked from domain.literature__topic where id = $1`, [topic])
      const last = rows[0]?.last_checked as Date | null | undefined
      if (last) {
        // A later week: search by entry date from the last check; PubMed has added nothing since.
        const from = localDate(new Date(last)).replaceAll('-', '/')
        return [
          { toolCalls: [call('literature.topic.get', { id: topic })] },
          { toolCalls: [call('PubMed.search_articles', { query: GLP1_QUERY, datetype: 'edat', date_from: from, max_results: 50 })] },
          finish({
            outcome: 'nothing_new',
            writes: { query: GLP1_QUERY, searched_from: from, found_count: 0, new_articles: [] },
            rationale: `PubMed has added no paper for this search since the last check on ${from}.`,
          }),
        ]
      }
      // The first check: no date limit; store each paper (keyed by PMID), then see what this topic has screened.
      const found = [EXAMPLE_REVIEW_B, ATTAIN_2, EXAMPLE_TRIAL_A]
      const stored = await articleIds()
      return [
        { toolCalls: [call('literature.topic.get', { id: topic })] },
        { toolCalls: [call('PubMed.search_articles', { query: GLP1_QUERY, datetype: 'edat', max_results: 50 })] },
        { toolCalls: [call('PubMed.get_article_metadata', { pmids: found.map((a) => a.identifiers.pmid) })] },
        {
          toolCalls: [
            ...found.map((a) => call('literature.article.create', articleValues(a))),
            call('literature.screening.list', { filter: `topic = '${topic}'` }),
          ],
        },
        finish({
          outcome: 'found',
          writes: { query: GLP1_QUERY, searched_from: '', found_count: 3, new_articles: found.map((a) => stored[a.identifiers.pmid] ?? a.identifiers.pmid) },
          rationale: 'The first check, so no date limit. Three papers; one was already stored for another topic, and none is screened for this topic yet.',
        }),
      ]
    }
    if (role === 'extractor' && state === 'extract') {
      const article = caseRef(request, 'article')!
      const { rows } = await pool().query(`select pmid from domain.literature__article where id = $1`, [article])
      const pmid = rows[0]?.pmid
      const get: ScriptedTurn = { toolCalls: [call('literature.article.get', { id: article })] }
      if (pmid === ATTAIN_2.identifiers.pmid) {
        return [
          get,
          // First answer: the 2859 screened, with words that aren't in the abstract: sent back.
          finish({
            outcome: 'extracted',
            writes: { study_type: 'randomised_trial', phase: 'phase_3', n: 2859, sponsor: 'Eli Lilly and Company' },
            quotes: { study_type: 'were randomly assigned (1:1:1:2)', phase: 'This 72-week, phase 3, double-blind, placebo-controlled trial', n: BAD_N_QUOTE, sponsor: 'Eli Lilly and Company.' },
            rationale: 'A randomised phase 3 trial of 2859 participants.',
          }),
          finish({
            outcome: 'extracted',
            writes: {
              study_type: 'randomised_trial', phase: 'phase_3', n: 1613, sponsor: 'Eli Lilly and Company',
              intervention: 'Orforglipron 6 mg, 12 mg or 36 mg once daily, by mouth', condition: 'Obesity in adults with type 2 diabetes',
            },
            quotes: {
              study_type: 'were randomly assigned (1:1:1:2) to once-daily orforglipron 6 mg, 12 mg, 36 mg, or placebo',
              phase: 'This 72-week, phase 3, double-blind, placebo-controlled trial',
              n: N_QUOTE,
              sponsor: 'Eli Lilly and Company.',
              intervention: 'once-daily orforglipron 6 mg, 12 mg, 36 mg, or placebo',
              condition: 'for obesity treatment in adults with type 2 diabetes',
            },
            rationale: '2859 were screened; 1613 were randomly assigned, as the abstract says.',
          }),
        ]
      }
      if (pmid === EXAMPLE_REVIEW_B.identifiers.pmid) {
        return [
          get,
          finish({
            outcome: 'extracted',
            writes: { study_type: 'review', phase: 'not_a_trial', intervention: 'Oral semaglutide and orforglipron', condition: 'Obesity and type 2 diabetes' },
            quotes: {
              study_type: 'We review the published trials',
              phase: 'No new data are reported.',
              intervention: 'trials of oral semaglutide and orforglipron',
              condition: 'people with obesity and type 2 diabetes',
            },
            rationale: 'A narrative review of published trials; it reports no new data.',
          }),
        ]
      }
      return [] // Example Trial A was read before: no model is asked (an exhausted script would fail the step)
    }
    if (role === 'screener' && state === 'suggest') {
      const topic = caseRef(request, 'topic')!
      const a = await articleIds()
      const row = (f: FakeArticle, phase: string, decision: string, reason: string, confidence: number) => ({
        article: a[f.identifiers.pmid], title: f.title, year: Number(f.publication_date.year), phase, decision, reason, confidence,
      })
      return [
        { toolCalls: [call('literature.topic.get', { id: topic }), ...[EXAMPLE_REVIEW_B, ATTAIN_2, EXAMPLE_TRIAL_A].map((f) => call('literature.article.get', { id: a[f.identifiers.pmid] }))] },
        finish({
          outcome: 'suggested',
          writes: {
            screening: [
              row(EXAMPLE_REVIEW_B, 'not_a_trial', 'include', 'A review of the oral GLP-1 trials in this population; the abstract may not say enough to decide, so the reviewer decides.', 0.35),
              row(ATTAIN_2, 'phase_3', 'include', 'A randomised phase 3 trial of oral orforglipron against placebo in adults with type 2 diabetes and obesity, reporting bodyweight.', 0.98),
              row(EXAMPLE_TRIAL_A, 'phase_3', 'include', 'A randomised phase 3 trial of oral semaglutide against placebo in adults with type 2 diabetes, reporting bodyweight.', 0.95),
            ],
          },
          rationale: 'Two randomised trials meet every rule; the review is included with low confidence for the reviewer to decide.',
        }),
      ]
    }
    if (role === 'verifier') {
      return [{ toolCalls: [call('checkpoint.verdict', { results: [
        { rule: 1, passed: true, reason: 'Three new papers and three rows.' },
        { rule: 2, passed: true, reason: 'No paper is excluded.' },
      ] })] }]
    }
    return []
  }

  const provider: ModelProvider = {
    id: 'scripted',
    async complete(model, request, options) {
      const turn = request.messages.filter((m) => m.role === 'assistant').length
      modelCalls.push({ role: options.role, ...(stateOf(request) ? { state: stateOf(request) } : {}), turn })
      return scriptedProvider({ [options.role]: await scriptFor(options.role, request) }).complete(model, request, options)
    },
  }

  async function itemFor<K extends MwInboxItem['kind']>(who: RequestContext, kind: K, match: (i: Extract<MwInboxItem, { kind: K }>) => boolean) {
    type Item = Extract<MwInboxItem, { kind: K }>
    const mine = (i: MwInboxItem): i is Item => i.kind === kind && match(i as Item)
    const items = await until(`a ${kind} item`, () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST), (xs) => xs.some(mine), 60_000)
    return items.find(mine)!
  }
  const page = (who: RequestContext, entity: string, id: string) => api.call<MwRecordPage>(who, ch.RECORDS_PAGE, { entity, id })
  const valueOf = (p: MwRecordPage, field: string) => p.fields.find((f) => f.name === field)?.value
  const caseOf = (caseId: string) => api.call<MwCase>(lead, ch.CASES_GET, caseId)
  const ended = (caseId: string, what: string, timeoutMs = 90_000) => until(what, () => caseOf(caseId), (c) => c.status !== 'active', timeoutMs)

  beforeAll(async () => {
    fake = await startFakePubmed()
    db = await createTestDatabase('mw_exit_lit', { migrate: false })
    dir = mkdtempSync(join(tmpdir(), 'mw-exit-lit-'))
    projectDir = join(dir, 'project')
    cpSync(join(REPO, 'examples', 'literature'), projectDir, { recursive: true })

    // The installed PubMed plugin, its server pointed at the fake; the binding pinned to the new hash.
    const pluginDir = join(projectDir, 'plugins', 'claude__pubmed', '1.0.0')
    for (const file of [join(pluginDir, 'memwise-plugin.yaml'), join(pluginDir, '.claude-plugin', 'plugin.json')]) {
      const text = readFileSync(file, 'utf8')
      expect(text).toContain(REAL_PUBMED)
      writeFileSync(file, text.replaceAll(REAL_PUBMED, fake.url))
    }
    const { project } = await loadProject(projectDir)
    const hash = project.pluginVersions!['claude/pubmed']!['1.0.0']!.hash
    const bindingFile = join(projectDir, 'domain', 'bindings', 'claude__pubmed.yaml')
    writeFileSync(bindingFile, readFileSync(bindingFile, 'utf8').replace(/^plugin_hash: .*$/m, `plugin_hash: ${hash}`))
    expect(project.pluginVersions!['claude/pubmed']!['1.0.0']!.manifest.mcpServers).toEqual({ PubMed: { url: fake.url } })

    svc = (await startMemwiseService({
      configDir: dir,
      projectDir,
      databaseUrl: db.url,
      mode: 'server',
      modelResolver: async (input) => ({
        modelRoles: Object.fromEntries([...new Set([...input.roles, 'verifier'])].map((r) => [r, { provider: 'scripted', model: 'scripted' }])),
        providers: [provider],
        configured: true,
        message: 'Scripted answers for the literature exit test.',
      }),
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@meridian.example' },
    }))!
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const lena = await svc.kernel.people.create({ name: 'Dr. Lena Ortiz', email: 'lena@meridian.example', roles: ['lead'], password: PASSWORD })
    const sam = await svc.kernel.people.create({ name: 'Sam Okafor', email: 'sam@meridian.example', roles: ['reviewer'], password: PASSWORD })
    leadId = lena.id
    lead = ctxFor('lead-client', lena.id)
    reviewer = ctxFor('reviewer-client', sam.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await fake?.stop()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  it('has the Literature domain, and PubMed bound through its HTTP server', async () => {
    const domains = await api.call<MwDomain[]>(lead, ch.DOMAINS_LIST)
    expect(domains.find((d) => d.id === 'literature')).toMatchObject({ name: 'Literature' })
    const { project, diagnostics } = await svc.kernel.project()
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(project.bindings?.['claude/pubmed']?.tools['PubMed.search_articles']).toEqual({ effect: 'read' })
    expect(project.pluginVersions?.['claude/pubmed']?.['1.0.0']?.manifest.mcpServers).toEqual({ PubMed: { url: fake.url } })
  })

  it('before: Example Trial A was stored and read last week, for another topic', async () => {
    // Stored by the check of "Semaglutide tablets, all indications"; only a step may mark a paper read from now on.
    const r = await svc.kernel.records.create({
      entity: ARTICLE, status: 'read', reason: 'stored and read by the check of another topic',
      values: { ...articleValues(EXAMPLE_TRIAL_A), study_type: 'randomised_trial', phase: 'phase_3', n: 412, sponsor: 'Example Pharma', intervention: 'Oral semaglutide 50 mg once daily', condition: 'Type 2 diabetes with overweight or obesity' },
    }, { kind: 'system' })
    expect(r.status).toBe('applied')
    ids.trialA = r.id!
  })

  it('1. the lead creates a topic; "Set up a watch" drafts and tries the search; the lead approves it; the topic is active, due today', async () => {
    const created = await api.call(lead, ch.RECORDS_CREATE, {
      entity: TOPIC, reason: 'a new question from the medical team',
      values: { name: 'Oral GLP-1s for weight in T2D', question: 'How much weight do adults with type 2 diabetes lose on oral GLP-1 receptor agonists, compared with placebo?' },
    })
    expect(created).toMatchObject({ applied: true })
    ids.topic = created.id
    expect((await page(lead, TOPIC, ids.topic)).status).toBe('draft')

    const cases = await until('the set-up case', () => api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'set-up-watch' }), (xs) => xs.length > 0, 30_000)
    expect(cases).toHaveLength(1)
    setupCaseId = cases[0].caseId

    const item = await itemFor(lead, 'input', (i) => i.caseId === setupCaseId)
    expect(item.stepTitle).toBe('Approve the search')
    expect(item.prefill.query?.value).toBe(GLP1_QUERY)
    const view = await caseOf(setupCaseId)
    expect(view.values.found_count?.value).toBe(3)
    expect((view.values.sample?.value as { pmid: string }[]).map((s) => s.pmid)).toEqual(['99000002', '41275875', '99000001'])
    // Tried on PubMed itself, through the HTTP route.
    expect(fake.calls.map((c) => c.name)).toEqual(['search_articles', 'get_article_metadata'])
    expect(fake.calls[0]!.args).toEqual({ query: GLP1_QUERY, max_results: 20 })

    const approved = await api.call(lead, ch.INBOX_SUBMIT, {
      stepRunId: item.stepRunId, outcome: 'approved', values: { query: item.prefill.query?.value, inclusion: item.prefill.inclusion?.value },
    })
    expect(approved).toMatchObject({ applied: true })
    expect((await ended(setupCaseId, 'the watch set up')).state).toBe('end')

    const topic = await page(lead, TOPIC, ids.topic)
    expect(topic.status).toBe('active')
    expect(valueOf(topic, 'query')).toBe(GLP1_QUERY)
    expect(valueOf(topic, 'inclusion')).toBe(INCLUSION)
    expect(String(valueOf(topic, 'next_check')).slice(0, 10)).toBe(localDate(new Date()))
  }, 120_000)

  it('2. the date sweep starts "Check a topic"; search stores three papers, one of them already stored', async () => {
    // The minute sweep may already have fired it; firing again starts nothing new.
    await svc.kernel.triggers.sweep()
    const checks = await until('the check case', () => api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'check-topic' }), (xs) => xs.length > 0, 30_000)
    expect(checks).toHaveLength(1)
    checkCaseId = checks[0].caseId
    await svc.kernel.triggers.sweep()
    expect(await api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'check-topic' })).toHaveLength(1)

    const view = await until('searched', () => caseOf(checkCaseId), (c) => !!c.values.new_articles || c.status !== 'active', 60_000)
    const a = await articleIds()
    expect(Object.keys(a).sort()).toEqual(['41275875', '99000001', '99000002'])
    ids.attain = a['41275875']!
    ids.reviewB = a['99000002']!
    expect(a['99000001']).toBe(ids.trialA)
    expect(view.values.found_count?.value).toBe(3)
    expect(view.values.new_articles?.value).toEqual([ids.reviewB, ids.attain, ids.trialA])
    // The same PMID twice is one record: the stored paper came back as it was.
    expect(await count('literature__article', `pmid = '99000001'`)).toBe(1)
    const search = view.timeline.find((s) => s.stepId === 'search')!
    const record = await api.call<MwStepRecord>(lead, ch.STEPS_GET, search.stepRunId)
    const creates = record.journal.filter((j) => j.kind === 'tool' && j.name === 'literature.article.create' && j.response)
    expect(creates.map((j) => (j.response as { result: unknown }).result)).toEqual([
      { id: ids.reviewB, existed: false }, { id: ids.attain, existed: false }, { id: ids.trialA, existed: true },
    ])
    const trialA = await page(lead, ARTICLE, ids.trialA)
    expect(trialA.history).toHaveLength(1)
    // PubMed answered over HTTP, by entry date, with the whole metadata.
    expect(fake.calls.slice(2).map((c) => c.name)).toEqual(['search_articles', 'get_article_metadata'])
    expect(fake.calls[2]!.args).toEqual({ query: GLP1_QUERY, datetype: 'edat', max_results: 50 })
    expect(valueOf(await page(lead, ARTICLE, ids.attain), 'abstract')).toBe(ATTAIN_2.abstract)
  }, 120_000)

  it('3. each paper is read once; ATTAIN-2 has n 1613 with its words, after a made-up quote was sent back', async () => {
    const reads = await until('three readings', () => api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'read-paper' }),
      (xs) => xs.length === 3 && xs.every((c) => c.status !== 'active'), 90_000)
    const byArticle = new Map<string, MwCase>()
    for (const c of reads) {
      const v = await caseOf(c.caseId)
      byArticle.set(v.values.article!.value as string, v)
    }
    // Trial A was read before: its case ended at the status check, and no model was asked about it.
    const trialA = byArticle.get(ids.trialA)!
    expect(trialA.timeline.map((s) => [s.stepId, s.outcome])).toEqual([['status', 'read']])
    expect(modelCalls.filter((m) => m.role === 'extractor').length).toBe(2 + 3) // Review B: 2 turns; ATTAIN-2: 3

    const attainCase = byArticle.get(ids.attain)!
    expect(attainCase.state).toBe('end')
    expect(attainCase.values.n?.value).toBe(1613)
    const extract = attainCase.timeline.find((s) => s.stepId === 'extract')!
    const record = await api.call<MwStepRecord>(lead, ch.STEPS_GET, extract.stepRunId)
    const structural = record.journal.filter((j) => j.kind === 'checkpoint' && j.name === 'structural')
    expect(structural).toHaveLength(2)
    const first = structural[0]!.response as { rule: string; passed: boolean }[]
    expect(first.find((c) => c.rule === 'writes.n: the quote is in a source')).toMatchObject({ passed: false })
    expect((structural[1]!.response as { passed: boolean }[]).every((c) => c.passed)).toBe(true)

    const attain = await page(lead, ARTICLE, ids.attain)
    expect(attain.status).toBe('read')
    expect(valueOf(attain, 'n')).toBe(1613)
    expect(valueOf(attain, 'study_type')).toBe('randomised_trial')
    expect(valueOf(attain, 'sponsor')).toBe('Eli Lilly and Company')
    // The paper's viewer lights each value's words up in the abstract.
    const view = attain.texts!.abstract!
    expect(view.text).toBe(ATTAIN_2.abstract)
    const n = view.highlights.find((h) => h.kind === 'value' && h.field === 'n')!
    expect(n).toMatchObject({ found: true })
    expect(ATTAIN_2.abstract.slice(n.start!, n.end!)).toBe(N_QUOTE)

    const review = await page(lead, ARTICLE, ids.reviewB)
    expect(review.status).toBe('read')
    expect(valueOf(review, 'study_type')).toBe('review')
  }, 120_000)

  it('4. the reviewer screens the suggestions in a table: two accepted, one rejected; three screenings, next check in a week', async () => {
    const item = await itemFor(reviewer, 'input', (i) => i.caseId === checkCaseId)
    expect(item.stepTitle).toBe('Screen the new papers')
    expect(item.review).toEqual({ kind: 'table', items: 'screening' })
    const suggested = item.prefill.screening!.value as Record<string, unknown>[]
    expect(suggested.map((r) => [r.article, r.decision])).toEqual([[ids.reviewB, 'include'], [ids.attain, 'include'], [ids.trialA, 'include']])
    // The lead isn't a reviewer: the step isn't theirs.
    expect((await api.call<MwInboxItem[]>(lead, ch.INBOX_LIST)).some((i) => i.kind === 'input' && i.caseId === checkCaseId)).toBe(false)

    const screening = suggested.map((r) => (r.article === ids.reviewB
      ? { ...r, decision: 'exclude', reason: 'A narrative review with no new data; the rules exclude reviews.', confidence: 1 }
      : r))
    expect(await api.call(reviewer, ch.INBOX_SUBMIT, { stepRunId: item.stepRunId, outcome: 'done', values: { screening } })).toMatchObject({ applied: true })
    const done = await ended(checkCaseId, 'the screenings recorded')
    expect(done).toMatchObject({ state: 'end', status: 'done' })
    expect(done.path).toEqual(['status', 'search', 'read_all', 'suggest', 'screen', 'record', 'end'])
    expect(done.timeline.map((s) => s.stepId)).toEqual(['status', 'search', 'suggest', 'screen', 'record'])
    // The screener's suggestion was checked against the step's rules by the verifier, once.
    expect(modelCalls.filter((m) => m.role === 'screener').map((m) => m.turn)).toEqual([0, 1])
    expect(modelCalls.filter((m) => m.role === 'verifier')).toHaveLength(1)

    const { rows } = await pool().query(`select article, decision, year, phase from domain.literature__screening where topic = $1 order by article`, [ids.topic])
    expect(rows.map((r) => [r.article, r.decision, Number(r.year), r.phase]).sort()).toEqual([
      [ids.attain, 'include', 2025, 'phase_3'],
      [ids.reviewB, 'exclude', 2026, 'not_a_trial'],
      [ids.trialA, 'include', 2025, 'phase_3'],
    ].sort())

    const topic = await page(lead, TOPIC, ids.topic)
    expect(topic.kpis).toMatchObject({ included: { value: 2 }, excluded: { value: 1 }, evidence_kept: { value: 0 }, evidence_reviewed: { value: 0 } })
    expect(String(valueOf(topic, 'next_check')).slice(0, 10)).toBe(localDate(new Date(), 7))
    expect(valueOf(topic, 'last_checked')).toBeTruthy()
  }, 120_000)

  let sessionId: string
  it('5. a chat about the topic reads its records and keeps four findings: three quoted, one flagged', async () => {
    ({ sessionId } = await api.call<{ sessionId: string }>(lead, ch.CHAT_OPEN, { anchor: { kind: 'record', entity: TOPIC, id: ids.topic } }))
    // Keeping is always asked: the chat opens in Ask mode, and may keep Evidence.
    expect(sessions.created.find((s) => s.id === sessionId)).toMatchObject({ name: 'About Oral GLP-1s for weight in T2D', permissionMode: 'ask' })
    const context = sessions.contexts.get(sessionId)!
    expect(context.anchor).toEqual({ kind: 'record', entity: TOPIC, id: ids.topic })
    expect(context.keep).toEqual([{ entity: EVIDENCE, name: 'Evidence' }])
    expect(context.block).toContain('Topic "Oral GLP-1s for weight in T2D"')

    // The record tools, as the chat's session calls them (the anchor resolves the person).
    const cb = buildMemwiseRecordToolCallbacks({ sessionId })
    const toolCtx = { sessionId, memwiseRecords: cb } as never
    const body = (r: { content: { type: string; text?: string }[] }) => {
      const text = r.content[0]!.text ?? ''
      expect(text).toContain('<untrusted_record_data>')
      return JSON.parse(text.slice(text.indexOf('<untrusted_record_data>') + 24, text.lastIndexOf('</untrusted_record_data>')))
    }
    const included = body(await handleRecordQuery(toolCtx, { entity: 'Screening', filter: `topic = '${ids.topic}' and decision = 'include'` }))
    expect(included).toMatchObject({ entity: SCREENING, total: 2 })
    expect(included.rows.map((r: { values: { article: string } }) => r.values.article).sort()).toEqual([ids.attain, ids.trialA].sort())
    const paper = body(await handleRecordGet(toolCtx, { entity: 'Article', id: ids.attain }))
    expect(paper.values.find((v: { field: string }) => v.field === 'n')).toMatchObject({ value: 1613 })
    expect(paper.values.find((v: { field: string }) => v.field === 'abstract').value).toBe(ATTAIN_2.abstract)

    // record_keep: the permission prompt that shows these rows is answered "Keep".
    const finding = (dose: string, effect: number, low: number, high: number, quote: string) => ({
      topic: ids.topic, article: ids.attain, population: 'Adults with obesity and type 2 diabetes', intervention: `Orforglipron ${dose}`, comparator: 'Placebo',
      outcome: 'Percent change in bodyweight', timepoint: 'Week 72', effect, ci_low: low, ci_high: high, unit: 'percentage points', p_value: 'p<0·0001', quote,
    })
    const rows = [
      finding('6 mg', -2.7, -3.7, -1.6, 'with 6 mg (estimated treatment difference [ETD] -2·7 [95% CI -3·7 to -1·6]'),
      finding('12 mg', -4.5, -5.5, -3.6, '-7·0% (-7·8 to -6·2) with 12 mg (ETD -4·5 [-5·5 to -3·6]'),
      finding('36 mg', -7.1, -8.2, -6.1, '-9·6% (-10·5 to -8·7) with 36 mg orforglipron (ETD -7·1 [-8·2 to -6·1]'),
      { ...finding('36 mg', -1.8, -2.0, -1.6, MADE_UP_QUOTE), outcome: 'Change in HbA1c' },
    ]
    const kept = JSON.parse((await handleRecordKeep(toolCtx, { entity: 'Evidence', rows })).content[0]!.text as string)
    expect(kept.entity).toBe(EVIDENCE)
    expect(kept.rows.map((r: { quoteFound: boolean }) => r.quoteFound)).toEqual([true, true, true, false])
    expect(kept.rows.every((r: { id?: string }) => !!r.id)).toBe(true)
    expect(kept.summary).toContain('Kept 4 of 4 rows.')
    expect(kept.summary).toContain('1 quote was not found in the source')
    ids.evidence6 = kept.rows[0].id
    ids.madeUp = kept.rows[3].id

    for (const id of kept.rows.slice(0, 3).map((r: { id: string }) => r.id)) {
      const e = await page(lead, EVIDENCE, id)
      expect(e.status).toBe('kept')
      expect(e.flags.filter((f) => !f.closedAt)).toEqual([])
      expect(e.history[0]).toMatchObject({ reason: `kept from chat ${sessionId}`, by: leadId })
    }
    const madeUp = await page(lead, EVIDENCE, ids.madeUp)
    expect(madeUp.status).toBe('kept')
    expect(madeUp.flags.filter((f) => !f.closedAt).map((f) => f.message)).toEqual([expect.stringMatching(/^Quote not found in the source/)])
    expect(await count('literature__evidence', 'topic = $1', [ids.topic])).toBe(4)
  }, 60_000)

  it('6. the reviewer rejects the made-up finding; the topic page and the dashboard chart what is kept', async () => {
    expect(await api.call(reviewer, ch.RECORDS_TRANSITION, { entity: EVIDENCE, id: ids.madeUp, transition: 'reject', reason: 'The quote is not in the abstract.' }))
      .toMatchObject({ applied: true })
    expect(await api.call(reviewer, ch.RECORDS_TRANSITION, { entity: EVIDENCE, id: ids.evidence6, transition: 'review', reason: 'Checked against the abstract.' }))
      .toMatchObject({ applied: true })

    const topic = await page(lead, TOPIC, ids.topic)
    expect(topic.kpis).toMatchObject({ included: { value: 2 }, excluded: { value: 1 }, evidence_kept: { value: 2 }, evidence_reviewed: { value: 1 } })
    expect(topic.charts!['main:1']).toMatchObject({ kind: 'bar', title: 'Included papers by year', total: 2, data: [{ label: '2025', value: 2 }] })
    const interval = topic.charts!['main:2']!
    expect(interval).toMatchObject({ kind: 'interval', title: 'Effect vs comparator', unit: 'percentage points', total: 3 })
    expect(interval.data.map((d) => [d.label, d.value, d.low, d.high]).sort()).toEqual([
      ['Orforglipron 12 mg vs Placebo', -4.5, -5.5, -3.6],
      ['Orforglipron 36 mg vs Placebo', -7.1, -8.2, -6.1],
      ['Orforglipron 6 mg vs Placebo', -2.7, -3.7, -1.6],
    ].sort())

    const dash = await api.call<MwDashboard>(lead, ch.PAGES_DASHBOARD, { domain: 'literature', pageId: 'literature', params: {} })
    const kpis = Object.fromEntries(dash.blocks.flatMap((b) => (b.kind === 'kpi' ? [[b.label, b.value]] : [])))
    expect(kpis).toEqual({ 'Topics watched': 1, 'Papers read': 3, 'Papers included': 2, 'Evidence to review': 2 })
    const charts = dash.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))
    expect(charts.find((c) => c.title === 'Included papers by year')).toMatchObject({ kind: 'bar', total: 2, data: [{ label: '2025', value: 2 }] })
    expect(charts.find((c) => c.title === 'Included papers by trial phase')).toMatchObject({ kind: 'donut', total: 2, data: [{ label: 'phase_3', value: 2 }] })
    expect(charts.find((c) => c.title === 'Effects kept as evidence')).toMatchObject({ kind: 'interval', total: 3 })
  }, 60_000)

  it('7. a week later the check runs again: nothing new, nothing stored or screened twice', async () => {
    const before = { articles: await count('literature__article'), screenings: await count('literature__screening'), reads: (await api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'read-paper' })).length }
    const pubmedCalls = fake.calls.length
    const topicBefore = await page(lead, TOPIC, ids.topic)
    const lastChecked = String(valueOf(topicBefore, 'last_checked'))

    // The sweep a week on: the topic's next_check has come round.
    await svc.kernel.triggers.sweep(new Date(Date.now() + 7 * DAY_MS))
    const checks = await until('the second check', () => api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'check-topic' }), (xs) => xs.length === 2, 30_000)
    const second = checks.find((c) => c.caseId !== checkCaseId)!
    const done = await ended(second.caseId, 'the second check')
    expect(done).toMatchObject({ state: 'end', status: 'done' })
    expect(done.timeline.map((s) => [s.stepId, s.outcome])).toEqual([['status', 'active'], ['search', 'nothing_new'], ['mark_checked', 'done']])
    expect(done.values.found_count?.value).toBe(0)
    // Searched by entry date from the last check, over HTTP.
    const from = localDate(new Date(lastChecked)).replaceAll('-', '/')
    expect(done.values.searched_from?.value).toBe(from)
    expect(fake.calls.slice(pubmedCalls)).toEqual([{ name: 'search_articles', args: { query: GLP1_QUERY, datetype: 'edat', date_from: from, max_results: 50 } }])

    expect(await count('literature__article')).toBe(before.articles)
    expect(await count('literature__screening')).toBe(before.screenings)
    expect((await api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'read-paper' })).length).toBe(before.reads)
    const topic = await page(lead, TOPIC, ids.topic)
    expect(topic.kpis).toMatchObject({ included: { value: 2 }, excluded: { value: 1 } })
    expect(String(valueOf(topic, 'last_checked'))).not.toBe(lastChecked)
    expect(String(valueOf(topic, 'next_check')).slice(0, 10)).toBe(localDate(new Date(), 7))
    // The same sweep again starts nothing new.
    await svc.kernel.triggers.sweep(new Date(Date.now() + 7 * DAY_MS))
    expect(await api.call<any[]>(lead, ch.CASES_LIST, { workflowId: 'check-topic' })).toHaveLength(2)
  }, 120_000)
})
